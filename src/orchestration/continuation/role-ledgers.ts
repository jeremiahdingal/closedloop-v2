// ─── Role-specific ledger types ──────────────────────────────────────────────
// Each role gets its own ledger type that tracks domain-specific progress.

import type { AgentRole, Json } from "../../types.ts";

// ─── Explorer ────────────────────────────────────────────────────────────────

export type ExplorerInvestigationQuestion = {
  id: string;
  question: string;
  status: "open" | "partial" | "answered";
  answerFacts: string[];
  evidenceFiles: string[];
};

export type ExplorerLedger = {
  investigationQuestions: ExplorerInvestigationQuestion[];
  map: {
    relevantDomains: string[];
    relevantFiles: string[];
    entrypoints: string[];
    tests: string[];
    configs: string[];
  };
  nonRelevantFindings: string[];
  openRisks: string[];
  explorerPacket: {
    summary: string;
    filesToReadNext: string[];
    factsForBuilder: string[];
    factsForReviewer: string[];
    factsForTests: string[];
  } | null;
};

export function createExplorerLedger(): ExplorerLedger {
  return {
    investigationQuestions: [],
    map: { relevantDomains: [], relevantFiles: [], entrypoints: [], tests: [], configs: [] },
    nonRelevantFindings: [],
    openRisks: [],
    explorerPacket: null,
  };
}

// ─── Epic Decoder ────────────────────────────────────────────────────────────

export type EvidenceSlot = {
  status: "missing" | "partial" | "filled";
  files: string[];
  facts: string[];
  ticketImplications: string[];
};

export type TicketSkeleton = {
  id: string;
  responsibility: string;
  status: "skeleton" | "filled" | "needs_repair";
};

export type DependencyEdge = {
  from: string;
  to: string;
  reason: string;
};

export type EpicDecoderLedger = {
  evidenceSlots: Record<string, EvidenceSlot>;
  ticketSkeletons: TicketSkeleton[];
  dependencyGraph: DependencyEdge[];
  finalCandidate: Json | null;
};

export function createEpicDecoderLedger(): EpicDecoderLedger {
  return { evidenceSlots: {}, ticketSkeletons: [], dependencyGraph: [], finalCandidate: null };
}

// ─── Ticket Hardener ─────────────────────────────────────────────────────────

export type DraftTicket = {
  id: string;
  [key: string]: unknown;
};

export type HardeningChecklistEntry = {
  hasWhatWhereHowWhy: boolean;
  hasTestAC: boolean;
  hasAllowedPaths: boolean;
  dependenciesValid: boolean;
  scopeSmallEnough: boolean;
};

export type TicketHardenerLedger = {
  inputTickets: DraftTicket[];
  hardeningChecklist: Record<string, HardeningChecklistEntry>;
  repairedTickets: DraftTicket[];
  rejectedChanges: string[];
};

export function createTicketHardenerLedger(tickets: DraftTicket[]): TicketHardenerLedger {
  return {
    inputTickets: tickets,
    hardeningChecklist: {},
    repairedTickets: [],
    rejectedChanges: [],
  };
}

// ─── Decomposition Judge ─────────────────────────────────────────────────────

export type DecompositionJudgeLedger = {
  checks: {
    atomicity: string[];
    dependencyValidity: string[];
    testability: string[];
    localModelSuitability: string[];
    pathSpecificity: string[];
    missingResponsibilities: string[];
  };
  verdict: "approve" | "repair_required";
  repairRequests: Array<{
    ticketId?: string;
    issue: string;
    requiredFix: string;
  }>;
};

export function createDecompositionJudgeLedger(): DecompositionJudgeLedger {
  return {
    checks: {
      atomicity: [],
      dependencyValidity: [],
      testability: [],
      localModelSuitability: [],
      pathSpecificity: [],
      missingResponsibilities: [],
    },
    verdict: "approve",
    repairRequests: [],
  };
}

// ─── Ticket Repair ───────────────────────────────────────────────────────────

export type RepairRequest = {
  id: string;
  ticketId?: string;
  issue: string;
  requiredFix: string;
};

export type AppliedRepair = {
  requestId: string;
  ticketIds: string[];
  changeSummary: string;
};

export type TicketRepairLedger = {
  repairRequests: RepairRequest[];
  appliedRepairs: AppliedRepair[];
  unresolvedRepairs: string[];
  repairedGoalDecomposition: Json | null;
};

export function createTicketRepairLedger(requests: RepairRequest[]): TicketRepairLedger {
  return {
    repairRequests: requests,
    appliedRepairs: [],
    unresolvedRepairs: [],
    repairedGoalDecomposition: null,
  };
}

