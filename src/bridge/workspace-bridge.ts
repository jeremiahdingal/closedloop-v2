import path from "node:path";
import { readFile, rm, stat, writeFile, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppDatabase } from "../db/database.ts";
import { loadConfig } from "../config.ts";
import { appendAuditLine } from "./audit.ts";
import { PathPolicy, getCommand } from "./policies.ts";
import { git } from "./git.ts";
import { ensureDir, nowIso, randomId, safeJoin, sha256, sleep, truncate } from "../utils.ts";
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

  async createWorkspace(input: { ticketId: string; runId: string; baseRef?: string; owner: string; targetDir: string }): Promise<WorkspaceRecord> {
    const isGitRepo = await stat(path.join(input.targetDir, ".git")).then(() => true).catch(() => false);
    
    const workspaceId = randomId("ws");
    const branchName = `ticket/${input.ticketId}-${workspaceId.slice(-6)}`;
    const worktreePath = path.join(this.config.workspacesDir, workspaceId);
    await ensureDir(this.config.workspacesDir);

    let baseCommit = "";
    if (isGitRepo) {
      const baseRef = input.baseRef ?? "HEAD";
      baseCommit = await this.resolveBaseCommit(input.targetDir, baseRef);
      await git(input.targetDir, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
    } else {
      await cp(input.targetDir, worktreePath, { recursive: true });
      await git(worktreePath, ["init"]);
      await git(worktreePath, ["add", "-A"]);
      await git(worktreePath, ["commit", "-m", "Initial state --allow-empty"]);
      baseCommit = "initial";
    }

    const workspace = this.db.createWorkspace({
      id: workspaceId,
      ticketId: input.ticketId,
      runId: input.runId,
      repoRoot: input.targetDir,
      worktreePath,
      branchName,
      baseCommit,
      headCommit: null,
      status: "active",
      leaseOwner: input.owner
    });

    await this.logAudit("workspace.log", `created workspace=${workspaceId} ticket=${input.ticketId} path=${worktreePath} target=${input.targetDir}`);
    return workspace;
  }

  private async resolveBaseCommit(targetDir: string, baseRef: string): Promise<string> {
    const attempts = 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const base = await git(targetDir, ["rev-parse", baseRef]);
        const baseCommit = base.stdout.trim();
        if (!baseCommit) {
          throw new Error(`git rev-parse ${baseRef} returned an empty commit`);
        }
        return baseCommit;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await sleep(500);
        }
      }
    }

    const detail = lastError instanceof Error ? lastError.message.trim() : String(lastError);
    throw new Error(`Workspace bootstrap failed: could not resolve ${baseRef} for target repo ${targetDir}. ${detail}`);
  }

  async cleanupWorkspace(workspaceId: string, force = false): Promise<void> {
    const workspace = this.db.getWorkspace(workspaceId);
    if (!workspace) return;
    try {
      await git(workspace.repoRoot, ["worktree", "remove", workspace.worktreePath, ...(force ? ["--force"] : [])]);
    } catch {
      await rm(workspace.worktreePath, { recursive: true, force: true });
    }
    await this.deleteWorkspaceBranch(workspace);
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

  async cleanupArchivedWorkspaces(retentionHours = this.config.workspaceRetentionHours): Promise<WorkspaceRecord[]> {
    const cutoffIso = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();
    const archived = this.db.listArchivedWorkspacesOlderThan(cutoffIso);
    const cleaned: WorkspaceRecord[] = [];

    for (const workspace of archived) {
      await this.removeWorkspaceWorktree(workspace);
      await this.deleteWorkspaceBranch(workspace);
      this.db.updateWorkspace({ workspaceId: workspace.id, status: "cleaned", leaseOwner: null });
      this.db.deleteLease("workspace", workspace.id);
      cleaned.push({ ...workspace, status: "cleaned", leaseOwner: null });
      await this.logAudit("workspace.log", `cleaned workspace=${workspace.id} branch=${workspace.branchName}`);
    }

    return cleaned;
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
    await this.stageTicketChanges(workspace.worktreePath);
    const result = await git(workspace.worktreePath, ["diff", "--staged", "--", "."]);
    return result.stdout.trim();
  }

  async gitPush(input: { workspaceId: string; remote?: string }): Promise<string> {
    const workspace = this.requireWorkspace(input.workspaceId);
    const remote = input.remote ?? "origin";
    await git(workspace.worktreePath, ["push", "-u", remote, workspace.branchName]);
    return `${remote}/${workspace.branchName}`;
  }

  async gitCreatePr(input: { workspaceId: string; title: string; body?: string; base?: string }): Promise<string | null> {
    const workspace = this.requireWorkspace(input.workspaceId);
    const base = input.base ?? "main";
    try {
      const result = await git(workspace.worktreePath, [
        "pr", "create",
        "--title", input.title,
        "--body", input.body ?? "",
        "--base", base
      ]);
      const output = result.stdout.trim();
      if (output.includes("github.com")) {
        return output;
      }
      const prMatch = output.match(/https?:\/\/[^\s]+/);
      return prMatch ? prMatch[0] : null;
    } catch (error) {
      console.warn("Failed to create PR:", error);
      return null;
    }
  }

  async gitRemoteUrl(workspaceId: string): Promise<string | null> {
    const workspace = this.requireWorkspace(workspaceId);
    try {
      const result = await git(workspace.worktreePath, ["remote", "get-url", "origin"]);
      return result.stdout.trim();
    } catch {
      return null;
    }
  }

  async gitStatus(workspaceId: string): Promise<string> {
    const workspace = this.requireWorkspace(workspaceId);
    const result = await git(workspace.worktreePath, ["status", "--short"]);
    return result.stdout.trim();
  }

  async gitCommit(input: { workspaceId: string; message: string }): Promise<string> {
    const workspace = this.requireWorkspace(input.workspaceId);
    await this.stageTicketChanges(workspace.worktreePath);
    try {
      await git(workspace.worktreePath, ["commit", "-m", input.message]);
    } catch (error) {
      return `noop:${(error as Error).message}`;
    }
    const head = await git(workspace.worktreePath, ["rev-parse", "HEAD"]);
    this.db.updateWorkspace({ workspaceId: input.workspaceId, headCommit: head.stdout.trim() });
    return head.stdout.trim();
  }

  async getDiffStats(workspaceId: string): Promise<{ path: string; additions: number; deletions: number }[]> {
    const workspace = this.requireWorkspace(workspaceId);
    await this.stageTicketChanges(workspace.worktreePath);
    const result = await git(workspace.worktreePath, ["diff", "--staged", "--stat", "--", "."]);
    const lines = result.stdout.trim().split("\n").filter(l => l.includes("|"));
    return lines.map(line => {
      const parts = line.split("|");
      const filePath = parts[0].trim();
      const stats = parts[1].trim();
      const addMatch = stats.match(/(\d+)\s+\+/);
      const delMatch = stats.match(/(\d+)\s+-/);
      return {
        path: filePath,
        additions: addMatch ? parseInt(addMatch[1]) : 0,
        deletions: delMatch ? parseInt(delMatch[1]) : 0
      };
    });
  }

  private async stageTicketChanges(worktreePath: string): Promise<void> {
    // Exclude orchestrator bookkeeping from ticket diffs/commits.
    await git(worktreePath, ["add", "-A", "--", ".", ":(exclude).orchestrator/context.json"]);
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
      argv: process.platform === "win32"
        ? ["cmd", "/c", command]
        : ["bash", "-lc", command],
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

  private async removeWorkspaceWorktree(workspace: WorkspaceRecord): Promise<void> {
    try {
      await git(workspace.repoRoot, ["worktree", "remove", "--force", workspace.worktreePath]);
    } catch {
      await rm(workspace.worktreePath, { recursive: true, force: true });
    }
  }

  private async deleteWorkspaceBranch(workspace: WorkspaceRecord): Promise<void> {
    try {
      await git(workspace.repoRoot, ["branch", "-D", workspace.branchName]);
    } catch {
      // Branch may already be gone if the worktree was cleaned manually.
    }
  }

  /**
   * Read a single file from a workspace
   */
  async readFile(workspaceId: string, filePath: string): Promise<string> {
    const workspace = this.requireWorkspace(workspaceId);
    const fullPath = safeJoin(workspace.worktreePath, filePath);
    return readFile(fullPath, "utf8");
  }

  /**
   * Create a temporary worktree from an existing branch (without adding it to the database)
   */
  async createTempWorktreeFromBranch(repoRoot: string, branchName: string): Promise<string> {
    const tempId = randomId("tmp");
    const tempWorktreePath = path.join(this.config.workspacesDir, tempId);
    await ensureDir(this.config.workspacesDir);

    // Create worktree from the existing branch
    await git(repoRoot, ["worktree", "add", tempWorktreePath, branchName]);
    return tempWorktreePath;
  }

  /**
   * Remove a temporary worktree
   */
  async removeTempWorktree(worktreePath: string): Promise<void> {
    try {
      // Remove the worktree
      const repoRoot = path.dirname(worktreePath);
      await git(repoRoot, ["worktree", "remove", worktreePath]);
    } catch (error) {
      // If removal fails, try rm -rf as fallback
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // Ignore errors
      }
    }
  }

  /**
   * Commit and push changes from a worktree path (used for temp worktrees)
   */
  async commitAndPushFromPath(worktreePath: string, branchName: string, message: string): Promise<string> {
    // Stage all changes
    await git(worktreePath, ["add", "-A"]);

    // Commit
    try {
      await git(worktreePath, ["commit", "-m", message]);
    } catch (error) {
      // If nothing to commit, just get the current HEAD
      const head = await git(worktreePath, ["rev-parse", "HEAD"]);
      return head.stdout.trim();
    }

    // Push
    await git(worktreePath, ["push", "-u", "origin", branchName]);

    // Return commit SHA
    const head = await git(worktreePath, ["rev-parse", "HEAD"]);
    return head.stdout.trim();
  }

  /**
   * Ensure a directory exists (thin wrapper around utils ensureDir for consistency)
   */
  async ensureDirectory(dirPath: string): Promise<void> {
    await ensureDir(dirPath);
  }
}
