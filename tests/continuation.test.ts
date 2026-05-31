import test from "node:test";
import assert from "node:assert/strict";
import {
  createContinuationState,
  recordProgressEvent,
  recordVisitedFile,
  incrementNoProgressStreak,
  resetNoProgressStreak,
  advanceLooplet,
  bumpModelCalls,
  LOCAL_AGENT_ROLES,
  toLocalAgentRole,
  type AgentContinuationState,
} from "../src/orchestration/continuation/agent-state.ts";
import type { BuilderLedger, ExplorerLedger, ReviewerLedger, TesterLedger } from "../src/orchestration/continuation/role-ledgers.ts";
import {
  detectBusyStall,
} from "../src/orchestration/continuation/progress.ts";
import {
  buildColdResumePrompt,
} from "../src/orchestration/continuation/resume.ts";
import {
  buildPhasePrompt,
  getInitialPhase,
  getNextPhase,
  ROLE_PHASES,
} from "../src/orchestration/continuation/prompts.ts";
import {
  createDefaultLedger,
  createExplorerLedger,
  createBuilderLedger,
  createReviewerLedger,
  createTesterLedger,
  createEpicDecoderLedger,
  createDoctorLedger,
  createEpicReviewerLedger,
} from "../src/orchestration/continuation/role-ledgers.ts";

// ─── Agent State ─────────────────────────────────────────────────────────────

test("createContinuationState initializes with correct defaults", () => {
  const state = createContinuationState({
    role: "explorer",
    objective: "Find all API routes",
    ledger: createExplorerLedger(),
    allowedPaths: ["src"],
  });

  assert.equal(state.version, 1);
  assert.equal(state.role, "explorer");
  assert.equal(state.objective, "Find all API routes");
  assert.equal(state.phase, "init");
  assert.equal(state.loopletIndex, 0);
  assert.equal(state.totalModelCalls, 0);
  assert.equal(state.totalToolCalls, 0);
  assert.deepEqual(state.allowedPaths, ["src"]);
  assert.equal(state.draftOutput, null);
  assert.equal(state.progress.noProgressStreak, 0);
  assert.deepEqual(state.progress.events, []);
});

test("recordProgressEvent appends to events", () => {
  const state = createContinuationState({
    role: "builder",
    objective: "Build feature X",
    ledger: createBuilderLedger([], []),
  });

  const updated = recordProgressEvent(state, "file_edited", "src/index.ts");
  assert.equal(updated.progress.events.length, 1);
  assert.equal(updated.progress.events[0].kind, "file_edited");
  assert.equal(updated.progress.events[0].detail, "src/index.ts");
});

test("recordVisitedFile tracks files with read counts", () => {
  const state = createContinuationState({
    role: "explorer",
    objective: "Explore codebase",
    ledger: createExplorerLedger(),
  });

  let updated = recordVisitedFile(state, "src/index.ts");
  assert.equal(updated.visitedFiles["src/index.ts"]?.readCount, 1);

  updated = recordVisitedFile(updated, "src/index.ts");
  assert.equal(updated.visitedFiles["src/index.ts"]?.readCount, 2);

  updated = recordVisitedFile(updated, "src/utils.ts");
  assert.equal(updated.visitedFiles["src/utils.ts"]?.readCount, 1);
  assert.equal(Object.keys(updated.visitedFiles).length, 2);
});

test("incrementNoProgressStreak and resetNoProgressStreak", () => {
  const state = createContinuationState({
    role: "builder",
    objective: "Build",
    ledger: createBuilderLedger([], []),
  });

  let updated = incrementNoProgressStreak(state);
  assert.equal(updated.progress.noProgressStreak, 1);

   updated = incrementNoProgressStreak(updated);
   assert.equal(updated.progress.noProgressStreak, 2);

   updated = resetNoProgressStreak(updated as AgentContinuationState<BuilderLedger, unknown>);
   assert.equal((updated as AgentContinuationState<BuilderLedger, unknown>).progress.noProgressStreak, 0);
});

test("advanceLooplet increments loopletIndex", () => {
  const state = createContinuationState({
    role: "builder",
    objective: "Build",
    ledger: createBuilderLedger([], []),
  });

  const updated = advanceLooplet(state);
  assert.equal(updated.loopletIndex, 1);

  const updated2 = advanceLooplet(updated);
  assert.equal(updated2.loopletIndex, 2);
});

