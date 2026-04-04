import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTempDir, initGitRepo, bootstrapForTest } from "./helpers.ts";
import { GoalRunner } from "../src/orchestration/goal-runner.ts";
import { MediatedAgentHarnessGateway, MockGateway } from "../src/orchestration/models.ts";
import { TicketRunner } from "../src/orchestration/ticket-runner.ts";
import { OpenCodeLaunchError } from "../src/orchestration/opencode.ts";

test("ticket runner completes a successful build-review-test loop", async () => {
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
      id: "epic_success",
      title: "Success epic",
      goalText: "Make a safe change.",
      targetDir: repoRoot
    });
    services.db.createTicket({
      id: "ticket_success",
      epicId: epic.id,
      title: "Update README",
      description: "Append a controlled change.",
      acceptanceCriteria: ["README updated"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      metadata: { maxBuildAttempts: 2 }
    });

    const gateway = new MockGateway({
      builderPlans: [
        {
          summary: "Append line to README",
          intendedFiles: ["README.md"],
          operations: [{ kind: "append_file", path: "README.md", content: "\nBuilt by test\n" }]
        }
      ],
      reviewerVerdicts: [
        {
          approved: true,
          blockers: [],
          suggestions: [],
          riskLevel: "low"
        }
      ]
    });
    const runner = new TicketRunner(services.db, services.bridge, gateway, services.lifecycle);
    const runId = await runner.start("ticket_success", epic.id);
    const result = await runner.runExisting(runId);

    assert.equal(result.status, "approved");
    const ticket = services.db.getTicket("ticket_success");
    assert.equal(ticket?.status, "approved");
    assert.ok(services.db.listArtifacts("ticket_success").length >= 3);
  } finally {
    services.restore();
  }
});

test("ticket runner escalates repeated blockers", async () => {
  const repoRoot = await makeTempDir("repo-");
  const dataDir = await makeTempDir("data-");
  await initGitRepo(repoRoot);

  const services = await bootstrapForTest({
    REPO_ROOT: repoRoot,
    DATA_DIR: dataDir,
    TEST_COMMAND: "node --eval \"process.exit(1)\"",
    LINT_COMMAND: "node --eval \"process.exit(0)\"",
    TYPECHECK_COMMAND: "node --eval \"process.exit(0)\""
  }, { dryRun: true });

  try {
    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_escalate",
      title: "Escalate epic",
      goalText: "Escalate repeated blockers.",
      targetDir: repoRoot
    });
    services.db.createTicket({
      id: "ticket_escalate",
      epicId: epic.id,
      title: "Change README",
      description: "Append same line twice.",
      acceptanceCriteria: ["README updated"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      metadata: { maxBuildAttempts: 3 }
    });

    const gateway = new MockGateway({
      builderPlans: [
        {
          summary: "Append line",
          intendedFiles: ["README.md"],
          operations: [{ kind: "append_file", path: "README.md", content: "\nChange 1\n" }]
        },
        {
          summary: "Append line again",
          intendedFiles: ["README.md"],
          operations: [{ kind: "append_file", path: "README.md", content: "\nChange 2\n" }]
        }
      ],
      reviewerVerdicts: [
        { approved: false, blockers: ["Same blocker"], suggestions: [], riskLevel: "medium" },
        { approved: false, blockers: ["Same blocker"], suggestions: [], riskLevel: "medium" }
      ],
      failureDecisions: [
        { decision: "retry_builder", reason: "Try again." },
        { decision: "escalate", reason: "Blocker repeated." }
      ]
    });

    const runner = new TicketRunner(services.db, services.bridge, gateway, services.lifecycle);
    const runId = await runner.start("ticket_escalate", epic.id);
    const result = await runner.runExisting(runId);

    assert.notEqual(result.status, "approved");
    const ticket = services.db.getTicket("ticket_escalate");
    assert.equal(ticket?.status, "escalated");
  } finally {
    services.restore();
  }
});


