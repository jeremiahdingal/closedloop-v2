import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapForTest, makeTempDir, initGitRepo } from "./helpers.ts";
import { GoalRunner } from "../src/orchestration/goal-runner.ts";
import { MockGateway } from "../src/orchestration/models.ts";
import { TicketRunner } from "../src/orchestration/ticket-runner.ts";
import { RecoveryService } from "../src/orchestration/recovery.ts";
import { nowIso } from "../src/utils.ts";

test("recovery service requeues stale runs and expired leases", async () => {
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
    const epic = GoalRunner.createEpic(services.db, { id: "epic_stale", title: "stale", goalText: "stale", targetDir: repoRoot });
    services.db.createRun({
      id: "run_stale",
      kind: "ticket",
      epicId: epic.id,
      ticketId: "ticket_missing",
      status: "running",
      currentNode: "builder",
      attempt: 1,
      heartbeatAt: new Date(Date.now() - 999_999).toISOString(),
      lastMessage: "stale",
      errorText: null
    });

    services.db.upsertLease({
      resourceType: "workspace",
      resourceId: "ws_old",
      owner: "run_stale",
      heartbeatAt: new Date(Date.now() - 999_999).toISOString(),
      expiresAt: new Date(Date.now() - 999_999).toISOString()
    });

    const recovery = new RecoveryService(
      services.db,
      new TicketRunner(services.db, services.bridge, new MockGateway(), services.lifecycle),
      new GoalRunner(services.db, new TicketRunner(services.db, services.bridge, new MockGateway(), services.lifecycle), new MockGateway(), services.lifecycle)
    );

    recovery.recoverExpiredLeases();
    const staleIds = await recovery.rerunStaleRuns(1000);

    assert.deepEqual(staleIds, ["run_stale"]);
    assert.equal(services.db.getLease("workspace", "ws_old"), null);
    assert.equal(services.db.listJobs().some((job) => job.kind === "run_ticket"), true);
  } finally {
    services.restore();
  }
});

test("lifecycle service cancels and deletes ticket records and workspace state", async () => {
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
    const epic = GoalRunner.createEpic(services.db, { id: "epic_delete", title: "delete", goalText: "delete", targetDir: repoRoot });
    services.db.createTicket({
      id: "ticket_delete",
      epicId: epic.id,
      title: "Delete me",
      description: "Delete me",
      acceptanceCriteria: ["gone"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "building",
      currentRunId: "run_delete",
      currentNode: "builder",
      lastHeartbeatAt: nowIso(),
      lastMessage: "working",
      metadata: {}
    });
    services.db.createRun({
      id: "run_delete",
      kind: "ticket",
      epicId: epic.id,
      ticketId: "ticket_delete",
      status: "running",
      currentNode: "builder",
      attempt: 1,
      heartbeatAt: nowIso(),
      lastMessage: "working",
      errorText: null
    });
    const workspace = await services.bridge.createWorkspace({ ticketId: "ticket_delete", runId: "run_delete", owner: "run_delete", targetDir: repoRoot });
    services.db.enqueueJob("run_ticket", { ticketId: "ticket_delete", epicId: epic.id, runId: "run_delete" });
    await services.bridge.saveArtifact({
      runId: "run_delete",
      ticketId: "ticket_delete",
      kind: "diff",
      name: "ticket_delete.diff",
      content: "diff"
    });

    const summary = await services.lifecycle.deleteTicket("ticket_delete");

    assert.equal(summary.activeRunIds.includes("run_delete"), true);
    assert.equal(services.db.getTicket("ticket_delete"), null);
    assert.equal(services.db.getRun("run_delete"), null);
    assert.equal(services.db.listRunsForTicket("ticket_delete").length, 0);
    assert.equal(services.db.listJobs().some((job) => job.kind === "run_ticket"), false);
    assert.equal(services.db.getWorkspace(workspace.id), null);
  } finally {
    services.restore();
  }
});

test("recovery service skips queued jobs whose runs are no longer queued", async () => {
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
    const epic = GoalRunner.createEpic(services.db, { id: "epic_skip", title: "skip", goalText: "skip", targetDir: repoRoot });
    services.db.createTicket({
      id: "ticket_skip",
      epicId: epic.id,
      title: "Skip duplicate run",
      description: "Skip duplicate run",
      acceptanceCriteria: ["done"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "approved",
      currentRunId: "run_skip",
      currentNode: "complete",
      lastHeartbeatAt: nowIso(),
      lastMessage: "done",
      metadata: {}
    });
    services.db.createRun({
      id: "run_skip",
      kind: "ticket",
      epicId: epic.id,
      ticketId: "ticket_skip",
      status: "succeeded",
      currentNode: "complete",
      attempt: 1,
      heartbeatAt: nowIso(),
      lastMessage: "done",
      errorText: null
    });

    const recovery = new RecoveryService(
      services.db,
      new TicketRunner(services.db, services.bridge, new MockGateway(), services.lifecycle),
      new GoalRunner(services.db, new TicketRunner(services.db, services.bridge, new MockGateway(), services.lifecycle), new MockGateway(), services.lifecycle)
    );

    await recovery.processJob({
      id: "job_skip",
      kind: "run_ticket",
      payload: { runId: "run_skip", ticketId: "ticket_skip", epicId: epic.id }
    });

    assert.equal(services.db.getRun("run_skip")?.status, "succeeded");
    assert.equal(services.db.getTicket("ticket_skip")?.status, "approved");
  } finally {
    services.restore();
  }
});

