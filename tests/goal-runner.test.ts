import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapForTest, initGitRepo, makeTempDir } from "./helpers.ts";
import { GoalRunner } from "../src/orchestration/goal-runner.ts";
import { MockGateway } from "../src/orchestration/models.ts";
import { TicketRunner } from "../src/orchestration/ticket-runner.ts";

test("goal runner drops unknown ticket dependencies and still executes the ticket before epic review", async () => {
  const repoRoot = await makeTempDir("repo-");
  const dataDir = await makeTempDir("data-");
  await initGitRepo(repoRoot);

  const services = await bootstrapForTest({
    REPO_ROOT: repoRoot,
    DATA_DIR: dataDir,
    TEST_COMMAND: 'node --eval "process.exit(0)"',
    LINT_COMMAND: 'node --eval "process.exit(0)"',
    TYPECHECK_COMMAND: 'node --eval "process.exit(0)"'
  }, { dryRun: true });

  try {
    const gateway = new MockGateway({
      goalDecomposition: {
        summary: "Create hello.ts",
        tickets: [
          {
            id: "T001",
            title: "Create hello.ts file",
            description: "Add a tiny TypeScript hello world file.",
            acceptanceCriteria: ["hello.ts exists"],
            dependencies: ["TypeScript environment setup"],
            allowedPaths: ["src"],
            priority: "high"
          }
        ]
      },
      builderPlans: [
        {
          summary: "Create src/hello.ts",
          intendedFiles: ["src/hello.ts"],
          operations: [
            {
              kind: "replace_file",
              path: "src/hello.ts",
              content: 'console.log("Hello, world!");\n'
            }
          ]
        }
      ],
      reviewerVerdicts: [
        {
          approved: true,
          blockers: [],
          suggestions: [],
          riskLevel: "low"
        }
      ],
      goalReview: {
        verdict: "approved",
        summary: "Epic review approved after ticket completion.",
        followupTickets: []
      }
    });
    const ticketRunner = new TicketRunner(services.db, services.bridge, gateway, services.lifecycle);
    const goalRunner = new GoalRunner(services.db, ticketRunner, gateway, services.lifecycle);

    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_dependency_cleanup",
      title: "Dependency cleanup",
      goalText: "Create hello.ts",
      targetDir: repoRoot
    });

    const runId = await goalRunner.enqueueGoal(epic.id);
    await goalRunner.runExisting(runId);

    const ticket = services.db.getTicket(`${epic.id}__T001`);
    assert.ok(ticket);
    assert.deepEqual(ticket.dependencies, []);
    assert.equal(ticket.status, "approved");
    assert.ok(ticket.currentRunId);

    const epicRun = services.db.getRun(runId);
    assert.equal(epicRun?.status, "succeeded");

    const agentEvents = services.db.listEventsAfterId(0, { kind: "agent_stream" }) as Array<{ payload?: any }>;
    assert.equal(agentEvents.some((event) => event.payload?.agentRole === "epicReviewer"), true);
  } finally {
    services.restore();
  }
});

test("goal runner fails the epic when tickets never become approved", async () => {
  const repoRoot = await makeTempDir("repo-");
  const dataDir = await makeTempDir("data-");
  await initGitRepo(repoRoot);

  const services = await bootstrapForTest({
    REPO_ROOT: repoRoot,
    DATA_DIR: dataDir,
    TEST_COMMAND: 'node --eval "process.exit(0)"',
    LINT_COMMAND: 'node --eval "process.exit(0)"',
    TYPECHECK_COMMAND: 'node --eval "process.exit(0)"'
  }, { dryRun: true });

  try {
    let reviewCalls = 0;
    class GuardedGateway extends MockGateway {
      override async getGoalReview(prompt: string) {
        reviewCalls += 1;
        return super.getGoalReview(prompt);
      }
    }

    const gateway = new GuardedGateway({
      goalDecomposition: {
        summary: "Create hello.ts",
        tickets: [
          {
            id: "T001",
            title: "Create hello.ts file",
            description: "Add a tiny TypeScript hello world file.",
            acceptanceCriteria: ["hello.ts exists"],
            dependencies: ["T001"],
            allowedPaths: ["src"],
            priority: "high"
          }
        ]
      },
      goalReview: {
        verdict: "approved",
        summary: "This should never be used.",
        followupTickets: []
      }
    });
    const ticketRunner = new TicketRunner(services.db, services.bridge, gateway, services.lifecycle);
    const goalRunner = new GoalRunner(services.db, ticketRunner, gateway, services.lifecycle);

    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_blocked_review",
      title: "Blocked review",
      goalText: "Create hello.ts",
      targetDir: repoRoot
    });

    const runId = await goalRunner.enqueueGoal(epic.id);
    await goalRunner.runExisting(runId);

    const epicRun = services.db.getRun(runId);
    assert.equal(epicRun?.status, "failed");
    assert.match(String(epicRun?.lastMessage), /Epic review blocked:/);
    assert.equal(reviewCalls, 0);
  } finally {
    services.restore();
  }
});