test("ticket runner records agent stream events for opencode-backed builder", async () => {
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
    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_stream",
      title: "Stream epic",
      goalText: "Use opencode-backed builder.",
      targetDir: repoRoot
    });
    services.db.createTicket({
      id: "ticket_stream",
      epicId: epic.id,
      title: "Update README through tooling agent",
      description: "Append a streamed change.",
      acceptanceCriteria: ["README updated"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      metadata: { maxBuildAttempts: 2 }
    });

    class StreamGateway extends MockGateway {
      async runBuilderInWorkspace(input: any) {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        input.onStream?.({ agentRole: "builder", source: "opencode", streamKind: "thinking", content: "Analyzing task", runId: input.runId, ticketId: input.ticketId, epicId: input.epicId });
        await fs.appendFile(path.join(input.cwd, "README.md"), `\nStreamed by builder\n`, "utf8");
        input.onStream?.({ agentRole: "builder", source: "opencode", streamKind: "assistant", content: "Applied change", runId: input.runId, ticketId: input.ticketId, epicId: input.epicId, done: true });
        return { summary: "Applied streamed README change", sessionId: "session_test", rawOutput: `Analyzing task\nApplied change` };
      }
    }

    const gateway = new StreamGateway({
      reviewerVerdicts: [{ approved: true, blockers: [], suggestions: [], riskLevel: "low" }]
    });
    const runner = new TicketRunner(services.db, services.bridge, gateway as any, services.lifecycle);
    const runId = await runner.start("ticket_stream", epic.id);
    const result = await runner.runExisting(runId);

    assert.equal(result.status, "approved");
    const streamEvents = services.db.listEventsAfterId(0, { kind: "agent_stream" });
    assert.equal(streamEvents.length >= 2, true);
  } finally {
    services.restore();
  }
});

test("ticket runner records structured OpenCode launch failures before falling back", async () => {
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
    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_launch",
      title: "Launch epic",
      goalText: "Exercise launch failure handling.",
      targetDir: repoRoot
    });
    services.db.createTicket({
      id: "ticket_launch",
      epicId: epic.id,
      title: "Update README after launch failure",
      description: "Append a controlled change.",
      acceptanceCriteria: ["README updated"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      metadata: { maxBuildAttempts: 2 }
    });

    const launchInfo = {
      cwd: path.join(repoRoot, "missing-worktree"),
      repoRoot,
      model: "ollama/qwen3-coder:30b",
      promptLength: 128,
      command: process.execPath,
      args: [path.join(repoRoot, "node_modules", "opencode-ai", "bin", "opencode"), "run", "--model", "ollama/qwen3-coder:30b", "--prompt", "<redacted>"],
      shell: false,
      binaryPath: path.join(repoRoot, "node_modules", "opencode-ai", "bin", "opencode"),
      binarySource: "package-entrypoint" as const,
      cwdExists: false,
      cwdIsDirectory: false
    };

    class LaunchErrorGateway extends MockGateway {
      async runBuilderInWorkspace(): Promise<never> {
        throw new OpenCodeLaunchError("invalid_cwd", "OpenCode workspace cwd does not exist or is not a directory", launchInfo);
      }
    }

    const gateway = new LaunchErrorGateway({
      builderPlans: [
        {
          summary: "Append line to README",
          intendedFiles: ["README.md"],
          operations: [{ kind: "append_file", path: "README.md", content: "\nBuilt after launch fallback\n" }]
        }
      ],
      reviewerVerdicts: [
        {
          approved: true,
          blockers: [],
          suggestions: [],
          riskLevel: "low"
        }
      ]
    });
    const runner = new TicketRunner(services.db, services.bridge, gateway, services.lifecycle);
    const runId = await runner.start("ticket_launch", epic.id);
    const result = await runner.runExisting(runId);

    assert.equal(result.status, "approved");
    const artifacts = services.db.listArtifacts("ticket_launch");
    const launchArtifact = artifacts.find((artifact) => artifact.kind === "launch");
    assert.ok(launchArtifact);
    assert.match(String(launchArtifact?.name), /builder-opencode-launch\.json$/);

    const streamEvents = services.db.listEventsAfterId(0, { kind: "agent_stream" });
    const builderError = streamEvents.find((event) => {
      const payload = event.payload as any;
      return String(payload?.agentRole) === "builder" && String(payload?.streamKind) === "stderr";
    });
    assert.ok(builderError);
    const builderPayload = builderError?.payload as any;
    assert.match(String(builderPayload?.content), /OpenCode launch failed \[invalid_cwd\]/);
    assert.match(String(builderPayload?.content), /Falling back to plan mode\./);
  } finally {
    services.restore();
  }
});