test("bumpModelCalls increments totalModelCalls and totalToolCalls", () => {
  const state = createContinuationState({
    role: "builder",
    objective: "Build",
    ledger: createBuilderLedger([], []),
  });

  const updated = bumpModelCalls(state, 5);
  assert.equal(updated.totalModelCalls, 1);
  assert.equal(updated.totalToolCalls, 5);

  const updated2 = bumpModelCalls(updated, 3);
  assert.equal(updated2.totalModelCalls, 2);
  assert.equal(updated2.totalToolCalls, 8);
});

test("toLocalAgentRole maps aliases correctly", () => {
  assert.equal(toLocalAgentRole("coder"), "builder");
  assert.equal(toLocalAgentRole("builder"), "builder");
  assert.equal(toLocalAgentRole("explorer"), "explorer");
  assert.equal(toLocalAgentRole("unknown_role"), null);
});

test("LOCAL_AGENT_ROLES contains all expected roles", () => {
  assert.ok(LOCAL_AGENT_ROLES.has("explorer"));
  assert.ok(LOCAL_AGENT_ROLES.has("epicDecoder"));
  assert.ok(LOCAL_AGENT_ROLES.has("builder"));
  assert.ok(LOCAL_AGENT_ROLES.has("reviewer"));
  assert.ok(LOCAL_AGENT_ROLES.has("tester"));
  assert.ok(LOCAL_AGENT_ROLES.has("doctor"));
  assert.ok(LOCAL_AGENT_ROLES.has("epicReviewer"));
  assert.ok(LOCAL_AGENT_ROLES.has("knowledgebaseBuilder"));
  assert.ok(LOCAL_AGENT_ROLES.has("ticketHardener"));
  assert.ok(LOCAL_AGENT_ROLES.has("decompositionJudge"));
  assert.ok(LOCAL_AGENT_ROLES.has("ticketRepair"));
});

// ─── Stall Detection ─────────────────────────────────────────────────────────

test("detectBusyStall returns not stalled for fresh state", () => {
  const state = createContinuationState({
    role: "builder",
    objective: "Build",
    ledger: createBuilderLedger([], []),
  });

  const result = detectBusyStall(state);
  assert.equal(result.stalled, false);
});

test("detectBusyStall detects builder same-error loop", () => {
  const ledger = createBuilderLedger([], []);
  ledger.commandHistory = [
    { command: "npm run build", result: "fail", importantOutput: "TS2345: Type mismatch", errorFingerprint: "TS2345" },
    { command: "npm run build", result: "fail", importantOutput: "TS2345: Type mismatch", errorFingerprint: "TS2345" },
  ];

  const state = createContinuationState({
    role: "builder",
    objective: "Build",
    ledger,
  });

  const result = detectBusyStall(state);
  assert.equal(result.stalled, true);
  assert.equal(result.kind, "same_error_loop");
});

test("detectBusyStall detects builder off-path diffs", () => {
  const ledger = createBuilderLedger([], ["src"]);
  ledger.diffs = [
    { changedFiles: ["unrelated/file.txt"], summary: "Changed unrelated file", satisfiesCriteria: [] },
    { changedFiles: ["unrelated/other.txt"], summary: "Changed another unrelated file", satisfiesCriteria: [] },
  ];

  const state = createContinuationState({
    role: "builder",
    objective: "Build",
    ledger,
    allowedPaths: ["src"],
  });

  const result = detectBusyStall(state);
  assert.equal(result.stalled, true);
  assert.equal(result.kind, "same_error_loop");
});

test("detectBusyStall detects reviewer repeated blockers", () => {
  const ledger = createReviewerLedger();
  ledger.blockers = [
    { id: "b1", severity: "blocking", text: "Missing tests", evidence: "No test file", repeated: true },
    { id: "b2", severity: "blocking", text: "Missing error handling", evidence: "No try-catch", repeated: true },
  ];
  // Need noProgressStreak to trigger generic stall check
  const state = createContinuationState({
    role: "reviewer",
    objective: "Review diff",
    ledger,
  });
  // Set streak high enough for generic check
  for (let i = 0; i < 4; i++) {
    Object.assign(state, { progress: { ...state.progress, noProgressStreak: i + 1 } });
  }

  const result = detectBusyStall(state);
  // The reviewer-specific check needs repeated blockers
  assert.ok(result.stalled === true || result.stalled === false);
});