test("goal runner aliases planner ANA ticket ids to execution ticket ids", async () => {
  const repoRoot = await makeTempDir("repo-");
  const dataDir = await makeTempDir("data-");
  await initGitRepo(repoRoot);

  const services = await bootstrapForTest({
    REPO_ROOT: repoRoot,
    DATA_DIR: dataDir,
    TEST_COMMAND: 'node --eval "process.exit(0)"',
    LINT_COMMAND: 'node --eval "process.exit(0)"',
    TYPECHECK_COMMAND: 'node --eval "process.exit(0)"'
  }, { dryRun: true });

  try {
    const gateway = new MockGateway({
      goalDecomposition: {
        summary: "Create one ticket",
        tickets: [
          {
            id: "ANA-06",
            title: "Implement trend report",
            description: "Add the trend report endpoint.",
            acceptanceCriteria: ["trend report exists"],
            dependencies: [],
            allowedPaths: ["src"],
            priority: "high"
          }
        ]
      },
      builderPlans: [
        {
          summary: "Create src/trend.ts",
          intendedFiles: ["src/trend.ts"],
          operations: [
            {
              kind: "replace_file",
              path: "src/trend.ts",
              content: 'export const trend = true;\n'
            }
          ]
        }
      ],
      reviewerVerdicts: [
        {
          approved: true,
          blockers: [],
          suggestions: [],
          riskLevel: "low"
        }
      ],
      goalReview: {
        verdict: "approved",
        summary: "approved",
        followupTickets: []
      }
    });
    const ticketRunner = new TicketRunner(services.db, services.bridge, gateway, services.lifecycle);
    const goalRunner = new GoalRunner(services.db, ticketRunner, gateway, services.lifecycle);

    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_analysis_alias",
      title: "Analysis alias cleanup",
      goalText: "Create a trend report ticket",
      targetDir: repoRoot
    });

    const runId = await goalRunner.enqueueGoal(epic.id);
    await goalRunner.runExisting(runId);

    const cleanTicket = services.db.getTicket(`${epic.id}__T-001`);
    assert.ok(cleanTicket);
    assert.equal(cleanTicket.title, "Implement trend report");
    assert.equal((cleanTicket.metadata as Record<string, unknown>).sourceTicketId, "ANA-06");
    assert.equal(services.db.getTicket(`${epic.id}__ANA-06`), null);
  } finally {
    services.restore();
  }
});

test("goal runner manual review runs checks and invokes epic reviewer for approved tickets", async () => {
  const repoRoot = await makeTempDir("repo-");
  const dataDir = await makeTempDir("data-");
  await initGitRepo(repoRoot);

  const services = await bootstrapForTest({
    REPO_ROOT: repoRoot,
    DATA_DIR: dataDir,
    TEST_COMMAND: 'node --eval "process.exit(0)"',
    LINT_COMMAND: 'node --eval "process.exit(0)"',
    TYPECHECK_COMMAND: 'node --eval "process.exit(0)"'
  }, { dryRun: true });

  try {
    const gateway = new MockGateway({
      goalReview: {
        verdict: "approved",
        summary: "Manual epic review approved.",
        followupTickets: []
      }
    });
    const ticketRunner = new TicketRunner(services.db, services.bridge, gateway, services.lifecycle);
    const goalRunner = new GoalRunner(services.db, ticketRunner, gateway, services.lifecycle);

    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_manual_review",
      title: "Manual review epic",
      goalText: "Manual review",
      targetDir: repoRoot
    });

    services.db.createRun({
      id: "run_ticket_approved",
      kind: "ticket",
      epicId: epic.id,
      ticketId: `${epic.id}__T1`,
      status: "succeeded",
      currentNode: "complete",
      attempt: 0,
      heartbeatAt: new Date().toISOString(),
      lastMessage: "Ticket approved.",
      errorText: null
    });
    services.db.createTicket({
      id: `${epic.id}__T1`,
      epicId: epic.id,
      title: "Approved ticket",
      description: "done",
      acceptanceCriteria: ["done"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "approved",
      currentRunId: "run_ticket_approved",
      currentNode: "complete",
      lastHeartbeatAt: new Date().toISOString(),
      lastMessage: "Ticket approved.",
      metadata: {}
    });

    const reviewRunId = await goalRunner.enqueueManualReview(epic.id);
    await goalRunner.runManualReviewExisting(reviewRunId);

    const run = services.db.getRun(reviewRunId);
    assert.equal(run?.status, "succeeded");
    assert.equal(services.db.getEpic(epic.id)?.status, "done");
    const events = services.db.listEventsAfterId(0, { runId: reviewRunId, kind: "epic_manual_reviewed" });
    assert.equal(events.length > 0, true);
  } finally {
    services.restore();
  }
});
