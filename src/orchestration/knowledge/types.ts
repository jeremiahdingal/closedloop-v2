import type { GoalTicketPlan, Json } from "../../types.ts";
import type { PlannerProfile } from "../../config.ts";

export type KnowledgeArtifactKind =
  | "repo_capsule"
  | "domain_map"
  | "architecture_rules"
  | "api_contract_notes"
  | "ticket_decomposition_patterns"
  | "known_failure_modes"
  | "testing_guidance"
  | "local_model_instructions"
  | "recent_change_history"
  | "staleness_report"
  | "refresh_metadata";

export type KnowledgeArtifact = {
  kind: KnowledgeArtifactKind;
  title: string;
  content: string;
  domains: string[];
  updatedAt: string;
  source: string;
  tokenEstimate: number;
  version: string;
};

export type KnowledgeValidationReport = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  validatedAt: string;
};

export type KnowledgebaseSnapshotMetadata = {
  confidenceScore: number;
  generatedByModel: string;
  refreshReason: string;
  domainsUpdated: string[];
  approvedEpicsSinceRefresh: number;
  status: "idle" | "queued" | "running" | "completed" | "failed" | "skipped";
};

export type KnowledgebaseSnapshot = {
  version: string;
  repoRoot: string;
  commitHash: string;
  createdAt: string;
  artifacts: KnowledgeArtifact[];
  metadata: KnowledgebaseSnapshotMetadata;
  validation: KnowledgeValidationReport;
};

export type KnowledgeStatus = {
  available: boolean;
  valid: boolean;
  currentPath: string | null;
  version: string | null;
  missingArtifacts: KnowledgeArtifactKind[];
  invalidArtifacts: KnowledgeArtifactKind[];
  warnings: string[];
};

export type KnowledgeFreshnessState = "fresh" | "stale" | "critical_stale" | "missing";

export type KnowledgeFreshnessStatus = {
  state: KnowledgeFreshnessState;
  refreshRequired: boolean;
  reasonCodes: string[];
  lastRefreshCommit: string | null;
  currentCommit: string | null;
  approvedEpicsSinceRefresh: number;
  warnings: string[];
};

export type SelectedKnowledgeSection = {
  title: string;
  kind: KnowledgeArtifactKind | "epic_summary";
  content: string;
  tokenEstimate: number;
};

export type SelectedKnowledgeSlice = {
  sections: SelectedKnowledgeSection[];
  includedArtifactKinds: Array<KnowledgeArtifactKind | "epic_summary">;
  excludedArtifactKinds: KnowledgeArtifactKind[];
  includeReasons: Record<string, string>;
  estimatedTokens: number;
  budgetLimit: number;
  fallbackMode: "none" | "missing_knowledge" | "stale_knowledge" | "critical_stale" | "legacy_fallback" | "remote_override_missing_knowledge";
  freshnessState: KnowledgeFreshnessState;
  plannerProfile: PlannerProfile;
  knowledgeVersion: string | null;
  warnings: string[];
};

export type TicketReadinessDimensionScores = {
  scopeNarrowness: number;
  allowedAreaSpecificity: number;
  acceptanceCriteriaQuality: number;
  testability: number;
  dependencyClarity: number;
  localModelSuitability: number;
  riskClarity: number;
  fallbackBehavior: number;
  nonGoalClarity: number;
};

export type TicketReadinessScore = TicketReadinessDimensionScores & {
  total: number;
};

export type JudgedTicket = GoalTicketPlan & {
  nonGoals?: string[];
  riskLevel?: "low" | "medium" | "high";
  localModelNotes?: string[];
  fallbackNotes?: string[];
};

export type ModelHardenedTicketResult = {
  summary: string;
  tickets: JudgedTicket[];
};

export type ModelDecompositionJudgement = {
  approvedTicketIds: string[];
  rejectedTicketIds: string[];
  rejectionReasons: Record<string, string[]>;
  repairSuggestions: Record<string, string[]>;
  overallConfidence: number;
  notes?: string[];
};

export type ModelRepairResult = {
  summary: string;
  tickets: JudgedTicket[];
};

export type DecompositionJudgement = {
  approvedTickets: JudgedTicket[];
  rejectedTickets: JudgedTicket[];
  rejectionReasons: Record<string, string[]>;
  repairSuggestions: Record<string, string[]>;
  overallConfidence: number;
  perTicketScores: Record<string, TicketReadinessScore>;
  passed: boolean;
};

export type DecoderPlanningMetadata = {
  pipelineEnabled: boolean;
  pipelineVersion: string;
  remoteOverrideEnabled: boolean;
  usedRemoteFallbackForPlanning?: boolean;
  plannerProfile: PlannerProfile;
  knowledgebaseVersionUsed: string | null;
  knowledgeFreshnessState: KnowledgeFreshnessState;
  fallbackState: SelectedKnowledgeSlice["fallbackMode"];
  selectedKnowledgeSections: string[];
  includedArtifactKinds: Array<KnowledgeArtifactKind | "epic_summary">;
  excludedArtifactKinds: KnowledgeArtifactKind[];
  contextBudgetUsed: number;
  contextBudgetLimit: number;
  ticketQualityScores: Record<string, TicketReadinessScore>;
  judgePassed: boolean;
  judgeConfidence: number;
  rejectedTicketCount: number;
  repairAttempts: number;
  repairHistory: string[];
  hardenerModel?: string | null;
  judgeModel?: string | null;
  repairModel?: string | null;
  hardenerMode?: "llm" | "deterministic";
  judgeMode?: "llm" | "deterministic";
  repairMode?: "llm" | "deterministic";
  warnings: string[];
  refreshRecommendation: string | null;
};

export type RefreshState = {
  approvedEpicsSinceKnowledgeRefresh: number;
  lastRefreshAt: string | null;
  lastRefreshCommit: string | null;
  lastRefreshReason: string | null;
  refreshStatus: "idle" | "queued" | "running" | "completed" | "failed" | "skipped";
  lastFailureReason: string | null;
  plannerFailureCount: number;
  unknownDomainCount: number;
};

export type LocalEpicMemory = {
  epicId: string;
  epicTitle: string;
  summary: string;
  domainsTouched: string[];
  ticketCount: number;
  ticketQualityNotes: string[];
  failureModesEncountered: string[];
  importantFixes: string[];
  testsChanged: string[];
  builderIssues: string[];
  reviewerIssues: string[];
  plannerIssues: string[];
  decompositionTooBroad: boolean;
  localModelsStruggled: boolean;
  remoteOverrideEnabled: boolean;
  plannerProfile: PlannerProfile;
  knowledgeVersionUsed: string | null;
  createdAt: string;
};

export type RemoteKnowledgeRefreshOutput = {
  artifacts: KnowledgeArtifact[];
  summaryOfChanges: string;
  domainsRefreshed: string[];
  importantArchitectureRules: string[];
  updatedTicketPatterns: string[];
  knownFailureModes: string[];
  stalenessStatus: KnowledgeFreshnessState;
  warnings: string[];
  confidenceScore: number;
};

export type StagedKnowledgebase = {
  repoRoot: string;
  repoHash: string;
  refreshId: string;
  stagedPath: string;
  manifestPath: string;
  validationPath: string;
  snapshot: KnowledgebaseSnapshot;
};

export function isDecoderPlanningMetadata(value: Json | undefined): value is Json {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