test("recovery service fails stalled runs after recovery budget is exhausted", async () => {
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
    const epic = GoalRunner.createEpic(services.db, { id: "epic_budget", title: "budget", goalText: "budget", targetDir: repoRoot });
    services.db.createTicket({
      id: "ticket_budget",
      epicId: epic.id,
      title: "Budget fail",
      description: "Budget fail",
      acceptanceCriteria: ["done"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "building",
      currentRunId: "run_budget",
      currentNode: "builder",
      lastHeartbeatAt: nowIso(),
      lastMessage: "running",
      metadata: {}
    });
    services.db.createRun({
      id: "run_budget",
      kind: "ticket",
      epicId: epic.id,
      ticketId: "ticket_budget",
      status: "running",
      currentNode: "builder",
      attempt: 3,
      heartbeatAt: new Date(Date.now() - 999_999).toISOString(),
      lastMessage: "stale",
      errorText: null
    });

    const recovery = new RecoveryService(
      services.db,
      new TicketRunner(services.db, services.bridge, new MockGateway(), services.lifecycle),
      new GoalRunner(services.db, new TicketRunner(services.db, services.bridge, new MockGateway(), services.lifecycle), new MockGateway(), services.lifecycle)
    );

    const staleIds = await recovery.rerunStaleRuns(1000, 3);

    assert.deepEqual(staleIds, ["run_budget"]);
    assert.equal(services.db.getRun("run_budget")?.status, "failed");
    assert.equal(services.db.getTicket("ticket_budget")?.status, "failed");
    assert.equal(services.db.listJobs().some((job) => job.kind === "run_ticket"), false);
    const events = services.db.listEventsAfterId(0, { runId: "run_budget", kind: "recovery_exhausted" });
    assert.equal(events.length > 0, true);
  } finally {
    services.restore();
  }
});

test("recovery service heals duplicate running jobs for a queued run", async () => {
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
    const epic = GoalRunner.createEpic(services.db, { id: "epic_jobs", title: "jobs", goalText: "jobs", targetDir: repoRoot });
    services.db.createTicket({
      id: "ticket_jobs",
      epicId: epic.id,
      title: "Heal queue",
      description: "Heal queue",
      acceptanceCriteria: ["done"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      currentRunId: "run_jobs",
      currentNode: "queued",
      lastHeartbeatAt: nowIso(),
      lastMessage: "queued",
      metadata: {}
    });
    services.db.createRun({
      id: "run_jobs",
      kind: "ticket",
      epicId: epic.id,
      ticketId: "ticket_jobs",
      status: "queued",
      currentNode: "queued",
      attempt: 1,
      heartbeatAt: nowIso(),
      lastMessage: "queued",
      errorText: null
    });

    services.db.enqueueJob("run_ticket", { ticketId: "ticket_jobs", epicId: epic.id, runId: "run_jobs" });
    // Bypass enqueueJob de-duplication to simulate legacy duplicate active jobs.
    services.db.db.prepare(`
      INSERT INTO jobs (id, kind, payload_json, status, available_at, attempts, last_error, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, 0, NULL, ?, ?)
    `).run(
      "job_legacydup",
      "run_ticket",
      JSON.stringify({ ticketId: "ticket_jobs", epicId: epic.id, runId: "run_jobs" }),
      nowIso(),
      nowIso(),
      nowIso()
    );
    const j1 = services.db.nextQueuedJob();
    const j2 = services.db.nextQueuedJob();
    assert.ok(j1);
    assert.ok(j2);

    const recovery = new RecoveryService(
      services.db,
      new TicketRunner(services.db, services.bridge, new MockGateway(), services.lifecycle),
      new GoalRunner(services.db, new TicketRunner(services.db, services.bridge, new MockGateway(), services.lifecycle), new MockGateway(), services.lifecycle)
    );

    const result = recovery.healQueueState();
    assert.equal(result.recovered, 1);
    assert.equal(result.failedDuplicates, 1);

    const jobs = services.db.listJobRecords().filter((job) => (job.payload as any)?.runId === "run_jobs");
    assert.equal(jobs.filter((job) => job.status === "queued").length, 1);
    assert.equal(jobs.filter((job) => job.status === "failed").length, 1);
  } finally {
    services.restore();
  }
});

test("enqueueJob deduplicates active jobs for the same run", async () => {
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
    const epic = GoalRunner.createEpic(services.db, { id: "epic_dedupe", title: "dedupe", goalText: "dedupe", targetDir: repoRoot });
    services.db.createTicket({
      id: "ticket_dedupe",
      epicId: epic.id,
      title: "Dedupe job",
      description: "Dedupe job",
      acceptanceCriteria: ["done"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      currentRunId: "run_dedupe",
      currentNode: "queued",
      lastHeartbeatAt: nowIso(),
      lastMessage: "queued",
      metadata: {}
    });
    services.db.createRun({
      id: "run_dedupe",
      kind: "ticket",
      epicId: epic.id,
      ticketId: "ticket_dedupe",
      status: "queued",
      currentNode: "queued",
      attempt: 0,
      heartbeatAt: nowIso(),
      lastMessage: "queued",
      errorText: null
    });

    const firstId = services.db.enqueueJob("run_ticket", { runId: "run_dedupe", epicId: epic.id, ticketId: "ticket_dedupe" });
    const secondId = services.db.enqueueJob("run_ticket", { runId: "run_dedupe", epicId: epic.id, ticketId: "ticket_dedupe" });

    assert.equal(firstId, secondId);
    const jobs = services.db.listJobRecords().filter((job) => (job.payload as any)?.runId === "run_dedupe");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "queued");
  } finally {
    services.restore();
  }
});
