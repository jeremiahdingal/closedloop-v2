import { loadConfig, readWorkspaceConfig, type KnowledgePipelineConfig } from "../config.ts";
import type { AppDatabase } from "../db/database.ts";
import type { AgentStreamPayload, EpicRecord, GoalDecomposition, GoalTicketPlan } from "../types.ts";
import { nowIso } from "../utils.ts";
import { ticketHardenerPrompt, decompositionJudgePrompt, ticketRepairPrompt } from "./prompts.ts";
import type { ModelGateway } from "./models.ts";
import { MediatedAgentHarnessGateway } from "./models.ts";
import { hardenTickets } from "./knowledge/hardener.ts";
import { judgeDecomposition } from "./knowledge/judge.ts";
import { KnowledgebaseService } from "./knowledge/knowledgebase.ts";
import { repairTickets } from "./knowledge/repair.ts";
import { selectKnowledgeSlice } from "./knowledge/selector.ts";
import type {
  DecoderPlanningMetadata,
  DecompositionJudgement,
  ModelDecompositionJudgement,
  SelectedKnowledgeSlice,
} from "./knowledge/types.ts";
import { resolveRuntimeProfile } from "../runtime-profile.ts";

function buildKnowledgePrompt(epic: EpicRecord, selectedKnowledge: SelectedKnowledgeSlice, retryNote?: string | null, assetContext?: string): string {
  const sections = [
    "You are the Epic Decoder working from curated cached repo knowledge.",
    "Use the selected knowledge below instead of assuming the full repo state.",
    "Produce draft tickets only. Tickets will be hardened and judged before builders see them.",
    "Split work by responsibility, not by arbitrary chunks.",
    "Avoid broad tickets like 'implement everything' or 'make it work'.",
    `Planner profile: ${selectedKnowledge.plannerProfile}`,
    `Knowledge freshness: ${selectedKnowledge.freshnessState}`,
    `Fallback mode: ${selectedKnowledge.fallbackMode}`,
    `Context budget limit: ${selectedKnowledge.budgetLimit} tokens`,
    "",
    ...selectedKnowledge.sections.map((section) => `## ${section.title}\n${section.content}`),
    "",
    "Return JSON only with fields: summary, tickets, clarificationQuestions(optional).",
    "Every ticket must include id, title, description, acceptanceCriteria, dependencies, allowedPaths, and priority.",
    `Epic Title: ${epic.title}`,
    `Epic Goal: ${epic.goalText}`,
  ];
  if (retryNote) sections.push(retryNote);
  if (assetContext) sections.push(assetContext);
  return sections.join("\n\n");
}

function inferRelevantMemoryLines(lines: string[], epic: EpicRecord): string[] {
  const haystack = `${epic.title} ${epic.goalText}`.toLowerCase();
  return lines.filter((line) => line.toLowerCase().split(/\s+/u).some((word) => word.length > 4 && haystack.includes(word)));
}

function selectPlanningGateway(gateway: ModelGateway, selectedKnowledge: SelectedKnowledgeSlice, config: KnowledgePipelineConfig): { planningGateway: ModelGateway; usedRemoteFallbackForPlanning: boolean; effectiveFallbackState: SelectedKnowledgeSlice["fallbackMode"] } {
  const workspaceConfig = readWorkspaceConfig();
  const runtimeProfile = resolveRuntimeProfile(loadConfig().models, workspaceConfig);
  const knowledgeInsufficient =
    selectedKnowledge.fallbackMode === "missing_knowledge"
    || selectedKnowledge.fallbackMode === "critical_stale";
  const useRemoteFallback =
    knowledgeInsufficient
    && config.remoteOverrideForMissingKnowledge
    && runtimeProfile.remoteOverrideEnabled;

  if (useRemoteFallback) {
    return {
      planningGateway: gateway,
      usedRemoteFallbackForPlanning: true,
      effectiveFallbackState: "remote_override_missing_knowledge",
    };
  }

  return {
    planningGateway: new MediatedAgentHarnessGateway(undefined, loadConfig().models, undefined, { applyRemoteOverride: false }),
    usedRemoteFallbackForPlanning: false,
    effectiveFallbackState: selectedKnowledge.fallbackMode,
  };
}

