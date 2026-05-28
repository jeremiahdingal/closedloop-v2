import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, initGitRepo } from "./helpers.ts";
import { getEpicMergeStatus, mergeEpicToMain } from "../src/apps/epic-merge.ts";
import type { EpicRecord } from "../src/types.ts";

const execFileAsync = promisify(execFile);

async function commitAll(cwd: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "-m", message], { cwd });
}

function epicFor(repoRoot: string, branch: string): EpicRecord {
  return {
    id: "epic_merge_test",
    title: "Merge test epic",
    goalText: "Merge to main",
    targetDir: repoRoot,
    targetBranch: branch,
    status: "done",
    pausedFromStatus: null,
    scheduledDate: null,
    assetPaths: [],
    createdAt: "",
    updatedAt: "",
  };
}

test("epic merge status is ready when done and conflict-free", async () => {
  const repoRoot = await makeTempDir("repo-");
  await initGitRepo(repoRoot);
  await execFileAsync("git", ["branch", "-m", "main"], { cwd: repoRoot });
  await execFileAsync("git", ["checkout", "-b", "feature/epic-merge"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "feature.txt"), "feature work\n", "utf8");
  await commitAll(repoRoot, "feature work");
  await execFileAsync("git", ["checkout", "main"], { cwd: repoRoot });

  const status = await getEpicMergeStatus(epicFor(repoRoot, "feature/epic-merge"));

  assert.equal(status.canMerge, true);
  assert.equal(status.conflicts, false);
  assert.equal(status.reason, null);
});

test("mergeEpicToMain merges branch into main and restores previous branch", async () => {
  const repoRoot = await makeTempDir("repo-");
  await initGitRepo(repoRoot);
  await execFileAsync("git", ["branch", "-m", "main"], { cwd: repoRoot });
  await execFileAsync("git", ["checkout", "-b", "feature/epic-merge"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "feature.txt"), "feature work\n", "utf8");
  await commitAll(repoRoot, "feature work");

  const result = await mergeEpicToMain(epicFor(repoRoot, "feature/epic-merge"));
  const currentBranch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot })).stdout.trim();
  const mainContainsFeature = await execFileAsync(
    "git",
    ["merge-base", "--is-ancestor", "feature/epic-merge", "main"],
    { cwd: repoRoot }
  ).then(() => true, () => false);

  assert.equal(result.sourceBranch, "feature/epic-merge");
  assert.equal(result.targetBranch, "main");
  assert.equal(result.previousBranch, "feature/epic-merge");
  assert.match(result.mergedCommit, /^[0-9a-f]{40}$/);
  assert.equal(currentBranch, "feature/epic-merge");
  assert.equal(mainContainsFeature, true);
});