test("ticket runner passes the workspace path to the mediated tester", async () => {
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
    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_mediated_tester_path",
      title: "Mediated tester path epic",
      goalText: "Verify tester workspace path wiring.",
      targetDir: repoRoot
    });
    services.db.createTicket({
      id: "ticket_mediated_tester_path",
      epicId: epic.id,
      title: "Update README",
      description: "Append a controlled change.",
      acceptanceCriteria: ["README updated"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      metadata: { maxBuildAttempts: 2 }
    });

    class MediatedTesterGateway extends MockGateway {
      override get models() {
        return {
          ...super.models,
          tester: "mediated:glm-4.7-flash:q4_K_M" as const
        };
      }

      async runTesterInWorkspace(input: any) {
        assert.equal(path.isAbsolute(input.cwd), true);
        assert.equal(input.cwd.includes("ws_"), true);
        return {
          testNecessityScore: 0,
          testNecessityReason: "No tests needed for this change.",
          testsWritten: false,
          testFiles: [],
          testResults: "SKIPPED",
          testOutput: "Skipped.",
          testsRun: 0
        };
      }
    }

    const gateway = new MediatedTesterGateway({
      builderPlans: [
        {
          summary: "Append line to README",
          intendedFiles: ["README.md"],
          operations: [{ kind: "append_file", path: "README.md", content: "\nMediated tester path\n" }]
        }
      ],
      reviewerVerdicts: [
        {
          approved: true,
          blockers: [],
          suggestions: [],
          riskLevel: "low"
        }
      ]
    });

    const runner = new TicketRunner(services.db, services.bridge, gateway as any, services.lifecycle);
    const runId = await runner.start("ticket_mediated_tester_path", epic.id);
    const result = await runner.runExisting(runId);

    assert.equal(result.status, "approved");
  } finally {
    services.restore();
  }
});

test("ticket runner retries transient reviewer infrastructure failures", async () => {
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
    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_reviewer_retry",
      title: "Reviewer retry epic",
      goalText: "Retry transient reviewer infra failure.",
      targetDir: repoRoot
    });
    services.db.createTicket({
      id: "ticket_reviewer_retry",
      epicId: epic.id,
      title: "Update README",
      description: "Append a controlled change.",
      acceptanceCriteria: ["README updated"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      metadata: { maxBuildAttempts: 2 }
    });

    class RetryReviewerGateway extends MockGateway {
      private reviewerCalls = 0;
      override async getReviewerVerdict(_prompt: string) {
        this.reviewerCalls += 1;
        if (this.reviewerCalls === 1) {
          throw new Error("fetch failed");
        }
        return {
          approved: true,
          blockers: [],
          suggestions: [],
          riskLevel: "low"
        };
      }
    }

    const gateway = new RetryReviewerGateway({
      builderPlans: [
        {
          summary: "Append line to README",
          intendedFiles: ["README.md"],
          operations: [{ kind: "append_file", path: "README.md", content: "\nReviewer retry\n" }]
        }
      ]
    });

    const runner = new TicketRunner(services.db, services.bridge, gateway as any, services.lifecycle);
    const runId = await runner.start("ticket_reviewer_retry", epic.id);
    const result = await runner.runExisting(runId);

    assert.equal(result.status, "approved");
    const streamEvents = services.db.listEventsAfterId(0, { kind: "agent_stream", runId });
    const retryMessage = streamEvents.find((event) => String((event.payload as any)?.content || "").includes("Retrying reviewer"));
    assert.ok(retryMessage);
  } finally {
    services.restore();
  }
});