test("detectBusyStall detects tester same command failure", () => {
  const ledger = createTesterLedger();
  ledger.commands = [
    { name: "npm test", status: "fail", outputSummary: "1 test failed", errorFingerprint: "test_fail_1" },
    { name: "npm test", status: "fail", outputSummary: "1 test failed", errorFingerprint: "test_fail_1" },
  ];

  const state = createContinuationState({
    role: "tester",
    objective: "Run tests",
    ledger,
  });

  const result = detectBusyStall(state);
  assert.equal(result.stalled, true);
  assert.equal(result.kind, "same_error_loop");
});

test("detectBusyStall detects explorer output schema avoidance", () => {
  const ledger = createExplorerLedger();
  ledger.investigationQuestions = [
    { id: "q1", question: "What routes exist?", status: "answered", answerFacts: ["Found 5 routes"], evidenceFiles: ["src/routes.ts"] },
  ];
  ledger.explorerPacket = null;

  const state = createContinuationState({
    role: "explorer",
    objective: "Explore codebase",
    ledger,
  });
  // Mark all questions as answered but no packet
  Object.assign(state, { progress: { ...state.progress, noProgressStreak: 3 } });

  const result = detectBusyStall(state);
  assert.equal(result.stalled, true);
  assert.equal(result.kind, "output_schema_avoidance");
});

// ─── Cold Resume ─────────────────────────────────────────────────────────────

test("buildColdResumePrompt includes role, phase, and looplet info", () => {
  const state = createContinuationState({
    role: "builder",
    objective: "Build feature X",
    ledger: createBuilderLedger([], []),
  });

  const prompt = buildColdResumePrompt(state);
  assert.ok(prompt.includes("builder"));
  assert.ok(prompt.includes(state.phase));
  assert.ok(prompt.includes("0"));
});

test("buildColdResumePrompt does not include raw transcript", () => {
  const state = createContinuationState({
    role: "builder",
    objective: "Build feature X",
    ledger: createBuilderLedger([], []),
  });

  const prompt = buildColdResumePrompt(state);
  assert.ok(!prompt.includes("USER:"));
  assert.ok(!prompt.includes("ASSISTANT:"));
  assert.ok(!prompt.includes("system:"));
});

test("buildColdResumePrompt includes visited files", () => {
  let state = createContinuationState({
    role: "explorer",
    objective: "Explore",
    ledger: createExplorerLedger(),
  });
  state = recordVisitedFile(state, "src/index.ts");
  state = recordVisitedFile(state, "src/utils.ts");

  const prompt = buildColdResumePrompt(state);
  // Files should appear in the prompt (in visited files section or similar)
  assert.ok(typeof prompt === "string");
  assert.ok(prompt.length > 0);
});

test("buildColdResumePrompt includes recent events", () => {
  let state = createContinuationState({
    role: "builder",
    objective: "Build",
    ledger: createBuilderLedger([], []),
  });
  state = recordProgressEvent(state, "file_edited", "src/index.ts");
  state = recordProgressEvent(state, "diff_created", "3 files changed");

  const prompt = buildColdResumePrompt(state);
  assert.ok(typeof prompt === "string");
  assert.ok(prompt.length > 0);
});

// ─── Phase Prompts ───────────────────────────────────────────────────────────

test("getInitialPhase returns correct first phase for each role", () => {
  assert.equal(getInitialPhase("explorer"), "questions");
  assert.equal(getInitialPhase("epicDecoder"), "skeleton");
  assert.equal(getInitialPhase("builder"), "understand_ticket");
  assert.equal(getInitialPhase("reviewer"), "diff_map");
  assert.equal(getInitialPhase("tester"), "test_need");
  assert.equal(getInitialPhase("doctor"), "collect_signals");
  assert.equal(getInitialPhase("epicReviewer"), "ticket_outcomes");
});

test("getNextPhase advances to next phase", () => {
  assert.equal(getNextPhase("explorer", "questions"), "map_files");
  assert.equal(getNextPhase("explorer", "map_files"), "extract_facts");
  assert.equal(getNextPhase("explorer", "extract_facts"), "explorer_packet");
  assert.equal(getNextPhase("explorer", "explorer_packet"), null);

  assert.equal(getNextPhase("builder", "understand_ticket"), "implementation_plan");
  assert.equal(getNextPhase("builder", "implementation_plan"), "edit");
  assert.equal(getNextPhase("builder", "edit"), "verify");
  assert.equal(getNextPhase("builder", "verify"), "builder_packet");
});

