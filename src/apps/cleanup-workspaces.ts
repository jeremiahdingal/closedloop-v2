import { bootstrap } from "./bootstrap.ts";
import { git } from "../bridge/git.ts";
import { rm } from "node:fs/promises";
import path from "node:path";

function parseRetentionHours(argv: string[]): number | null {
  const flag = argv.find((arg) => arg.startsWith("--retention-hours="));
  if (flag) {
    const value = Number(flag.split("=", 2)[1]);
    return Number.isFinite(value) ? value : null;
  }

  const index = argv.indexOf("--retention-hours");
  if (index >= 0 && argv[index + 1]) {
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

function parseWorktreeList(stdout: string): Array<{ path: string; branch: string | null }> {
  const lines = stdout.split(/\r?\n/);
  const worktrees: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length).trim(), branch: null };
      continue;
    }
    if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      continue;
    }
  }

  if (current) worktrees.push(current);
  return worktrees;
}

async function main() {
  const argv = process.argv.slice(2);
  const purgeAll = argv.includes("--all");
  const retentionHours = parseRetentionHours(argv);

  const { bridge, db, config } = await bootstrap({ dryRun: true });
  if (!purgeAll) {
    const cleaned = await bridge.cleanupArchivedWorkspaces(retentionHours ?? config.workspaceRetentionHours);

    console.log(JSON.stringify({
      cleaned: cleaned.length,
      retentionHours: retentionHours ?? config.workspaceRetentionHours,
      workspaces: cleaned.map((workspace) => ({
        id: workspace.id,
        branchName: workspace.branchName,
        worktreePath: workspace.worktreePath
      }))
    }, null, 2));

    db.close();
    return;
  }

  const worktreeRoot = path.resolve(config.workspacesDir);
  const list = await git(config.repoRoot, ["worktree", "list", "--porcelain"]);
  const worktrees = parseWorktreeList(list.stdout).filter((entry) => {
    const resolvedPath = path.resolve(entry.path);
    return resolvedPath !== path.resolve(config.repoRoot) && resolvedPath.startsWith(worktreeRoot + path.sep);
  });

  const cleaned: Array<{ id: string; branchName: string; worktreePath: string }> = [];
  for (const worktree of worktrees) {
    const resolvedPath = path.resolve(worktree.path);
    const workspace = db.findWorkspaceByWorktreePath(resolvedPath);
    try {
      await git(config.repoRoot, ["worktree", "remove", "--force", resolvedPath]);
    } catch {
      await rm(resolvedPath, { recursive: true, force: true });
    }
    if (worktree.branch) {
      try {
        await git(config.repoRoot, ["branch", "-D", worktree.branch]);
      } catch {
        // Ignore and continue.
      }
    }
    if (workspace) {
      db.updateWorkspace({ workspaceId: workspace.id, status: "cleaned", leaseOwner: null });
      db.deleteLease("workspace", workspace.id);
      cleaned.push({ id: workspace.id, branchName: workspace.branchName, worktreePath: workspace.worktreePath });
    } else if (worktree.branch) {
      cleaned.push({ id: resolvedPath, branchName: worktree.branch, worktreePath: resolvedPath });
    }
  }

  const branchList = await git(config.repoRoot, ["branch", "--list", "ticket/*"]);
  const ticketBranches = branchList.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s+/, "").replace(/^\+\s+/, ""))
    .filter(Boolean);
  for (const branchName of ticketBranches) {
    try {
      await git(config.repoRoot, ["branch", "-D", branchName]);
    } catch {
      // Ignore already-deleted or protected branches.
    }
  }

  console.log(JSON.stringify({
    cleaned: cleaned.length,
    retentionHours: 0,
    workspaces: cleaned.map((workspace) => ({
      id: workspace.id,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath
    }))
  }, null, 2));

  try {
    await git(config.repoRoot, ["worktree", "prune", "--expire", "now"]);
  } catch {
    // Ignore prune failures; individual removals already ran.
  }

  db.close();
}

void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