test("ticket runner surfaces clearer reviewer infrastructure errors", async () => {
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
    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_reviewer_error_message",
      title: "Reviewer error epic",
      goalText: "Show clearer reviewer infra error.",
      targetDir: repoRoot
    });
    services.db.createTicket({
      id: "ticket_reviewer_error_message",
      epicId: epic.id,
      title: "Update README",
      description: "Append a controlled change.",
      acceptanceCriteria: ["README updated"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      metadata: { maxBuildAttempts: 2 }
    });

    class FailingReviewerGateway extends MockGateway {
      override async getReviewerVerdict(_prompt: string) {
        throw new Error("fetch failed");
      }
    }

    const gateway = new FailingReviewerGateway({
      builderPlans: [
        {
          summary: "Append line to README",
          intendedFiles: ["README.md"],
          operations: [{ kind: "append_file", path: "README.md", content: "\nReviewer fail\n" }]
        }
      ]
    });

    const runner = new TicketRunner(services.db, services.bridge, gateway as any, services.lifecycle);
    const runId = await runner.start("ticket_reviewer_error_message", epic.id);
    await assert.rejects(() => runner.runExisting(runId), /Reviewer\/Ollama unavailable: fetch failed/);

    const run = services.db.getRun(runId);
    const ticket = services.db.getTicket("ticket_reviewer_error_message");
    assert.equal(run?.status, "failed");
    assert.match(String(run?.errorText), /Reviewer\/Ollama unavailable: fetch failed/);
    assert.match(String(ticket?.lastMessage), /Reviewer\/Ollama unavailable: fetch failed/);
  } finally {
    services.restore();
  }
});

test("ticket runner times out stalled reviewer calls and fails clearly", async () => {
  const repoRoot = await makeTempDir("repo-");
  const dataDir = await makeTempDir("data-");
  await initGitRepo(repoRoot);

  const services = await bootstrapForTest({
    REPO_ROOT: repoRoot,
    DATA_DIR: dataDir,
    REVIEWER_TIMEOUT_MS: "50",
    TEST_COMMAND: 'node --eval "process.exit(0)"',
    LINT_COMMAND: 'node --eval "process.exit(0)"',
    TYPECHECK_COMMAND: 'node --eval "process.exit(0)"'
  }, { dryRun: true });

  try {
    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_reviewer_timeout",
      title: "Reviewer timeout epic",
      goalText: "Fail stalled reviewer clearly.",
      targetDir: repoRoot
    });
    services.db.createTicket({
      id: "ticket_reviewer_timeout",
      epicId: epic.id,
      title: "Update README",
      description: "Append a controlled change.",
      acceptanceCriteria: ["README updated"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      metadata: { maxBuildAttempts: 2 }
    });

    class HangingReviewerGateway extends MockGateway {
      override async getReviewerVerdict(_prompt: string) {
        return await new Promise<any>(() => {});
      }
    }

    const gateway = new HangingReviewerGateway({
      builderPlans: [
        {
          summary: "Append line to README",
          intendedFiles: ["README.md"],
          operations: [{ kind: "append_file", path: "README.md", content: "\nReviewer timeout\n" }]
        }
      ]
    });

    const runner = new TicketRunner(services.db, services.bridge, gateway as any, services.lifecycle);
    const runId = await runner.start("ticket_reviewer_timeout", epic.id);
    await assert.rejects(() => runner.runExisting(runId), /Reviewer\/Ollama unavailable: Reviewer timed out/);

    const run = services.db.getRun(runId);
    const ticket = services.db.getTicket("ticket_reviewer_timeout");
    assert.equal(run?.status, "failed");
    assert.match(String(run?.errorText), /Reviewer\/Ollama unavailable: Reviewer timed out/);
    assert.match(String(ticket?.lastMessage), /Reviewer\/Ollama unavailable: Reviewer timed out/);
  } finally {
    services.restore();
  }
});