// ─── Builder / Coder ─────────────────────────────────────────────────────────

export type AcceptanceCriterion = {
  id: string;
  text: string;
  status: "not_started" | "implemented" | "verified" | "blocked";
  evidence: string[];
};

export type ImplementationStep = {
  stepId: string;
  description: string;
  targetFiles: string[];
  status: "planned" | "in_progress" | "done" | "blocked";
};

export type FilePlanEntry = {
  intendedChange: string;
  status: "not_read" | "read" | "edited" | "verified";
  lastHash?: string;
};

export type DiffRecord = {
  changedFiles: string[];
  summary: string;
  satisfiesCriteria: string[];
};

export type CommandRecord = {
  command: string;
  result: "pass" | "fail";
  importantOutput: string;
  errorFingerprint?: string;
};

export type BuilderPacket = {
  summary: string;
  changedFiles: string[];
  criteriaStatus: Record<string, string>;
  knownRisks: string[];
};

export type BuilderLedger = {
  acceptanceCriteria: AcceptanceCriterion[];
  implementationPlan: ImplementationStep[];
  filePlan: Record<string, FilePlanEntry>;
  diffs: DiffRecord[];
  commandHistory: CommandRecord[];
  blockersFromReviewer: string[];
  blockersFromTester: string[];
  builderPacket: BuilderPacket | null;
};

export function createBuilderLedger(criteria: string[], allowedPaths: string[]): BuilderLedger {
  return {
    acceptanceCriteria: criteria.map((text, i) => ({
      id: `AC-${i + 1}`,
      text,
      status: "not_started" as const,
      evidence: [],
    })),
    implementationPlan: [],
    filePlan: Object.fromEntries(allowedPaths.map((p) => [p, { intendedChange: "", status: "not_read" as const }])),
    diffs: [],
    commandHistory: [],
    blockersFromReviewer: [],
    blockersFromTester: [],
    builderPacket: null,
  };
}

// ─── Reviewer ────────────────────────────────────────────────────────────────

export type ReviewerChecklist = {
  allowedPaths: "pass" | "fail" | "unknown";
  acceptanceCriteria: Record<string, "pass" | "fail" | "unknown">;
  testsOrVerification: "pass" | "fail" | "unknown";
  riskLevel: "low" | "medium" | "high";
};

export type DiffFact = {
  file: string;
  changeSummary: string;
  relevantToTicket: boolean;
};

export type ReviewerBlocker = {
  id: string;
  severity: "blocking" | "suggestion";
  text: string;
  evidence: string;
  targetFile?: string;
  repeated: boolean;
};

export type ReviewerLedger = {
  reviewChecklist: ReviewerChecklist;
  diffFacts: DiffFact[];
  blockers: ReviewerBlocker[];
  finalVerdict: Json | null;
};

export function createReviewerLedger(): ReviewerLedger {
  return {
    reviewChecklist: {
      allowedPaths: "unknown",
      acceptanceCriteria: {},
      testsOrVerification: "unknown",
      riskLevel: "low",
    },
    diffFacts: [],
    blockers: [],
    finalVerdict: null,
  };
}

// ─── Tester ──────────────────────────────────────────────────────────────────

export type TestNeedAssessment = {
  score: number;
  reason: string;
  requiresTests: boolean;
};

export type CommandStatus = {
  name: string;
  status: "not_run" | "pass" | "fail";
  outputSummary: string;
  errorFingerprint?: string;
};

export type TestFailure = {
  fingerprint: string;
  type: "product_bug" | "test_bug" | "infra" | "unknown";
  affectedFiles: string[];
  suggestedNextAction: string;
};

export type TestPatchPlan = {
  file: string;
  intent: string;
  status: "planned" | "written" | "verified";
};

export type TesterLedger = {
  testNeedAssessment: TestNeedAssessment | null;
  relevantTestFiles: string[];
  commands: CommandStatus[];
  failures: TestFailure[];
  testPatchPlan: TestPatchPlan[];
  finalTestSummary: string | null;
};

export function createTesterLedger(): TesterLedger {
  return {
    testNeedAssessment: null,
    relevantTestFiles: [],
    commands: [],
    failures: [],
    testPatchPlan: [],
    finalTestSummary: null,
  };
}

// ─── Doctor ──────────────────────────────────────────────────────────────────

export type DoctorEvent = {
  node: string;
  kind: string;
  summary: string;
};

export type DoctorFailureSignals = {
  stagnation: boolean;
  noDiff: boolean;
  repeatedBlockers: boolean;
  repeatedTestFailure: boolean;
  infraFailure: boolean;
  pathViolation: boolean;
};

export type DoctorRecovery = {
  action: string;
  result: string;
};

