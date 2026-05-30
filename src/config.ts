import path from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { AgentRole, CommandCatalog } from "./types.ts";

export type AppConfig = {
  dataDir: string;
  dbPath: string;
  artifactsDir: string;
  workspacesDir: string;
  publicDir: string;
  uiDistDir: string;
  repoRoot: string;
  apiPort: number;
  workerPollMs: number;
  workerConcurrency: number;
  staleRunAfterMs: number;
  staleCoderRunAfterMs: number;
  staleRunMaxRecoveries: number;
  leaseTtlMs: number;
  workspaceRetentionHours: number;
  localOnly: boolean;
  dryRun: boolean;
  useLangGraph: boolean;
  useExplorerCoderPipeline: boolean;
  commandCatalog: CommandCatalog;
  models: Record<AgentRole, string>;
  playwrightDevServerCommand: string;
  playwrightDevServerUrl: string;
  playwrightDevServerReadyMs: number;
  reviewerMode: "off" | "direct-fast" | "mediated-deep";
  reviewGuardEnabled: boolean;
  reviewFastTimeoutMs: number;
  reviewDeepTimeoutMs: number;
  reviewContractPath: string;
  toolRagEnabled: boolean;
  toolRagMaxChunks: number;
  toolRagMaxTokens: number;
  toolRagIncludePlaybooks: boolean;
  toolRagIncludeRepairHintsOnFirstAttempt: boolean;
};

export type WorkspaceConfig = {
  targetDir?: string;
  role?: string;
  modelId?: string;
  remoteOverrideEnabled?: boolean;
  epicDecoderKnowledge?: Partial<KnowledgePipelineConfig>;
  [key: string]: unknown;
};

export type PlannerProfile = "small-local" | "medium-local" | "remote-strong";

export type KnowledgePipelineConfig = {
  enableKnowledgePipeline: boolean;
  enableRemoteKnowledgeRefresh: boolean;
  enableModelBackedHardener: boolean;
  enableModelBackedJudge: boolean;
  enableModelBackedRepair: boolean;
  strictModelPlanningStages: boolean;
  remoteOverrideForMissingKnowledge: boolean;
  allowDeterministicPlanningFallback: boolean;
  approvedEpicRefreshInterval: number;
  remoteKnowledgeModel: string;
  plannerProfile: PlannerProfile;
  requireFreshKnowledgeForLargeEpics: boolean;
  maxKnowledgeArtifactSize: number;
  maxSelectedKnowledgeTokens: number;
  refreshOnPlannerFailureThreshold: number;
  refreshOnUnknownDomain: boolean;
  keepKnowledgeHistoryCount: number;
  allowRawRepoContext: boolean;
  requireTicketHardener: boolean;
  requireDecompositionJudge: boolean;
  smallLocalPlannerTargetTokens: number;
  mediumLocalPlannerTargetTokens: number;
  remoteStrongPlannerTargetTokens: number;
  repairAttemptLimit: number;
};

export function getModelsFilePath(): string {
  return path.resolve(process.cwd(), "config", "agent-models.json");
}

export function getWorkspaceConfigPath(): string {
  return path.resolve(process.cwd(), "config", "workspace.json");
}

export function readModelsFile(): Record<AgentRole, string> {
  const filePath = getModelsFilePath();
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<AgentRole, string>;
}

export function writeModelsFile(models: Record<AgentRole, string>): void {
  writeFileSync(getModelsFilePath(), `${JSON.stringify(models, null, 2)}\n`, "utf8");
}

export function readWorkspaceConfig(): WorkspaceConfig {
  const filePath = getWorkspaceConfigPath();
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as WorkspaceConfig;
  } catch {
    return {};
  }
}