test("reviewer destructive diff guard blocks unsafe approved diffs", async () => {
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
    const epic = GoalRunner.createEpic(services.db, {
      id: "epic_reviewer_destructive_guard",
      title: "Reviewer destructive guard epic",
      goalText: "Block destructive diffs even when reviewer approves.",
      targetDir: repoRoot
    });
    services.db.createTicket({
      id: "ticket_reviewer_destructive_guard",
      epicId: epic.id,
      title: "Add dangerous command to README",
      description: "Should be blocked by reviewer guard.",
      acceptanceCriteria: ["README updated"],
      dependencies: [],
      allowedPaths: ["README.md"],
      priority: "high",
      status: "queued",
      metadata: { maxBuildAttempts: 2 }
    });

    const gateway = new MockGateway({
      builderPlans: [
        {
          summary: "Append destructive command example",
          intendedFiles: ["README.md"],
          operations: [{ kind: "append_file", path: "README.md", content: "\nrm -rf ./data\n" }]
        },
        {
          summary: "Append destructive command example again",
          intendedFiles: ["README.md"],
          operations: [{ kind: "append_file", path: "README.md", content: "\nrm -rf ./cache\n" }]
        }
      ],
      reviewerVerdicts: [
        { approved: true, blockers: [], suggestions: [], riskLevel: "low" },
        { approved: true, blockers: [], suggestions: [], riskLevel: "low" }
      ]
    });

    const runner = new TicketRunner(services.db, services.bridge, gateway as any, services.lifecycle);
    const runId = await runner.start("ticket_reviewer_destructive_guard", epic.id);
    const result = await runner.runExisting(runId);

    assert.notEqual(result.status, "approved");
    const streamEvents = services.db.listEventsAfterId(0, { kind: "agent_stream", runId });
    const guardEvent = streamEvents.find((event) =>
      String((event.payload as any)?.content || "").includes("Destructive diff guard triggered")
    );
    assert.ok(guardEvent);
  } finally {
    services.restore();
  }
});

test("mediated builder retries a native failure in XML compatibility mode", async () => {
  const repoRoot = await makeTempDir("repo-");
  await initGitRepo(repoRoot);

  class RetryXmlGateway extends MediatedAgentHarnessGateway {
    readonly attempts: Array<"native" | "xml"> = [];

    override async runBuilderAttempt(_input: any, _model: string, toolMode: "native" | "xml") {
      this.attempts.push(toolMode);
      if (toolMode === "native") {
        throw new Error("Model produced empty response");
      }

      return {
        summary: "xml success",
        sessionId: null,
        rawOutput: "xml success"
      };
    }
  }

  const gateway = new RetryXmlGateway();
  const events: Array<{ streamKind: string; content: string }> = [];

  const result = await gateway.runBuilderInWorkspace({
    cwd: repoRoot,
    prompt: "Make a tiny change.",
    runId: "run_gemma_retry",
    ticketId: "ticket_gemma_retry",
    epicId: "epic_gemma_retry",
    onStream: (event) => {
      events.push({ streamKind: event.streamKind, content: event.content });
    }
  });

  assert.equal(result.rawOutput, "xml success");
  assert.deepEqual(gateway.attempts, ["native", "xml"]);
  assert.ok(events.some((event) => event.streamKind === "stderr" && event.content.includes("Retrying in XML compatibility mode")));
});
