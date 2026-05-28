import { bootstrap } from "./bootstrap.ts";
import { git } from "../bridge/git.ts";
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

  // --all mode: clean ALL workspaces from the database + delete stale ticket branches
  const allWorkspaces = db.listWorkspacesForTicket("%"); // won't work with %, use a different approach
  // Get all non-cleaned workspaces by listing all then filtering
  const cleaned: Array<{ id: string; branchName: string; worktreePath: string }> = [];

  // Clean archived workspaces first (any age)
  const archived = await bridge.cleanupArchivedWorkspaces(0);
  for (const ws of archived) {
    cleaned.push({ id: ws.id, branchName: ws.branchName, worktreePath: ws.worktreePath });
  }

  // Clean orphaned active workspaces (any age)
  const orphaned = await bridge.cleanupOrphanedWorkspaces(0);
  for (const ws of orphaned) {
    cleaned.push({ id: ws.id, branchName: ws.branchName, worktreePath: ws.worktreePath });
  }

  // Also clean ticket/* branches from repos that appear in workspace records
  const repoRoots = new Set<string>();
  for (const ws of [...archived, ...orphaned]) {
    repoRoots.add(ws.repoRoot);
  }
  // Add the config repoRoot too
  repoRoots.add(config.repoRoot);

  for (const repoRoot of repoRoots) {
    try {
      const branchList = await git(repoRoot, ["branch", "--list", "ticket/*"]);
      const ticketBranches = branchList.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^\*\s+/, "").replace(/^\+\s+/, ""))
        .filter(Boolean);
      for (const branchName of ticketBranches) {
        try {
          await git(repoRoot, ["branch", "-D", branchName]);
        } catch {
          // Ignore already-deleted or protected branches.
        }
      }
    } catch {
      // Repo may not be accessible
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

  db.close();
}

void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
