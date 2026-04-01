import path from "node:path";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppDatabase } from "../db/database.ts";
import { loadConfig } from "../config.ts";
import { appendAuditLine } from "./audit.ts";
import { PathPolicy, getCommand } from "./policies.ts";
import { git } from "./git.ts";
import { ensureDir, nowIso, randomId, safeJoin, sha256, truncate } from "../utils.ts";
import type {
  CommandName,
  TicketContextPacket,
  ToolInvocationResult,
  WorkspaceRecord,
  WriteFileInput
} from "../types.ts";
import { writeContextPacket } from "./context.ts";

const execFileAsync = promisify(execFile);

export class WorkspaceBridge {
  readonly config = loadConfig();
  readonly auditDir = path.join(this.config.dataDir, "audit");
  private readonly db: AppDatabase;

  constructor(db: AppDatabase) {
    this.db = db;
  }

  private logAudit(fileName: string, line: string): Promise<void> {
    return appendAuditLine(this.auditDir, fileName, line);
  }

  async assertGitRepo(repoRoot: string): Promise<void> {
    const gitDir = path.join(repoRoot, ".git");
    await stat(gitDir);
  }

  async createWorkspace(input: { ticketId: string; runId: string; baseRef?: string; owner: string }): Promise<WorkspaceRecord> {
    await this.assertGitRepo(this.config.repoRoot);

    const workspaceId = randomId("ws");
    const branchName = `ticket/${input.ticketId}-${workspaceId.slice(-6)}`;
    const worktreePath = path.join(this.config.workspacesDir, workspaceId);
    await ensureDir(this.config.workspacesDir);

    const baseRef = input.baseRef ?? "HEAD";
    const base = await git(this.config.repoRoot, ["rev-parse", baseRef]);
    const baseCommit = base.stdout.trim();

    await git(this.config.repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
    const workspace = this.db.createWorkspace({
      id: workspaceId,
      ticketId: input.ticketId,
      runId: input.runId,
      repoRoot: this.config.repoRoot,
      worktreePath,
      branchName,
      baseCommit,
      headCommit: null,
      status: "active",
      leaseOwner: input.owner
    });

    await this.logAudit("workspace.log", `created workspace=${workspaceId} ticket=${input.ticketId} path=${worktreePath}`);
    return workspace;
  }

  async cleanupWorkspace(workspaceId: string, force = false): Promise<void> {
    const workspace = this.db.getWorkspace(workspaceId);
    if (!workspace) return;
    try {
      await git(this.config.repoRoot, ["worktree", "remove", workspace.worktreePath, ...(force ? ["--force"] : [])]);
    } catch {
      await rm(workspace.worktreePath, { recursive: true, force: true });
    }
    this.db.updateWorkspace({ workspaceId, status: "cleaned", leaseOwner: null });
    this.db.deleteLease("workspace", workspaceId);
    await this.logAudit("workspace.log", `cleaned workspace=${workspaceId}`);
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.db.getWorkspace(workspaceId);
    if (!workspace) return;
    const head = await git(workspace.worktreePath, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "", stderr: "" }));
    this.db.updateWorkspace({
      workspaceId,
      headCommit: head.stdout.trim() || workspace.headCommit,
      status: "archived",
      leaseOwner: null
    });
    this.db.deleteLease("workspace", workspaceId);
    await this.logAudit("workspace.log", `archived workspace=${workspaceId} head=${head.stdout.trim()}`);
  }

  policyFor(workspace: WorkspaceRecord, allowedPaths: string[]): PathPolicy {
    return new PathPolicy(workspace.worktreePath, allowedPaths);
  }

  async acquireWorkspaceLease(workspaceId: string, owner: string): Promise<void> {
    const existing = this.db.getLease("workspace", workspaceId);
    const now = Date.now();
    if (existing && new Date(existing.expiresAt).getTime() > now && existing.owner !== owner) {
      throw new Error(`Workspace ${workspaceId} is leased by ${existing.owner}`);
    }
    this.db.upsertLease({
      resourceType: "workspace",
      resourceId: workspaceId,
      owner,
      heartbeatAt: nowIso(),
      expiresAt: new Date(now + this.config.leaseTtlMs).toISOString()
    });
    this.db.updateWorkspace({ workspaceId, leaseOwner: owner });
  }

  heartbeatLease(resourceType: string, resourceId: string, owner: string): void {
    const now = Date.now();
    this.db.upsertLease({
      resourceType,
      resourceId,
      owner,
      heartbeatAt: nowIso(),
      expiresAt: new Date(now + this.config.leaseTtlMs).toISOString()
    });
  }

  releaseLease(resourceType: string, resourceId: string): void {
    this.db.deleteLease(resourceType, resourceId);
  }

  async writeFiles(input: {
    workspaceId: string;
    runId: string;
    ticketId: string;
    nodeName: string;
    allowedPaths: string[];
    files: WriteFileInput[];
  }): Promise<string[]> {
    const workspace = this.requireWorkspace(input.workspaceId);
    const policy = this.policyFor(workspace, input.allowedPaths);
    policy.assertAllowedWrites(input.files);

    const changed: string[] = [];
    for (const file of input.files) {
      const fullPath = safeJoin(workspace.worktreePath, file.path);
      await ensureDir(path.dirname(fullPath));
      await writeFile(fullPath, file.content, "utf8");
      changed.push(file.path);
    }

    this.db.recordEvent({
      aggregateType: "ticket",
      aggregateId: input.ticketId,
      runId: input.runId,
      ticketId: input.ticketId,
      kind: "write_files",
      message: `Wrote ${input.files.length} file(s).`,
      payload: { files: changed }
    });
    return changed;
  }

  async readFiles(workspaceId: string, allowedPaths: string[], files: string[]): Promise<Record<string, string>> {
    const workspace = this.requireWorkspace(workspaceId);
    const policy = this.policyFor(workspace, allowedPaths);
    const output: Record<string, string> = {};
    for (const file of files) {
      policy.assertAllowed(file);
      output[file] = await readFile(safeJoin(workspace.worktreePath, file), "utf8");
    }
    return output;
  }

  async gitDiff(workspaceId: string): Promise<string> {
    const workspace = this.requireWorkspace(workspaceId);
    const result = await git(workspace.worktreePath, ["diff", "--", "."]);
    return result.stdout.trim();
  }

  async gitStatus(workspaceId: string): Promise<string> {
    const workspace = this.requireWorkspace(workspaceId);
    const result = await git(workspace.worktreePath, ["status", "--short"]);
    return result.stdout.trim();
  }

  async gitCommit(input: { workspaceId: string; message: string }): Promise<string> {
    const workspace = this.requireWorkspace(input.workspaceId);
    await git(workspace.worktreePath, ["add", "-A"]);
    try {
      await git(workspace.worktreePath, ["commit", "-m", input.message]);
    } catch (error) {
      return `noop:${(error as Error).message}`;
    }
    const head = await git(workspace.worktreePath, ["rev-parse", "HEAD"]);
    this.db.updateWorkspace({ workspaceId: input.workspaceId, headCommit: head.stdout.trim() });
    return head.stdout.trim();
  }

  async saveArtifact(input: {
    runId?: string | null;
    ticketId?: string | null;
    kind: string;
    name: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const dir = path.join(this.config.artifactsDir, input.runId ?? "shared");
    await ensureDir(dir);
    const filePath = path.join(dir, input.name);
    await writeFile(filePath, input.content, "utf8");
    this.db.addArtifact({
      runId: input.runId ?? null,
      ticketId: input.ticketId ?? null,
      kind: input.kind,
      name: input.name,
      path: filePath,
      checksum: sha256(input.content),
      bytes: Buffer.byteLength(input.content),
      metadata: input.metadata as any
    });
    return filePath;
  }

  async saveContextPacket(packet: TicketContextPacket): Promise<string> {
    const workspace = this.requireWorkspace(packet.workspaceId);
    const filePath = await writeContextPacket(workspace.worktreePath, packet);
    await this.db.addArtifact({
      runId: packet.runId,
      ticketId: packet.ticketId,
      kind: "context",
      name: `${packet.ticketId}-context.json`,
      path: filePath,
      checksum: sha256(JSON.stringify(packet)),
      bytes: Buffer.byteLength(JSON.stringify(packet)),
      metadata: { branchName: packet.branchName }
    });
    return filePath;
  }

  async runNamedCommand(input: {
    workspaceId: string;
    runId: string;
    ticketId: string;
    nodeName: string;
    commandName: CommandName;
    timeoutMs?: number;
  }): Promise<ToolInvocationResult> {
    const workspace = this.requireWorkspace(input.workspaceId);
    const command = getCommand(this.config.commandCatalog, input.commandName);
    const result = await this.execWithAudit({
      cwd: workspace.worktreePath,
      nodeName: input.nodeName,
      runId: input.runId,
      ticketId: input.ticketId,
      toolName: `command:${input.commandName}`,
      argv: ["bash", "-lc", command],
      timeoutMs: input.timeoutMs ?? 180_000,
      inputJson: { commandName: input.commandName, command }
    });
    return result;
  }

  async execWithAudit(input: {
    cwd: string;
    nodeName: string;
    runId: string;
    ticketId: string;
    toolName: string;
    argv: [string, ...string[]];
    timeoutMs: number;
    inputJson: Record<string, unknown>;
  }): Promise<ToolInvocationResult> {
    const [file, ...args] = input.argv;
    const started = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(file, args, {
        cwd: input.cwd,
        timeout: input.timeoutMs,
        maxBuffer: 20 * 1024 * 1024
      });
      const durationMs = Date.now() - started;
      const stdoutText = truncate(String(stdout));
      const stderrText = truncate(String(stderr));
      const stdoutPath = await this.saveArtifact({ runId: input.runId, ticketId: input.ticketId, kind: "stdout", name: `${input.toolName.replace(/[:/]/g, "_")}.stdout.log`, content: stdoutText });
      const stderrPath = await this.saveArtifact({ runId: input.runId, ticketId: input.ticketId, kind: "stderr", name: `${input.toolName.replace(/[:/]/g, "_")}.stderr.log`, content: stderrText });
      this.db.addToolInvocation({
        runId: input.runId,
        ticketId: input.ticketId,
        nodeName: input.nodeName,
        toolName: input.toolName,
        input: input.inputJson as any,
        exitCode: 0,
        durationMs,
        stdoutPath,
        stderrPath
      });
      return { exitCode: 0, stdout: stdoutText, stderr: stderrText, durationMs };
    } catch (error) {
      const e = error as Error & { code?: number; stdout?: string; stderr?: string };
      const durationMs = Date.now() - started;
      const stdoutText = truncate(String(e.stdout ?? ""));
      const stderrText = truncate(String(e.stderr ?? e.message));
      const stdoutPath = await this.saveArtifact({ runId: input.runId, ticketId: input.ticketId, kind: "stdout", name: `${input.toolName.replace(/[:/]/g, "_")}.stdout.log`, content: stdoutText });
      const stderrPath = await this.saveArtifact({ runId: input.runId, ticketId: input.ticketId, kind: "stderr", name: `${input.toolName.replace(/[:/]/g, "_")}.stderr.log`, content: stderrText });
      this.db.addToolInvocation({
        runId: input.runId,
        ticketId: input.ticketId,
        nodeName: input.nodeName,
        toolName: input.toolName,
        input: input.inputJson as any,
        exitCode: e.code ?? 1,
        durationMs,
        stdoutPath,
        stderrPath
      });
      return { exitCode: e.code ?? 1, stdout: stdoutText, stderr: stderrText, durationMs };
    }
  }

  requireWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.db.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }
}