async function runDraftDecoder(
  gateway: ModelGateway,
  epic: EpicRecord,
  runId: string,
  prompt: string,
  db: AppDatabase,
  onStream?: (event: AgentStreamPayload) => void,
): Promise<GoalDecomposition> {
  const configuredModel = gateway.models.epicDecoder;
  if (
    gateway.runEpicDecoderInWorkspace &&
    (
      configuredModel === "codex-cli"
      || configuredModel === "qwen-cli"
      || configuredModel === "gemini-cli"
      || configuredModel.startsWith("zai:")
      || configuredModel.startsWith("anthropic-mediated:")
      || configuredModel.startsWith("mediated:")
    )
  ) {
    return gateway.runEpicDecoderInWorkspace({ cwd: epic.targetDir, prompt, runId, epicId: epic.id, db, onStream });
  }
  if (gateway.runEpicDecoderOpenCode && configuredModel.startsWith("opencode:")) {
    return gateway.runEpicDecoderOpenCode({ cwd: epic.targetDir, prompt, runId, epicId: epic.id, onStream });
  }
  return gateway.getGoalDecomposition(prompt);
}

function emitPipelineStream(
  onStream: ((event: AgentStreamPayload) => void) | undefined,
  runId: string,
  epicId: string,
  streamKind: AgentStreamPayload["streamKind"],
  content: string,
): void {
  onStream?.({
    agentRole: "epicDecoder",
    source: "orchestrator",
    streamKind,
    content,
    runId,
    epicId,
  });
}

async function runHardenerStage(
  gateway: ModelGateway,
  epic: EpicRecord,
  runId: string,
  selectedKnowledge: SelectedKnowledgeSlice,
  draftTickets: GoalTicketPlan[],
  config: KnowledgePipelineConfig,
  onStream?: (event: AgentStreamPayload) => void,
): Promise<{ tickets: GoalTicketPlan[]; mode: "llm" | "deterministic" }> {
  if (config.enableModelBackedHardener && gateway.runTicketHardener) {
    const prompt = ticketHardenerPrompt({
      epicTitle: epic.title,
      plannerProfile: config.plannerProfile,
      fallbackMode: selectedKnowledge.fallbackMode,
      knowledgeSections: selectedKnowledge.sections,
      draftTickets,
    });
    const result = await gateway.runTicketHardener({ cwd: epic.targetDir, prompt, runId, epicId: epic.id, onStream });
    return { tickets: result.tickets, mode: "llm" };
  }
  if (config.allowDeterministicPlanningFallback || !config.strictModelPlanningStages) {
    return { tickets: hardenTickets(draftTickets, selectedKnowledge), mode: "deterministic" };
  }
  throw new Error("Model-backed hardener is required but unavailable.");
}

function combineJudgements(
  tickets: GoalTicketPlan[],
  deterministicJudgement: DecompositionJudgement,
  modelJudgement: ModelDecompositionJudgement | null,
): DecompositionJudgement {
  if (!modelJudgement) return deterministicJudgement;

  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const approvedTickets: GoalTicketPlan[] = [];
  const rejectedTickets: GoalTicketPlan[] = [];
  const rejectionReasons: Record<string, string[]> = {};
  const repairSuggestions: Record<string, string[]> = {};

  for (const ticket of tickets) {
    const deterministicReasons = deterministicJudgement.rejectionReasons[ticket.id] ?? [];
    const modelReasons = modelJudgement.rejectionReasons[ticket.id] ?? [];
    const mergedReasons = [...deterministicReasons, ...modelReasons];
    const modelRejected = modelJudgement.rejectedTicketIds.includes(ticket.id);
    const deterministicRejected = deterministicJudgement.rejectedTickets.some((candidate) => candidate.id === ticket.id);
    if (!modelRejected && !deterministicRejected) {
      const approved = byId.get(ticket.id);
      if (approved) approvedTickets.push(approved);
      continue;
    }
    const rejected = byId.get(ticket.id);
    if (rejected) rejectedTickets.push(rejected);
    rejectionReasons[ticket.id] = mergedReasons;
    repairSuggestions[ticket.id] = [
      ...(deterministicJudgement.repairSuggestions[ticket.id] ?? []),
      ...(modelJudgement.repairSuggestions[ticket.id] ?? []),
    ];
  }

  const overallConfidence = Math.min(deterministicJudgement.overallConfidence, Math.round(modelJudgement.overallConfidence));
  const passed = rejectedTickets.length === 0 && deterministicJudgement.passed && overallConfidence >= 80;
  return {
    approvedTickets,
    rejectedTickets,
    rejectionReasons,
    repairSuggestions,
    overallConfidence,
    perTicketScores: deterministicJudgement.perTicketScores,
    passed,
  };
}

