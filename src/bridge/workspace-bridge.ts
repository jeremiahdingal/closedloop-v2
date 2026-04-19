import path from "node:path";
import { readFile, rm, stat, writeFile, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppDatabase } from "../db/database.ts";
import { loadConfig } from "../config.ts";
import { appendAuditLine } from "./audit.ts";
import { PathPolicy, getCommand } from "./policies.ts";
import { git } from "./git.ts";
import { gh } from "./gh.ts";
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
  private readonly protectedBranches = new Set(["main", "master"]);

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

  async createWorkspace(input: { ticketId: string; runId: string; baseRef?: string; owner: string; targetDir: string; useTargetBranch?: boolean }): Promise<WorkspaceRecord> {
    const isGitRepo = await stat(path.join(input.targetDir, ".git")).then(() => true).catch(() => false);
    
    const workspaceId = randomId("ws");
    const useTargetBranch = input.useTargetBranch ?? false;
    const branchName = useTargetBranch ? input.baseRef ?? "HEAD" : `ticket/${input.ticketId}-${workspaceId.slice(-6)}`;
    const worktreePath = path.join(this.config.workspacesDir, workspaceId);
    await ensureDir(this.config.workspacesDir);

    let baseCommit = "";
    if (isGitRepo) {
      const baseRef = input.baseRef ?? "HEAD";
      try {
        baseCommit = await this.resolveBaseCommit(input.targetDir, baseRef);
      } catch (resolveError) {
        const errMsg = resolveError instanceof Error ? resolveError.message : String(resolveError);
        if (baseRef !== "HEAD" && (errMsg.includes("could not resolve") || errMsg.includes("fatal: ambiguous"))) {
          console.warn(`Branch '${baseRef}' not found, attempting to create from origin/${baseRef} or main`);
          try {
            await git(input.targetDir, ["fetch", "origin", baseRef]).catch(() => {});
            baseCommit = await this.resolveBaseCommit(input.targetDir, `origin/${baseRef}`);
          } catch {
            try {
              baseCommit = await this.resolveBaseCommit(input.targetDir, "origin/main");
            } catch {
              console.warn(`Could not resolve origin/main either, falling back to HEAD`);
              baseCommit = await this.resolveBaseCommit(input.targetDir, "HEAD");
            }
          }
        } else {
          throw resolveError;
        }
      }
      if (useTargetBranch) {
        if (baseRef !== "HEAD" && baseRef) {
          try {
            await git(input.targetDir, ["worktree", "add", "-B", branchName, worktreePath, baseCommit]);
          } catch (worktreeError) {
            console.warn(`Could not create branch worktree for ${branchName}: ${worktreeError}. Falling back to detached HEAD.`);
            await git(input.targetDir, ["worktree", "add", worktreePath, baseCommit]);
          }
        } else {
          await git(input.targetDir, ["worktree", "add", worktreePath, baseCommit]);
        }
      } else {
        await git(input.targetDir, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
      }
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
    const policy = this.policyFor(workspace, []);
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
    const policy = this.policyFor(workspace, []);
    const output: Record<string, string> = {};
    for (const file of files) {
      policy.assertAllowed(file);
      output[file] = await readFile(safeJoin(workspace.worktreePath, file), "utf8");
    }
    return output;
  }

  async mergeTicketBranchIntoEpic(workspaceId: string, ticketBranch: string): Promise<void> {
    const workspace = this.requireWorkspace(workspaceId);
    
    // 1. Fetch latest from origin to ensure we can see the ticket branch
    await git(workspace.worktreePath, ["fetch", "origin", ticketBranch]);
    
    // 2. Merge the ticket branch into current HEAD
    try {
      await git(workspace.worktreePath, ["merge", "--no-edit", `origin/${ticketBranch}`]);
    } catch (error) {
      const errText = error instanceof Error ? error.message : String(error);
      if (errText.includes("conflict")) {
        await git(workspace.worktreePath, ["merge", "--abort"]).catch(() => undefined);
        throw new Error(`Merge conflict while merging ${ticketBranch} into epic branch: ${errText}`);
      }
      throw error;
    }
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
    this.assertAutomationPushAllowed(workspace.branchName, "gitPush");
    await git(workspace.worktreePath, ["push", "-u", remote, workspace.branchName]);
    return `${remote}/${workspace.branchName}`;
  }

  async gitPushToBranch(input: { workspaceId: string; targetBranch: string; remote?: string }): Promise<string> {
    const workspace = this.requireWorkspace(input.workspaceId);
    const remote = input.remote ?? "origin";
    this.assertAutomationPushAllowed(input.targetBranch, "gitPushToBranch");
    const pushArgs = ["push", remote, `HEAD:refs/heads/${input.targetBranch}`];
    try {
      await git(workspace.worktreePath, pushArgs);
    } catch (error) {
      const errText = error instanceof Error ? error.message : String(error);
      const isNonFastForward = /non-fast-forward|fetch first|rejected/i.test(errText);
      if (!isNonFastForward) {
        throw error;
      }

      try {
        await git(workspace.worktreePath, ["fetch", remote, input.targetBranch]);
        await git(workspace.worktreePath, ["rebase", `${remote}/${input.targetBranch}`]);
      } catch (rebaseError) {
        await git(workspace.worktreePath, ["rebase", "--abort"]).catch(() => undefined);
        const rebaseText = rebaseError instanceof Error ? rebaseError.message : String(rebaseError);
        throw new Error(
          `Push to '${input.targetBranch}' was non-fast-forward and automatic rebase failed: ${rebaseText}`
        );
      }

      await git(workspace.worktreePath, pushArgs);
    }
    return `${remote}/${input.targetBranch}`;
  }

  async gitCreatePr(input: { workspaceId: string; title: string; body?: string; base?: string }): Promise<string | null> {
    const workspace = this.requireWorkspace(input.workspaceId);
    const base = input.base ?? "main";
    try {
      const result = await gh(workspace.worktreePath, [
        "pr", "create",
        "--title", input.title,
        "--body", input.body ?? "",
        "--base", base,
        "--head", workspace.branchName
      ]);
      const output = result.stdout.trim();
      if (output.includes("github.com") || output.includes("pull/")) {
        const match = output.match(/pull\/\d+/);
        if (match) return `https://github.com/${match[0]}`;
        return output;
      }
      if (output.includes("already exists")) {
        const existingMatch = output.match(/pull\/(\d+)/);
        if (existingMatch) return `https://github.com/pull/${existingMatch[1]}`;
      }
      return null;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes("already exists")) {
        const match = errMsg.match(/pull\/(\d+)/);
        if (match) return `https://github.com/pull/${match[1]}`;
      }
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
    const result = await git(workspace.worktreePath, ["diff", "--staged", "--numstat", "--", "."]);
    return result.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        const additions = Number.parseInt(parts[0] ?? "", 10);
        const deletions = Number.parseInt(parts[1] ?? "", 10);
        return {
          path: parts.slice(2).join("\t"),
          additions: Number.isFinite(additions) ? additions : 0,
          deletions: Number.isFinite(deletions) ? deletions : 0
        };
      })
      .filter((row) => row.path.length > 0);
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
  async createTempWorktreeFromBranch(repoRoot: string, branchName: string, fallbackRef?: string | null): Promise<string> {
    const tempId = randomId("tmp");
    const tempWorktreePath = path.join(this.config.workspacesDir, tempId);
    await ensureDir(this.config.workspacesDir);

    // Use detached HEAD pointing at the branch tip — avoids "already in use" error
    // when the branch is currently checked out in another active worktree.
    const candidateRefs = [
      branchName,
      `origin/${branchName}`,
      `refs/remotes/origin/${branchName}`,
      fallbackRef ?? ""
    ]
      .map((value) => value.trim())
      .filter(Boolean);

    let resolvedRef: string | null = null;
    for (const candidate of candidateRefs) {
      try {
        const parsed = await git(repoRoot, ["rev-parse", "--verify", `${candidate}^{commit}`]);
        const commit = parsed.stdout.trim();
        if (commit) {
          resolvedRef = commit;
          break;
        }
      } catch {
        // Try next ref candidate.
      }
    }

    if (!resolvedRef) {
      throw new Error(
        `Cannot resolve branch '${branchName}' for temp worktree (tried local, origin, remote ref${fallbackRef ? ", and fallback commit" : ""}).`
      );
    }

    await git(repoRoot, ["worktree", "add", "--detach", tempWorktreePath, resolvedRef]);
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
    this.assertAutomationPushAllowed(branchName, "commitAndPushFromPath");
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

    const pushArgs = ["push", "-u", "origin", `HEAD:refs/heads/${branchName}`];
    try {
      // Push detached HEAD explicitly to the target branch name.
      await git(worktreePath, pushArgs);
    } catch (error) {
      const errText = error instanceof Error ? error.message : String(error);
      const isNonFastForward = /non-fast-forward|fetch first|rejected/i.test(errText);
      if (!isNonFastForward) {
        throw error;
      }

      // Another process likely updated the same remote branch.
      // Rebase our commit on top of latest remote branch and retry once.
      try {
        await git(worktreePath, ["fetch", "origin", branchName]);
        await git(worktreePath, ["rebase", `origin/${branchName}`]);
      } catch (rebaseError) {
        // Best effort cleanup before surfacing a clearer failure.
        await git(worktreePath, ["rebase", "--abort"]).catch(() => undefined);
        const rebaseText = rebaseError instanceof Error ? rebaseError.message : String(rebaseError);
        throw new Error(
          `Push to '${branchName}' was non-fast-forward and automatic rebase failed: ${rebaseText}`
        );
      }

      await git(worktreePath, pushArgs);
    }

    // Return commit SHA
    const head = await git(worktreePath, ["rev-parse", "HEAD"]);
    return head.stdout.trim();
  }

  private assertAutomationPushAllowed(branchName: string, operation: string): void {
    const normalized = String(branchName || "").trim().replace(/^refs\/heads\//, "");
    const allowProtected = process.env.ALLOW_AUTOMATION_PUSH_TO_PROTECTED_BRANCH === "1";
    if (!allowProtected && this.protectedBranches.has(normalized)) {
      throw new Error(
        `[${operation}] Refusing automated push to protected branch '${normalized}'. ` +
        `Push to a feature/target branch and merge manually. ` +
        `Set ALLOW_AUTOMATION_PUSH_TO_PROTECTED_BRANCH=1 to override.`
      );
    }
  }

  /**
   * Ensure a directory exists (thin wrapper around utils ensureDir for consistency)
   */
  async ensureDirectory(dirPath: string): Promise<void> {
    await ensureDir(dirPath);
  }
}