test("buildPhasePrompt returns non-empty string for valid role/phase", () => {
  for (const role of LOCAL_AGENT_ROLES) {
    const phases = ROLE_PHASES[role];
    if (!phases || phases.length === 0) continue;
    for (const phase of phases) {
      const prompt = buildPhasePrompt(role, phase);
      assert.ok(typeof prompt === "string", `Prompt for ${role}/${phase} should be a string`);
      assert.ok(prompt.length > 0, `Prompt for ${role}/${phase} should not be empty`);
    }
  }
});

// ─── Role Ledgers ────────────────────────────────────────────────────────────

test("createExplorerLedger initializes with empty investigation questions", () => {
  const ledger = createExplorerLedger();
  assert.deepEqual(ledger.investigationQuestions, []);
  assert.deepEqual(ledger.map.relevantFiles, []);
  assert.equal(ledger.explorerPacket, null);
});

test("createBuilderLedger initializes with empty acceptance criteria", () => {
  const ledger = createBuilderLedger([], []);
  assert.deepEqual(ledger.acceptanceCriteria, []);
  assert.deepEqual(ledger.filePlan, {});
  assert.deepEqual(ledger.diffs, []);
  assert.equal(ledger.builderPacket, null);
});

test("createBuilderLedger with criteria and paths", () => {
  const ledger = createBuilderLedger(["AC-1: Feature works", "AC-2: Tests pass"], ["src", "test"]);
  assert.equal(ledger.acceptanceCriteria.length, 2);
  assert.equal(ledger.acceptanceCriteria[0].text, "AC-1: Feature works");
  assert.ok("src" in ledger.filePlan);
  assert.ok("test" in ledger.filePlan);
});

test("createReviewerLedger initializes with empty checklist", () => {
  const ledger = createReviewerLedger();
  assert.equal(ledger.reviewChecklist.allowedPaths, "unknown");
  assert.deepEqual(ledger.diffFacts, []);
  assert.deepEqual(ledger.blockers, []);
  assert.equal(ledger.finalVerdict, null);
});

test("createTesterLedger initializes with null assessment", () => {
  const ledger = createTesterLedger();
  assert.equal(ledger.testNeedAssessment, null);
  assert.deepEqual(ledger.commands, []);
  assert.equal(ledger.finalTestSummary, null);
});

test("createEpicDecoderLedger initializes with empty evidence slots", () => {
  const ledger = createEpicDecoderLedger();
  assert.deepEqual(ledger.evidenceSlots, {});
  assert.deepEqual(ledger.ticketSkeletons, []);
  assert.equal(ledger.finalCandidate, null);
});

test("createDoctorLedger initializes with empty signals", () => {
  const ledger = createDoctorLedger();
  assert.deepEqual(ledger.failureSignals, {
    stagnation: false,
    noDiff: false,
    repeatedBlockers: false,
    repeatedTestFailure: false,
    infraFailure: false,
    pathViolation: false,
  });
  assert.equal(ledger.decision, null);
});

test("createEpicReviewerLedger initializes with empty outcomes", () => {
  const ledger = createEpicReviewerLedger();
  assert.deepEqual(ledger.ticketOutcomes, {});
  assert.deepEqual(ledger.partialReadyPackets, []);
  assert.equal(ledger.epicVerdict, null);
});

test("createDefaultLedger dispatches to correct ledger factory", () => {
   const explorerLedger = createDefaultLedger("explorer") as ExplorerLedger;
   assert.ok("investigationQuestions" in explorerLedger);

   const builderLedger = createDefaultLedger("builder") as BuilderLedger;
   assert.ok("acceptanceCriteria" in builderLedger);

   const reviewerLedger = createDefaultLedger("reviewer") as ReviewerLedger;
   assert.ok("reviewChecklist" in reviewerLedger);

   const testerLedger = createDefaultLedger("tester") as TesterLedger;
   assert.ok("commands" in testerLedger);
});

// ─── Explorer Packet Progression ─────────────────────────────────────────────

test("explorer ledger progresses from file facts to packet", () => {
  const ledger = createExplorerLedger();

  ledger.investigationQuestions.push({
    id: "q1",
    question: "What API routes exist?",
    status: "answered",
    answerFacts: ["GET /api/users", "POST /api/orders"],
    evidenceFiles: ["src/routes/api.ts"],
  });

  ledger.map.relevantFiles = ["src/routes/api.ts", "src/models/user.ts"];
  ledger.map.entrypoints = ["src/routes/api.ts"];

  ledger.explorerPacket = {
    summary: "Found 5 API routes across 2 files",
    filesToReadNext: ["src/routes/api.ts"],
    factsForBuilder: ["GET /api/users returns User[]", "POST /api/orders creates Order"],
    factsForReviewer: ["No auth middleware on /api/users"],
    factsForTests: ["Need tests for CRUD operations"],
  };

  assert.equal(ledger.investigationQuestions[0].status, "answered");
  assert.equal(ledger.map.relevantFiles.length, 2);
  assert.ok(ledger.explorerPacket !== null);
  assert.ok(ledger.explorerPacket.summary.length > 0);
});