export type DoctorLedger = {
  recentEvents: DoctorEvent[];
  failureSignals: DoctorFailureSignals;
  attemptedRecoveries: DoctorRecovery[];
  decision: Json | null;
};

export function createDoctorLedger(): DoctorLedger {
  return {
    recentEvents: [],
    failureSignals: {
      stagnation: false,
      noDiff: false,
      repeatedBlockers: false,
      repeatedTestFailure: false,
      infraFailure: false,
      pathViolation: false,
    },
    attemptedRecoveries: [],
    decision: null,
  };
}

// ─── Epic Reviewer ───────────────────────────────────────────────────────────

export type TicketOutcome = {
  status: "approved" | "failed" | "escalated" | "partial_ready";
  changedFiles: string[];
  summary: string;
  blockers: string[];
  reusableDiff: boolean;
};

export type IntegrationChecklist = {
  allCriticalTicketsResolved: boolean;
  dependenciesSatisfied: boolean;
  testsAcceptable: boolean;
  noConflictingDiffs: boolean;
  knowledgebaseReady: boolean;
};

export type PartialReadyPacket = {
  ticketId: string;
  reusableFiles: string[];
  summary: string;
  integrationAdvice: string;
};

export type EpicReviewerLedger = {
  ticketOutcomes: Record<string, TicketOutcome>;
  integrationChecklist: IntegrationChecklist;
  partialReadyPackets: PartialReadyPacket[];
  epicVerdict: Json | null;
};

export function createEpicReviewerLedger(): EpicReviewerLedger {
  return {
    ticketOutcomes: {},
    integrationChecklist: {
      allCriticalTicketsResolved: false,
      dependenciesSatisfied: false,
      testsAcceptable: false,
      noConflictingDiffs: false,
      knowledgebaseReady: false,
    },
    partialReadyPackets: [],
    epicVerdict: null,
  };
}

// ─── Knowledgebase Builder ───────────────────────────────────────────────────

export type SourceEpic = {
  epicId: string;
  title: string;
  approvedAt: string;
  changedFiles: string[];
  lessons: string[];
};

export type KnowledgeSection = {
  status: "missing" | "drafted" | "updated";
  facts: string[];
  sourceEpics: string[];
};

export type KnowledgebaseLedger = {
  sourceEpics: SourceEpic[];
  knowledgeSections: Record<string, KnowledgeSection>;
  staleKnowledge: string[];
  finalKnowledgebasePatch: string | null;
};

export function createKnowledgebaseLedger(): KnowledgebaseLedger {
  return {
    sourceEpics: [],
    knowledgeSections: {},
    staleKnowledge: [],
    finalKnowledgebasePatch: null,
  };
}

// ─── Ledger factory by role ──────────────────────────────────────────────────

export type RoleLedger =
  | { role: "explorer"; ledger: ExplorerLedger }
  | { role: "epicDecoder"; ledger: EpicDecoderLedger }
  | { role: "ticketHardener"; ledger: TicketHardenerLedger }
  | { role: "decompositionJudge"; ledger: DecompositionJudgeLedger }
  | { role: "ticketRepair"; ledger: TicketRepairLedger }
  | { role: "builder"; ledger: BuilderLedger }
  | { role: "reviewer"; ledger: ReviewerLedger }
  | { role: "tester"; ledger: TesterLedger }
  | { role: "doctor"; ledger: DoctorLedger }
  | { role: "epicReviewer"; ledger: EpicReviewerLedger }
  | { role: "knowledgebaseBuilder"; ledger: KnowledgebaseLedger };

export function createDefaultLedger(role: LocalAgentRole, extra?: unknown): unknown {
  switch (role) {
    case "explorer": return createExplorerLedger();
    case "epicDecoder": return createEpicDecoderLedger();
    case "ticketHardener": return createTicketHardenerLedger((extra as DraftTicket[]) ?? []);
    case "decompositionJudge": return createDecompositionJudgeLedger();
    case "ticketRepair": return createTicketRepairLedger((extra as RepairRequest[]) ?? []);
    case "builder": {
      const bExtra = extra as { criteria?: string[]; allowedPaths?: string[] } | undefined;
      return createBuilderLedger(bExtra?.criteria ?? [], bExtra?.allowedPaths ?? []);
    }
    case "reviewer": return createReviewerLedger();
    case "tester": return createTesterLedger();
    case "doctor": return createDoctorLedger();
    case "epicReviewer": return createEpicReviewerLedger();
    case "knowledgebaseBuilder": return createKnowledgebaseLedger();
  }
}

// Import LocalAgentRole from agent-state
import type { LocalAgentRole } from "./agent-state.ts";
