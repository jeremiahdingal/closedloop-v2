import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, initGitRepo, bootstrapForTest } from "./helpers.ts";
import { git } from "../src/bridge/git.ts";

const execFileAsync = promisify(execFile);

test("workspace bridge creates isolated worktree and enforces allowed paths", async () => {
  const root = await makeTempDir("repo-");
  const dataDir = await makeTempDir("data-");
  await initGitRepo(root);

  const services = await bootstrapForTest({
    REPO_ROOT: root,
    DATA_DIR: dataDir,
    TEST_COMMAND: "node --eval \"process.exit(0)\"",
    LINT_COMMAND: "node --eval \"process.exit(0)\"",
    TYPECHECK_COMMAND: "node --eval \"process.exit(0)\""
  }, { dryRun: true });

  try {
    const workspace = await services.bridge.createWorkspace({ ticketId: "T1", runId: "R1", owner: "R1", targetDir: root });
    await services.bridge.acquireWorkspaceLease(workspace.id, "R1");

    const changed = await services.bridge.writeFiles({
      workspaceId: workspace.id,
      runId: "R1",
      ticketId: "T1",
      nodeName: "builder_apply",
      allowedPaths: ["README.md"],
      files: [{ path: "README.md", content: "# Test Repo\n\nbridge change\n" }]
    });

    assert.deepEqual(changed, ["README.md"]);
    const diff = await services.bridge.gitDiff(workspace.id);
    assert.match(diff, /README\.md/);

    await assert.rejects(() =>
      services.bridge.writeFiles({
        workspaceId: workspace.id,
        runId: "R1",
        ticketId: "T1",
        nodeName: "builder_apply",
        allowedPaths: ["src"],
        files: [{ path: "../escape.txt", content: "nope" }]
      })
    );

    await services.bridge.cleanupWorkspace(workspace.id, true);
  } finally {
    services.restore();
  }
});

test("workspace bridge surfaces a clearer error when the target repo HEAD cannot be resolved", async () => {
  const root = await makeTempDir("repo-empty-");
  const dataDir = await makeTempDir("data-");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });

  const services = await bootstrapForTest({
    REPO_ROOT: root,
    DATA_DIR: dataDir,
    TEST_COMMAND: "node --eval \"process.exit(0)\"",
    LINT_COMMAND: "node --eval \"process.exit(0)\"",
    TYPECHECK_COMMAND: "node --eval \"process.exit(0)\""
  }, { dryRun: true });

  try {
    await assert.rejects(
      () => services.bridge.createWorkspace({ ticketId: "T3", runId: "R3", owner: "R3", targetDir: root }),
      /Workspace bootstrap failed: could not resolve HEAD/
    );
  } finally {
    services.restore();
  }
});

test("workspace bridge cleans up archived workspaces after retention", async () => {
  const root = await makeTempDir("repo-");
  const dataDir = await makeTempDir("data-");
  await initGitRepo(root);

  const services = await bootstrapForTest({
    REPO_ROOT: root,
    DATA_DIR: dataDir,
    TEST_COMMAND: "node --eval \"process.exit(0)\"",
    LINT_COMMAND: "node --eval \"process.exit(0)\"",
    TYPECHECK_COMMAND: "node --eval \"process.exit(0)\""
  }, { dryRun: true });

  try {
    const workspace = await services.bridge.createWorkspace({ ticketId: "T2", runId: "R2", owner: "R2", targetDir: root });
    await services.bridge.archiveWorkspace(workspace.id);
    services.db.db.prepare(`UPDATE workspaces SET updated_at = ? WHERE id = ?`).run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), workspace.id);

    const cleaned = await services.bridge.cleanupArchivedWorkspaces(1);

    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0].id, workspace.id);
    // Direct checkout mode: worktreePath === repoRoot, so directory persists.
    // Verify ticket branch was deleted instead.
    const branchList = await git(root, ["branch", "--list", workspace.branchName]);
    assert.equal(branchList.stdout.trim(), "");
    assert.equal(services.db.getWorkspace(workspace.id)?.status, "cleaned");
  } finally {
    services.restore();
  }
});

test("workspace bridge pushes detached HEAD to a fully-qualified target branch ref", async () => {
  const root = await makeTempDir("repo-");
  const remote = await makeTempDir("remote-");
  const dataDir = await makeTempDir("data-");
  await initGitRepo(root);
  await execFileAsync("git", ["init", "--bare"], { cwd: remote });
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: root });
  await execFileAsync("git", ["push", "-u", "origin", "HEAD:refs/heads/main"], { cwd: root });

  const services = await bootstrapForTest({
    REPO_ROOT: root,
    DATA_DIR: dataDir,
    TEST_COMMAND: "node --eval \"process.exit(0)\"",
    LINT_COMMAND: "node --eval \"process.exit(0)\"",
    TYPECHECK_COMMAND: "node --eval \"process.exit(0)\""
  }, { dryRun: true });

  try {
    const workspace = await services.bridge.createWorkspace({
      ticketId: "T4",
      runId: "R4",
      owner: "R4",
      targetDir: root,
      baseRef: "main",
      useTargetBranch: true
    });
    await services.bridge.acquireWorkspaceLease(workspace.id, "R4");

    await services.bridge.writeFiles({
      workspaceId: workspace.id,
      runId: "R4",
      ticketId: "T4",
      nodeName: "builder_apply",
      allowedPaths: ["README.md"],
      files: [{ path: "README.md", content: "# Test Repo\n\nupdated on target branch\n" }]
    });
    await services.bridge.gitCommit({ workspaceId: workspace.id, message: "update target branch" });
    await services.bridge.gitPushToBranch({ workspaceId: workspace.id, targetBranch: "theming" });

    const remoteHead = await git(remote, ["rev-parse", "refs/heads/theming"]);
    const localHead = await git(workspace.worktreePath, ["rev-parse", "HEAD"]);
    assert.equal(remoteHead.stdout.trim(), localHead.stdout.trim());
  } finally {
    services.restore();
  }
});
