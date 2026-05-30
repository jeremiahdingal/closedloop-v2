import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapForTest, makeTempDir, initGitRepo } from "./helpers.ts";
import { GoalRunner } from "../src/orchestration/goal-runner.ts";

test("database updates editable ticket details without disturbing run state", async () => {
  const repoRoot = await makeTempDir("repo-");
  const dataDir = await makeTempDir("data-");
  await initGitRepo(repoRoot);

  const services = await bootstrapForTest({
    REPO_ROOT: repoRoot,
    DATA_DIR: dataDir,
    TEST_COMMAND: "node --eval \"process.exit(0)\"",
    LINT_COMMAND: "node --eval \"process.exit(0)\"",
    TYPECHECK_COMMAND: "node --eval \"process.exit(0)\""
  }, { dryRun: true });

  try {
    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_ticket_edit",
      title: "ticket edit",
      goalText: "ticket edit",
      targetDir: repoRoot
    });

    services.db.createTicket({
      id: "ticket_edit",
      epicId: epic.id,
      title: "Original title",
      description: "Original description",
      acceptanceCriteria: ["first"],
      dependencies: ["dep_a"],
      allowedPaths: ["README.md"],
      priority: "medium",
      status: "building",
      currentRunId: "run_keep",
      currentNode: "builder",
      lastHeartbeatAt: null,
      lastMessage: "still running",
      metadata: {}
    });

    const updated = services.db.updateTicketDetails({
      ticketId: "ticket_edit",
      title: "Updated title",
      description: "Updated description",
      acceptanceCriteria: ["first", "second"],
      dependencies: ["dep_b", "dep_c"],
      allowedPaths: ["src/app.ts", "README.md"],
      priority: "high"
    });

    assert.equal(updated.title, "Updated title");
    assert.equal(updated.description, "Updated description");
    assert.deepEqual(updated.acceptanceCriteria, ["first", "second"]);
    assert.deepEqual(updated.dependencies, ["dep_b", "dep_c"]);
    assert.deepEqual(updated.allowedPaths, ["src/app.ts", "README.md"]);
    assert.equal(updated.priority, "high");
    assert.equal(updated.currentRunId, "run_keep");
    assert.equal(updated.currentNode, "builder");
    assert.equal(updated.lastMessage, "still running");
    assert.equal(updated.status, "building");
  } finally {
    services.restore();
  }
});
