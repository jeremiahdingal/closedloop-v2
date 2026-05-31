// Continuation Controls — barrel export

export type {
  LocalAgentRole,
  AgentContinuationState,
  AgentProgressEvent,
  VisitedFileEntry,
  ContinuationStallKind,
  ContinuationRecoveryAction,
} from "./agent-state.ts";

export {
  LOCAL_AGENT_ROLES,
  toLocalAgentRole,
  createContinuationState,
  recordProgressEvent,
  recordVisitedFile,
  incrementNoProgressStreak,
  resetNoProgressStreak,
  advanceLooplet,
  bumpModelCalls,
} from "./agent-state.ts";

export type { StallDetectionResult } from "./progress.ts";
export { detectBusyStall } from "./progress.ts";

export { buildColdResumePrompt } from "./resume.ts";
export { buildPhasePrompt, getInitialPhase, getNextPhase, ROLE_PHASES } from "./prompts.ts";
export { persistState, loadState, persistHandoff, stateArtifactName, draftArtifactName, handoffArtifactName } from "./persistence.ts";

export {
  runContinuableAgent,
  runContinuableBuilder,
  runContinuableExplorer,
  runContinuableReviewer,
  runContinuableTester,
  runContinuableCoder,
  runContinuableEpicDecoder,
  runContinuableGoalReview,
  runContinuableDoctor,
  runContinuableKnowledgebaseBuilder,
} from "./controller.ts";

export type { ContinuableAgentConfig, ContinuableAgentResult, GatewayMethod } from "./controller.ts";

export type {
  ExplorerLedger,
  EpicDecoderLedger,
  TicketHardenerLedger,
  DecompositionJudgeLedger,
  TicketRepairLedger,
  BuilderLedger,
  ReviewerLedger,
  TesterLedger,
  DoctorLedger,
  EpicReviewerLedger,
  KnowledgebaseLedger,
} from "./role-ledgers.ts";

export {
  createExplorerLedger,
  createEpicDecoderLedger,
  createTicketHardenerLedger,
  createDecompositionJudgeLedger,
  createTicketRepairLedger,
  createBuilderLedger,
  createReviewerLedger,
  createTesterLedger,
  createDoctorLedger,
  createEpicReviewerLedger,
  createKnowledgebaseLedger,
  createDefaultLedger,
} from "./role-ledgers.ts";