async function runJudgeStage(
  gateway: ModelGateway,
  epic: EpicRecord,
  runId: string,
  selectedKnowledge: SelectedKnowledgeSlice,
  tickets: GoalTicketPlan[],
  config: KnowledgePipelineConfig,
  onStream?: (event: AgentStreamPayload) => void,
): Promise<{ judgement: DecompositionJudgement; mode: "llm" | "deterministic" }> {
  const deterministicJudgement = judgeDecomposition(tickets, config.plannerProfile);
  if (config.enableModelBackedJudge && gateway.runDecompositionJudge) {
    const prompt = decompositionJudgePrompt({
      epicTitle: epic.title,
      plannerProfile: config.plannerProfile,
      fallbackMode: selectedKnowledge.fallbackMode,
      knowledgeSections: selectedKnowledge.sections,
      tickets,
    });
    const modelJudgement = await gateway.runDecompositionJudge({ cwd: epic.targetDir, prompt, runId, epicId: epic.id, onStream });
    return { judgement: combineJudgements(tickets, deterministicJudgement, modelJudgement), mode: "llm" };
  }
  if (config.allowDeterministicPlanningFallback || !config.strictModelPlanningStages) {
    return { judgement: deterministicJudgement, mode: "deterministic" };
  }
  throw new Error("Model-backed decomposition judge is required but unavailable.");
}

async function runRepairStage(
  gateway: ModelGateway,
  epic: EpicRecord,
  runId: string,
  selectedKnowledge: SelectedKnowledgeSlice,
  judgement: DecompositionJudgement,
  config: KnowledgePipelineConfig,
  onStream?: (event: AgentStreamPayload) => void,
): Promise<{ tickets: GoalTicketPlan[]; mode: "llm" | "deterministic" }> {
  if (config.enableModelBackedRepair && gateway.runTicketRepair) {
    const prompt = ticketRepairPrompt({
      epicTitle: epic.title,
      plannerProfile: config.plannerProfile,
      fallbackMode: selectedKnowledge.fallbackMode,
      knowledgeSections: selectedKnowledge.sections,
      rejectedTickets: judgement.rejectedTickets,
      rejectionReasons: judgement.rejectionReasons,
      repairSuggestions: judgement.repairSuggestions,
    });
    const result = await gateway.runTicketRepair({ cwd: epic.targetDir, prompt, runId, epicId: epic.id, onStream });
    return { tickets: result.tickets, mode: "llm" };
  }
  if (config.allowDeterministicPlanningFallback || !config.strictModelPlanningStages) {
    return { tickets: repairTickets(judgement, selectedKnowledge), mode: "deterministic" };
  }
  throw new Error("Model-backed repair is required but unavailable.");
}