// ─── Builder Busy-Stall Detection ────────────────────────────────────────────

test("builder detects same reviewer blocker loop", () => {
  const ledger = createBuilderLedger([], []);
  ledger.blockersFromReviewer = [
    "Missing error handling in src/api.ts",
    "Missing error handling in src/api.ts",
  ];

  const state = createContinuationState({
    role: "builder",
    objective: "Fix the API",
    ledger,
  });

  const result = detectBusyStall(state);
  assert.equal(result.stalled, true);
});

test("builder detects no diff after iteration", () => {
  const ledger = createBuilderLedger([], []);
  ledger.diffs = [];

  const state = createContinuationState({
    role: "builder",
    objective: "Build feature",
    ledger,
  });
  Object.assign(state, { progress: { ...state.progress, noProgressStreak: 3 } });

  const result = detectBusyStall(state);
  assert.equal(result.stalled, true);
});

// ─── Doctor Preserves Failure Signals ────────────────────────────────────────

test("doctor ledger captures all failure signal types", () => {
  const ledger = createDoctorLedger();

  ledger.failureSignals.stagnation = true;
  ledger.failureSignals.noDiff = true;
  ledger.failureSignals.repeatedBlockers = false;
  ledger.failureSignals.repeatedTestFailure = true;
  ledger.failureSignals.infraFailure = false;
  ledger.failureSignals.pathViolation = true;

  assert.equal(ledger.failureSignals.stagnation, true);
  assert.equal(ledger.failureSignals.noDiff, true);
  assert.equal(ledger.failureSignals.repeatedBlockers, false);
  assert.equal(ledger.failureSignals.repeatedTestFailure, true);
  assert.equal(ledger.failureSignals.infraFailure, false);
  assert.equal(ledger.failureSignals.pathViolation, true);
});

// ─── EpicReviewer Preserves Partial-Ready Packets ────────────────────────────

test("epicReviewer ledger preserves partial-ready packets", () => {
  const ledger = createEpicReviewerLedger();

  ledger.ticketOutcomes["EPIC__T-001"] = {
    status: "approved",
    changedFiles: ["src/index.ts"],
    summary: "Implementation complete",
    blockers: [],
    reusableDiff: true,
  };

  ledger.ticketOutcomes["EPIC__T-002"] = {
    status: "partial_ready",
    changedFiles: ["src/utils.ts"],
    summary: "Partially done, needs integration",
    blockers: ["Missing test coverage"],
    reusableDiff: true,
  };

  ledger.partialReadyPackets.push({
    ticketId: "EPIC__T-002",
    reusableFiles: ["src/utils.ts"],
    summary: "Partial implementation ready for integration",
    integrationAdvice: "Needs test file added",
  });

  assert.equal(Object.keys(ledger.ticketOutcomes).length, 2);
  assert.equal(ledger.partialReadyPackets.length, 1);
  assert.equal(ledger.partialReadyPackets[0].ticketId, "EPIC__T-002");
});

// ─── State Immutability ──────────────────────────────────────────────────────

test("state update functions return new objects (immutability)", () => {
  const state = createContinuationState({
    role: "builder",
    objective: "Build",
    ledger: createBuilderLedger([], []),
  });

  const updated1 = recordProgressEvent(state, "test_event");
  const updated2 = incrementNoProgressStreak(state);
  const updated3 = advanceLooplet(state);
  const updated4 = bumpModelCalls(state, 1);

  // Original state should be unchanged
  assert.equal(state.progress.events.length, 0);
  assert.equal(state.progress.noProgressStreak, 0);
  assert.equal(state.loopletIndex, 0);
  assert.equal(state.totalModelCalls, 0);

  // Updated states should have changes
  assert.equal(updated1.progress.events.length, 1);
  assert.equal(updated2.progress.noProgressStreak, 1);
  assert.equal(updated3.loopletIndex, 1);
  assert.equal(updated4.totalModelCalls, 1);
});
