import type { EpicRecord } from "../types.ts";
import { git } from "../bridge/git.ts";

export type EpicMergeStatus = {
  epicId: string;
  sourceBranch: string | null;
  targetBranch: "main";
  canMerge: boolean;
  conflicts: boolean;
  workingTreeClean: boolean;
  alreadyMerged: boolean;
  reason:
    | "epic_not_done"
    | "missing_source_branch"
    | "missing_main_branch"
    | "dirty_worktree"
    | "already_merged"
    | "merge_conflicts"
    | "git_error"
    | null;
  message: string;
};

export type EpicMergeResult = {
  epicId: string;
  sourceBranch: string;
  targetBranch: "main";
  previousBranch: string;
  mergedCommit: string;
};

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export async function getEpicMergeStatus(epic: EpicRecord): Promise<EpicMergeStatus> {
  const sourceBranch = epic.targetBranch;
  const targetBranch = "main" as const;

  if (epic.status !== "done") {
    return {
      epicId: epic.id,
      sourceBranch,
      targetBranch,
      canMerge: false,
      conflicts: false,
      workingTreeClean: false,
      alreadyMerged: false,
      reason: "epic_not_done",
      message: "Epic must be done before it can be merged to main.",
    };
  }

  if (!sourceBranch) {
    return {
      epicId: epic.id,
      sourceBranch: null,
      targetBranch,
      canMerge: false,
      conflicts: false,
      workingTreeClean: false,
      alreadyMerged: false,
      reason: "missing_source_branch",
      message: "Epic has no target branch to merge from.",
    };
  }

  if (!(await branchExists(epic.targetDir, sourceBranch))) {
    return {
      epicId: epic.id,
      sourceBranch,
      targetBranch,
      canMerge: false,
      conflicts: false,
      workingTreeClean: false,
      alreadyMerged: false,
      reason: "missing_source_branch",
      message: `Source branch '${sourceBranch}' does not exist locally.`,
    };
  }

  if (!(await branchExists(epic.targetDir, targetBranch))) {
    return {
      epicId: epic.id,
      sourceBranch,
      targetBranch,
      canMerge: false,
      conflicts: false,
      workingTreeClean: false,
      alreadyMerged: false,
      reason: "missing_main_branch",
      message: "Local 'main' branch does not exist.",
    };
  }

  const status = await git(epic.targetDir, ["status", "--porcelain"]);
  const workingTreeClean = status.stdout.trim().length === 0;
  if (!workingTreeClean) {
    return {
      epicId: epic.id,
      sourceBranch,
      targetBranch,
      canMerge: false,
      conflicts: false,
      workingTreeClean,
      alreadyMerged: false,
      reason: "dirty_worktree",
      message: "Repository has uncommitted changes. Clean the worktree before merging to main.",
    };
  }

  const alreadyMerged = await isAncestor(epic.targetDir, sourceBranch, targetBranch);
  if (alreadyMerged) {
    return {
      epicId: epic.id,
      sourceBranch,
      targetBranch,
      canMerge: false,
      conflicts: false,
      workingTreeClean,
      alreadyMerged: true,
      reason: "already_merged",
      message: `Branch '${sourceBranch}' is already merged into main.`,
    };
  }

  try {
    await git(epic.targetDir, ["merge-tree", "--write-tree", "--quiet", targetBranch, sourceBranch]);
    return {
      epicId: epic.id,
      sourceBranch,
      targetBranch,
      canMerge: true,
      conflicts: false,
      workingTreeClean,
      alreadyMerged: false,
      reason: null,
      message: `Ready to merge '${sourceBranch}' into main.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      epicId: epic.id,
      sourceBranch,
      targetBranch,
      canMerge: false,
      conflicts: true,
      workingTreeClean,
      alreadyMerged: false,
      reason: "merge_conflicts",
      message: `Merge conflicts detected between '${sourceBranch}' and main. ${message}`.trim(),
    };
  }
}

export async function mergeEpicToMain(epic: EpicRecord): Promise<EpicMergeResult> {
  const status = await getEpicMergeStatus(epic);
  if (!status.canMerge || !status.sourceBranch) {
    throw new Error(status.message);
  }

  const previousBranch = (await git(epic.targetDir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "main";

  try {
    if (previousBranch !== status.targetBranch) {
      await git(epic.targetDir, ["checkout", status.targetBranch]);
    }
    await git(epic.targetDir, ["merge", "--no-ff", "--no-edit", status.sourceBranch]);
    const mergedCommit = (await git(epic.targetDir, ["rev-parse", "HEAD"])).stdout.trim();
    return {
      epicId: epic.id,
      sourceBranch: status.sourceBranch,
      targetBranch: status.targetBranch,
      previousBranch,
      mergedCommit,
    };
  } catch (error) {
    await git(epic.targetDir, ["merge", "--abort"]).catch(() => undefined);
    throw error;
  } finally {
    if (previousBranch && previousBranch !== status.targetBranch) {
      await git(epic.targetDir, ["checkout", previousBranch]).catch(() => undefined);
    }
  }
}