export async function decodeEpicWithKnowledgePipeline(input: {
  epic: EpicRecord;
  runId: string;
  gateway: ModelGateway;
  db: AppDatabase;
  config: KnowledgePipelineConfig;
  compact: boolean;
  retryNote?: string | null;
  onStream?: (event: AgentStreamPayload) => void;
}): Promise<GoalDecomposition> {
  const { epic, runId, gateway, db, config, compact, retryNote } = input;
  const knowledgebase = new KnowledgebaseService();
  if (!config.enableKnowledgePipeline || compact) {
    throw new Error("Knowledge pipeline bypass requested.");
  }

  const status = await knowledgebase.getStatus(epic.targetDir);
  const freshness = await knowledgebase.getFreshness(epic.targetDir, config);
  emitPipelineStream(input.onStream, runId, epic.id, "status", `Knowledge status: available=${status.available} valid=${status.valid} freshness=${freshness.state}`);

  const snapshot = await knowledgebase.loadCurrent(epic.targetDir);
  const recentMemory = (await knowledgebase.readEpicMemory(epic.targetDir, 10)).map((entry) => `${entry.epicTitle}: ${entry.summary}`);
  const selectedKnowledge = selectKnowledgeSlice({
    epic,
    snapshot,
    freshness,
    plannerProfile: config.plannerProfile,
    maxSelectedKnowledgeTokens: config.maxSelectedKnowledgeTokens,
    recentMemorySections: inferRelevantMemoryLines(recentMemory, epic),
  });
  emitPipelineStream(input.onStream, runId, epic.id, "status", `Selected ${selectedKnowledge.sections.length} knowledge sections (${selectedKnowledge.estimatedTokens}/${selectedKnowledge.budgetLimit} tokens).`);

  const { planningGateway, usedRemoteFallbackForPlanning, effectiveFallbackState } = selectPlanningGateway(gateway, selectedKnowledge, config);

  if (freshness.state === "critical_stale" && config.requireFreshKnowledgeForLargeEpics && !usedRemoteFallbackForPlanning) {
    await knowledgebase.recordPlannerFailure(epic.targetDir);
    throw new Error("Knowledgebase is critically stale and fresh knowledge is required for this epic.");
  }

  const prompt = buildKnowledgePrompt(epic, {
    ...selectedKnowledge,
    fallbackMode: effectiveFallbackState,
  }, retryNote);

  let draftPlan: GoalDecomposition;
  try {
    draftPlan = await runDraftDecoder(planningGateway, epic, runId, prompt, db, input.onStream);
  } catch (error) {
    await knowledgebase.recordPlannerFailure(epic.targetDir);
    throw error;
  }

  emitPipelineStream(input.onStream, runId, epic.id, "status", `Draft planner produced ${draftPlan.tickets.length} ticket(s).`);

  const hardened = await runHardenerStage(planningGateway, epic, runId, selectedKnowledge, draftPlan.tickets, config, input.onStream);
  emitPipelineStream(input.onStream, runId, epic.id, "status", `Hardened ${hardened.tickets.length} ticket(s) via ${hardened.mode}.`);

  const initialJudgementResult = await runJudgeStage(planningGateway, epic, runId, selectedKnowledge, hardened.tickets, config, input.onStream);
  emitPipelineStream(input.onStream, runId, epic.id, "status", `Initial judgement passed=${initialJudgementResult.judgement.passed} confidence=${initialJudgementResult.judgement.overallConfidence} via ${initialJudgementResult.mode}.`);

  let finalJudgement = initialJudgementResult.judgement;
  let repairAttempts = 0;
  const repairHistory: string[] = [];
  let repairMode: "llm" | "deterministic" | undefined;

  if (!initialJudgementResult.judgement.passed && config.repairAttemptLimit > 0) {
    repairAttempts = 1;
    const repaired = await runRepairStage(planningGateway, epic, runId, selectedKnowledge, initialJudgementResult.judgement, config, input.onStream);
    repairMode = repaired.mode;
    repairHistory.push(`Repaired ${initialJudgementResult.judgement.rejectedTickets.length} rejected ticket(s) at ${nowIso()} using ${repaired.mode}.`);
    const finalJudgementResult = await runJudgeStage(planningGateway, epic, runId, selectedKnowledge, repaired.tickets, config, input.onStream);
    finalJudgement = finalJudgementResult.judgement;
    emitPipelineStream(input.onStream, runId, epic.id, "status", `Repair pass complete. Final judgement passed=${finalJudgement.passed} confidence=${finalJudgement.overallConfidence}.`);
  }

  if (!finalJudgement.passed) {
    await knowledgebase.recordPlannerFailure(epic.targetDir);
    throw new Error(`Knowledge pipeline rejected the decomposition: ${Object.values(finalJudgement.rejectionReasons).flat().join("; ")}`);
  }

  const planningMetadata: DecoderPlanningMetadata = {
    pipelineEnabled: true,
    pipelineVersion: "v2",
    remoteOverrideEnabled: gateway.models.epicDecoder.startsWith("zai:"),
    usedRemoteFallbackForPlanning,
    plannerProfile: config.plannerProfile,
    knowledgebaseVersionUsed: selectedKnowledge.knowledgeVersion,
    knowledgeFreshnessState: selectedKnowledge.freshnessState,
    fallbackState: effectiveFallbackState,
    selectedKnowledgeSections: selectedKnowledge.sections.map((section) => section.title),
    includedArtifactKinds: selectedKnowledge.includedArtifactKinds,
    excludedArtifactKinds: selectedKnowledge.excludedArtifactKinds,
    contextBudgetUsed: selectedKnowledge.estimatedTokens,
    contextBudgetLimit: selectedKnowledge.budgetLimit,
    ticketQualityScores: finalJudgement.perTicketScores,
    judgePassed: finalJudgement.passed,
    judgeConfidence: finalJudgement.overallConfidence,
    rejectedTicketCount: finalJudgement.rejectedTickets.length,
    repairAttempts,
    repairHistory,
    hardenerModel: planningGateway.models.ticketHardener ?? null,
    judgeModel: planningGateway.models.decompositionJudge ?? null,
    repairModel: planningGateway.models.ticketRepair ?? null,
    hardenerMode: hardened.mode,
    judgeMode: initialJudgementResult.mode,
    repairMode,
    warnings: selectedKnowledge.warnings,
    refreshRecommendation: freshness.refreshRequired ? freshness.reasonCodes.join(", ") : null,
  };

  db.recordEvent({
    aggregateType: "epic",
    aggregateId: epic.id,
    runId,
    kind: "decoder_pipeline_complete",
    message: "Knowledge pipeline completed.",
    payload: planningMetadata,
  });

  return {
    summary: draftPlan.summary,
    tickets: finalJudgement.approvedTickets,
    clarificationQuestions: draftPlan.clarificationQuestions,
    planningMetadata,
  };
}