export function writeWorkspaceConfig(config: WorkspaceConfig): WorkspaceConfig {
  writeFileSync(getWorkspaceConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  return resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

export function resolveConstrainedTargetDir(targetDir?: string, workspaceConfig: WorkspaceConfig = readWorkspaceConfig()): string {
  const configuredRoot = typeof workspaceConfig.targetDir === "string" && workspaceConfig.targetDir.trim().length > 0
    ? path.resolve(workspaceConfig.targetDir)
    : null;
  const requested = path.resolve(targetDir || configuredRoot || process.cwd());

  if (process.env.DISABLE_TARGET_DIR_CONSTRAINT === "1") {
    return requested;
  }

  if (configuredRoot && !isWithinRoot(configuredRoot, requested)) {
    throw new Error(`Target directory must stay inside configured workspace root: ${configuredRoot}`);
  }

  return requested;
}

export function normalizeWorkspaceConfigPatch(patch: Partial<WorkspaceConfig>): Partial<WorkspaceConfig> {
  const nextPatch: Partial<WorkspaceConfig> = { ...patch };
  if (typeof nextPatch.targetDir === "string") {
    const resolved = path.resolve(nextPatch.targetDir);
    const stat = statSync(resolved, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      throw new Error(`Configured targetDir does not exist or is not a directory: ${resolved}`);
    }
    nextPatch.targetDir = resolved;
  }
  return nextPatch;
}

export function updateWorkspaceConfig(patch: Partial<WorkspaceConfig>): WorkspaceConfig {
  const next = { ...readWorkspaceConfig(), ...normalizeWorkspaceConfigPatch(patch) };
  return writeWorkspaceConfig(next);
}

export function updateAgentModel(role: AgentRole, model: string): Record<AgentRole, string> {
  const models = readModelsFile();
  models[role] = model;
  writeModelsFile(models);
  return models;
}

export function resolveKnowledgePipelineConfig(workspaceConfig: WorkspaceConfig = readWorkspaceConfig()): KnowledgePipelineConfig {
  const raw = typeof workspaceConfig.epicDecoderKnowledge === "object" && workspaceConfig.epicDecoderKnowledge
    ? workspaceConfig.epicDecoderKnowledge
    : {};
  const defaultPlannerProfile: PlannerProfile = workspaceConfig.remoteOverrideEnabled ? "remote-strong" : "small-local";
  const plannerProfile = raw.plannerProfile === "small-local" || raw.plannerProfile === "medium-local" || raw.plannerProfile === "remote-strong"
    ? raw.plannerProfile
    : defaultPlannerProfile;

  return {
    enableKnowledgePipeline: raw.enableKnowledgePipeline ?? true,
    enableRemoteKnowledgeRefresh: raw.enableRemoteKnowledgeRefresh ?? true,
    enableModelBackedHardener: raw.enableModelBackedHardener ?? true,
    enableModelBackedJudge: raw.enableModelBackedJudge ?? true,
    enableModelBackedRepair: raw.enableModelBackedRepair ?? true,
    strictModelPlanningStages: raw.strictModelPlanningStages ?? true,
    remoteOverrideForMissingKnowledge: raw.remoteOverrideForMissingKnowledge ?? true,
    allowDeterministicPlanningFallback: raw.allowDeterministicPlanningFallback ?? false,
    approvedEpicRefreshInterval: Number(raw.approvedEpicRefreshInterval ?? 10),
    remoteKnowledgeModel: String(raw.remoteKnowledgeModel ?? "zai:glm-5.1"),
    plannerProfile,
    requireFreshKnowledgeForLargeEpics: raw.requireFreshKnowledgeForLargeEpics ?? false,
    maxKnowledgeArtifactSize: Number(raw.maxKnowledgeArtifactSize ?? 24_000),
    maxSelectedKnowledgeTokens: Number(raw.maxSelectedKnowledgeTokens ?? 6_000),
    refreshOnPlannerFailureThreshold: Number(raw.refreshOnPlannerFailureThreshold ?? 3),
    refreshOnUnknownDomain: raw.refreshOnUnknownDomain ?? true,
    keepKnowledgeHistoryCount: Number(raw.keepKnowledgeHistoryCount ?? 5),
    allowRawRepoContext: raw.allowRawRepoContext ?? false,
    requireTicketHardener: raw.requireTicketHardener ?? true,
    requireDecompositionJudge: raw.requireDecompositionJudge ?? true,
    smallLocalPlannerTargetTokens: Number(raw.smallLocalPlannerTargetTokens ?? 6_000),
    mediumLocalPlannerTargetTokens: Number(raw.mediumLocalPlannerTargetTokens ?? 5_000),
    remoteStrongPlannerTargetTokens: Number(raw.remoteStrongPlannerTargetTokens ?? 6_000),
    repairAttemptLimit: Number(raw.repairAttemptLimit ?? 1),
  };
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
  const repoRoot = path.resolve(process.env.REPO_ROOT || process.cwd());
  const publicDir = path.resolve(process.cwd(), "src", "public");
  const uiDistDir = path.resolve(process.cwd(), "frontend-dist");

  return {
    dataDir,
    dbPath: path.join(dataDir, "state.db"),
    artifactsDir: path.join(dataDir, "artifacts"),
    workspacesDir: path.join(dataDir, "workspaces"),
    publicDir,
    uiDistDir,
    repoRoot,
    apiPort: Number(process.env.API_PORT || 4010),
    workerPollMs: Number(process.env.WORKER_POLL_MS || 1000),
    workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 1),
    staleRunAfterMs: Number(process.env.STALE_RUN_AFTER_MS || 60_000),
    staleCoderRunAfterMs: Number(process.env.STALE_CODER_RUN_AFTER_MS || 180_000),
    staleRunMaxRecoveries: Number(process.env.STALE_RUN_MAX_RECOVERIES || 30),
    leaseTtlMs: Number(process.env.LEASE_TTL_MS || 60_000),
    workspaceRetentionHours: Number(process.env.WORKSPACE_RETENTION_HOURS || 48),
    localOnly: process.env.LOCAL_ONLY === "1",
    dryRun: process.env.DRY_RUN === "1",
    useLangGraph: process.env.USE_LANGGRAPH !== "0",
    useExplorerCoderPipeline: true,
    commandCatalog: {
      status: process.env.STATUS_COMMAND || "git status --short",
      test: process.env.TEST_COMMAND || "npm test",
      lint: process.env.LINT_COMMAND || "npm run lint",
      typecheck: process.env.TYPECHECK_COMMAND || "npm run typecheck",
      build: process.env.BUILD_COMMAND || "npm run build"
    },
    models: readModelsFile(),
    playwrightDevServerCommand: process.env.PLAYWRIGHT_DEV_SERVER_COMMAND || "yarn dev",
    playwrightDevServerUrl: process.env.PLAYWRIGHT_DEV_SERVER_URL || "http://localhost:3000",
    playwrightDevServerReadyMs: Number(process.env.PLAYWRIGHT_DEV_SERVER_READY_MS || 8000),
    reviewerMode: (process.env.REVIEWER_MODE === "off"
      || process.env.REVIEWER_MODE === "mediated-deep"
      || process.env.REVIEWER_MODE === "direct-fast")
      ? process.env.REVIEWER_MODE
      : "mediated-deep",
    reviewGuardEnabled: process.env.REVIEW_GUARD_ENABLED !== "0",
    reviewFastTimeoutMs: Number(process.env.REVIEW_FAST_TIMEOUT_MS || process.env.REVIEWER_TIMEOUT_MS || 300_000),
    reviewDeepTimeoutMs: Number(process.env.REVIEW_DEEP_TIMEOUT_MS || process.env.REVIEWER_TIMEOUT_MS || 420_000),
    reviewContractPath: process.env.REVIEW_CONTRACT_PATH || ".closedloop/PROJECT_STRUCTURE.md",
    toolRagEnabled: process.env.TOOL_RAG_ENABLED !== "0",
    toolRagMaxChunks: Number(process.env.TOOL_RAG_MAX_CHUNKS || 10),
    toolRagMaxTokens: Number(process.env.TOOL_RAG_MAX_TOKENS || 1000),
    toolRagIncludePlaybooks: process.env.TOOL_RAG_INCLUDE_PLAYBOOKS !== "0",
    toolRagIncludeRepairHintsOnFirstAttempt: process.env.TOOL_RAG_INCLUDE_REPAIR_ON_FIRST_ATTEMPT === "1"
  };
}
