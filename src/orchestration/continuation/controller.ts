import type { AgentContinuationState, LocalAgentRole, ContinuationRecoveryAction } from "./agent-state.ts";
import {
  createContinuationState,
  recordProgressEvent,
  recordVisitedFile,
  incrementNoProgressStreak,
  resetNoProgressStreak,
  advanceLooplet,
  bumpModelCalls,
} from "./agent-state.ts";
import { detectBusyStall, type StallDetectionResult } from "./progress.ts";
import { buildColdResumePrompt } from "./resume.ts";
import { buildPhasePrompt, getNextPhase } from "./prompts.ts";
import { persistState, loadState, persistHandoff } from "./persistence.ts";
import { createDefaultLedger } from "./role-ledgers.ts";
import type { ModelGateway, StreamHook } from "../models.ts";
import type { ToolExecutionContext, MediatedHarnessEvent } from "../../mediated-agent-harness/types.ts";

// ─── Controller config ───────────────────────────────────────────────────────

export interface ContinuableAgentConfig<TLedger, TOutput> {
  role: LocalAgentRole;
  objective: string;
  ledger?: TLedger;
  ledgerInit?: unknown;
  constraints?: string[];
  allowedPaths?: string[];
  cwd: string;
  runId?: string;
  ticketId?: string;
  epicId?: string;
  workspaceId?: string;
  gateway: ModelGateway;
  gatewayMethod: GatewayMethod;
  maxLooplets?: number;
  loopletIterations?: number;
  onStream?: StreamHook;
  toolContext?: ToolExecutionContext;
  gatewayExtraArgs?: Record<string, unknown>;
}

export type GatewayMethod =
  | "runBuilderInWorkspace"
  | "runReviewerInWorkspace"
  | "runTesterInWorkspace"
  | "runExplorerInWorkspace"
  | "runCoderInWorkspace"
  | "runEpicDecoderInWorkspace"
  | "runGoalReviewInWorkspace"
  | "runTicketHardener"
  | "runDecompositionJudge"
  | "runTicketRepair";

export interface ContinuableAgentResult<TLedger, TOutput> {
  state: AgentContinuationState<TLedger, TOutput>;
  output: unknown;
  loopletCount: number;
  totalModelCalls: number;
  recoveredStalls: number;
}

// ─── Main controller ─────────────────────────────────────────────────────────

export async function runContinuableAgent<TLedger, TOutput>(
  config: ContinuableAgentConfig<TLedger, TOutput>,
): Promise<ContinuableAgentResult<TLedger, TOutput>> {
  const {
    role,
    objective,
    cwd,
    gateway,
    gatewayMethod,
    maxLooplets = 6,
    loopletIterations = 8,
    onStream,
    toolContext,
    runId: inputRunId,
  } = config;

  const runId = inputRunId ?? `cont-${role}-${Date.now()}`;

  // Try to load existing state (resume)
  let state: AgentContinuationState<TLedger, TOutput>;
  if (toolContext) {
    const loaded = await loadState<TLedger, TOutput>(role, runId, toolContext);
    if (loaded) {
      state = loaded;
      onStream?.({
        agentRole: role as any,
        source: "continuation-controller",
        streamKind: "status",
        content: `Resuming ${role} from looplet ${state.loopletIndex} (phase: ${state.phase})`,
        runId,
        sequence: 0,
        metadata: {},
      });
    } else {
      state = createNewState(config, runId);
    }
  } else {
    state = createNewState(config, runId);
  }

  let recoveredStalls = 0;

  // Run looplets
  for (let looplet = state.loopletIndex; looplet < maxLooplets; looplet++) {
    // Check for stall before each looplet
    const stallResult = detectBusyStall(state);
    if (stallResult.stalled && stallResult.action) {
      recoveredStalls++;
      state = await applyRecovery(state, stallResult, config, runId);
      onStream?.({
        agentRole: role as any,
        source: "continuation-controller",
        streamKind: "status",
        content: `Stall detected (${stallResult.kind}, streak ${stallResult.streak}). Applying recovery: ${stallResult.action.kind}.`,
        runId,
        sequence: 0,
        metadata: {},
      });
    }

    // Build the prompt for this looplet
    const phasePrompt = buildPhasePrompt(role, state.phase);
    const resumeSuffix = looplet > 0 ? "\n\n" + buildColdResumePrompt(state) : "";
    const prompt = objective + (phasePrompt ? "\n\n" + phasePrompt : "") + resumeSuffix;

    onStream?.({
      agentRole: role as any,
      source: "continuation-controller",
      streamKind: "status",
      content: `Looplet ${looplet + 1}/${maxLooplets}, phase: ${state.phase}, prompt tokens: ~${prompt.length}`,
      runId,
      sequence: 0,
      metadata: {},
    });

    // Run the model through the gateway
    let result: unknown;
    let toolCallCount = 0;
    try {
      result = await callGateway(gateway, gatewayMethod, {
        cwd,
        prompt,
        runId,
        ticketId: config.ticketId,
        epicId: config.epicId,
        ...config.gatewayExtraArgs,
        onStream: (event: any) => {
          // Track visited files and tool calls from stream events
          if (event.kind === "tool_call" && event.call?.name === "read_file") {
            const path = event.call?.args?.path ?? event.call?.args?.paths?.[0];
            if (path && typeof path === "string") {
              state = recordVisitedFile(state, path);
            }
          }
          if (event.kind === "tool_call") {
            toolCallCount++;
          }
          onStream?.(event);
        },
      });
    } catch (err) {
     // Model call failed — record and try recovery
       state = recordProgressEvent(state, "model_call_failed", err instanceof Error ? err.message : String(err));
       state = incrementNoProgressStreak(state);
       state = bumpModelCalls(state, 0) as AgentContinuationState<TLedger, TOutput>;

       // Persist state before retry
       if (toolContext) {
         await persistState(state, toolContext, looplet);
       }

       // If this is a StagnationError/LoopTimeoutError, apply cold resume for next looplet
       const errName = err?.constructor?.name;
       if (errName === "StagnationError" || errName === "LoopTimeoutError") {
         recoveredStalls++;
         state = recordProgressEvent(state, "stall_recovery_applied", errName);
         onStream?.({
           agentRole: role as any,
           source: "continuation-controller",
           streamKind: "status",
           content: `Model call stalled (${errName}). Will cold-resume next looplet.`,
           runId,
           sequence: 0,
           metadata: {},
         });
         state = advanceLooplet(state) as AgentContinuationState<TLedger, TOutput>;
         continue;
       }
       throw err;
     }

     // Update state after successful call
     state = bumpModelCalls(state, toolCallCount) as AgentContinuationState<TLedger, TOutput>;
     state = resetNoProgressStreak(state) as AgentContinuationState<TLedger, TOutput>;
     state = recordProgressEvent(state, "looplet_completed", `phase=${state.phase}, tools=${toolCallCount}`) as AgentContinuationState<TLedger, TOutput>;

    // Try to extract output from result
    if (result !== null && result !== undefined) {
      state = { ...state, draftOutput: result as TOutput };
      state = recordProgressEvent(state, "draft_output_updated");
      onStream?.({
        agentRole: role as any,
        source: "continuation-controller",
        streamKind: "status",
        content: `Draft output captured in phase ${state.phase}.`,
        runId,
        sequence: 0,
        metadata: { phase: state.phase, looplet: looplet + 1 },
      });
    }

    // Advance phase if appropriate
    const nextPhase = getNextPhase(role, state.phase);
    if (nextPhase && state.draftOutput !== null) {
      state = { ...state, phase: nextPhase };
      state = recordProgressEvent(state, "phase_advanced", nextPhase);
      onStream?.({
        agentRole: role as any,
        source: "continuation-controller",
        streamKind: "status",
        content: `Phase advanced to ${nextPhase}.`,
        runId,
        sequence: 0,
        metadata: { phase: nextPhase, looplet: looplet + 1 },
      });
    }

     // Persist checkpoint
     if (toolContext) {
       await persistState(state, toolContext, looplet);
     }

     state = advanceLooplet(state) as AgentContinuationState<TLedger, TOutput>;

    // If we have a final output, break
    if (state.draftOutput !== null && state.phase === "final_json" || isTerminalPhase(role, state.phase)) {
      break;
    }
  }

  // Persist final handoff
  if (toolContext && state.draftOutput !== null) {
    await persistHandoff(role, runId, state.draftOutput, toolContext);
  }

  onStream?.({
    agentRole: role as any,
    source: "continuation-controller",
    streamKind: "status",
    content: `Continuation complete: ${state.loopletIndex} looplets, ${state.totalModelCalls} model calls, ${recoveredStalls} stall recoveries.`,
    runId,
    sequence: 0,
    metadata: {
      loopletCount: state.loopletIndex,
      totalModelCalls: state.totalModelCalls,
      recoveredStalls,
      finalPhase: state.phase,
      hasOutput: state.draftOutput !== null,
    },
  });

  return {
    state,
    output: state.draftOutput,
    loopletCount: state.loopletIndex,
    totalModelCalls: state.totalModelCalls,
    recoveredStalls,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createNewState<TLedger, TOutput>(
  config: ContinuableAgentConfig<TLedger, TOutput>,
  runId: string,
): AgentContinuationState<TLedger, TOutput> {
  const { role, objective, constraints, allowedPaths, ledger, ledgerInit } = config;
  const effectiveLedger = ledger ?? createDefaultLedger(role, ledgerInit) as TLedger;
  return createContinuationState<TLedger, TOutput>({
    role,
    objective,
    ledger: effectiveLedger,
    constraints,
    allowedPaths,
    epicId: config.epicId,
    ticketId: config.ticketId,
    runId,
    workspaceId: config.workspaceId,
  });
}

async function callGateway(
   gateway: ModelGateway,
   method: GatewayMethod,
   input: Record<string, unknown>,
 ): Promise<unknown> {
   if (typeof (gateway as any)[method] !== "function") {
     throw new Error(`Gateway method ${method} not available`);
   }
   const args: Record<string, unknown> = {};
   for (const [key, value] of Object.entries(input)) {
     if (value !== undefined) {
       args[key] = value;
     }
   }
   return (gateway as any)[method](args);
 }

async function applyRecovery<TLedger, TOutput>(
   state: AgentContinuationState<TLedger, TOutput>,
   stall: StallDetectionResult,
   config: ContinuableAgentConfig<TLedger, TOutput>,
   runId: string,
 ): Promise<AgentContinuationState<TLedger, TOutput>> {
   const action = stall.action!;

   state = recordProgressEvent(state, "recovery_applied", `${stall.kind} → ${action.kind}`) as AgentContinuationState<TLedger, TOutput>;

   switch (action.kind) {
     case "cold_resume":
       // State is preserved; the next looplet will use buildColdResumePrompt
       return incrementNoProgressStreak(state) as AgentContinuationState<TLedger, TOutput>;

     case "phase_shift":
       return { ...state, phase: action.phase, progress: { ...state.progress, noProgressStreak: 0 } } as AgentContinuationState<TLedger, TOutput>;

     case "narrow_tools":
       // Tools narrowing is handled by the role prompt — just reset streak
       return { ...state, progress: { ...state.progress, noProgressStreak: 0 } } as AgentContinuationState<TLedger, TOutput>;

     case "restore_last_good_state": {
       if (config.toolContext) {
         const loaded = await loadState<TLedger, TOutput>(state.role, runId, config.toolContext);
         if (loaded && loaded.progress.lastUsefulLooplet < state.loopletIndex) {
           return loaded as AgentContinuationState<TLedger, TOutput>;
         }
       }
       return state as AgentContinuationState<TLedger, TOutput>;
     }

     case "handoff_to_doctor":
     case "handoff_to_repair":
       // These will be handled by the orchestration layer above
       return state as AgentContinuationState<TLedger, TOutput>;

     default:
       return state as AgentContinuationState<TLedger, TOutput>;
   }
 }

function isTerminalPhase(role: LocalAgentRole, phase: string): boolean {
  const phases = {
    explorer: "explorer_packet",
    epicDecoder: "final_json",
    ticketHardener: "hardened_plan",
    decompositionJudge: "verdict",
    ticketRepair: "repaired_plan",
    builder: "builder_packet",
    reviewer: "verdict",
    tester: "test_summary",
    doctor: "choose_recovery",
    epicReviewer: "epic_verdict",
    knowledgebaseBuilder: "emit_patch",
  };
  return phases[role] === phase;
}

// ─── Convenience wrappers ────────────────────────────────────────────────────

export async function runContinuableBuilder(input: {
  ticketId: string;
  epicId: string;
  runId: string;
  cwd: string;
  prompt: string;
  criteria: string[];
  allowedPaths: string[];
  gateway: ModelGateway;
  onStream?: StreamHook;
  toolContext?: ToolExecutionContext;
}): Promise<ContinuableAgentResult<import("./role-ledgers.ts").BuilderLedger, unknown>> {
  return runContinuableAgent<import("./role-ledgers.ts").BuilderLedger, unknown>({
    role: "builder",
    objective: input.prompt,
    ledgerInit: { criteria: input.criteria, allowedPaths: input.allowedPaths },
    allowedPaths: input.allowedPaths,
    cwd: input.cwd,
    runId: input.runId,
    ticketId: input.ticketId,
    epicId: input.epicId,
    gateway: input.gateway,
    gatewayMethod: "runBuilderInWorkspace",
    onStream: input.onStream,
    toolContext: input.toolContext,
  });
}

export async function runContinuableExplorer(input: {
  ticketId: string;
  epicId: string;
  runId: string;
  cwd: string;
  prompt: string;
  gateway: ModelGateway;
  onStream?: StreamHook;
  toolContext?: ToolExecutionContext;
}): Promise<ContinuableAgentResult<import("./role-ledgers.ts").ExplorerLedger, string>> {
  return runContinuableAgent<import("./role-ledgers.ts").ExplorerLedger, string>({
    role: "explorer",
    objective: input.prompt,
    cwd: input.cwd,
    runId: input.runId,
    ticketId: input.ticketId,
    epicId: input.epicId,
    gateway: input.gateway,
    gatewayMethod: "runExplorerInWorkspace",
    onStream: input.onStream,
    toolContext: input.toolContext,
  });
}

export async function runContinuableReviewer(input: {
  ticketId: string;
  epicId: string;
  runId: string;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  gateway: ModelGateway;
  onStream?: StreamHook;
  toolContext?: ToolExecutionContext;
}): Promise<ContinuableAgentResult<import("./role-ledgers.ts").ReviewerLedger, unknown>> {
  return runContinuableAgent<import("./role-ledgers.ts").ReviewerLedger, unknown>({
    role: "reviewer",
    objective: input.prompt,
    cwd: input.cwd,
    runId: input.runId,
    ticketId: input.ticketId,
    epicId: input.epicId,
    gateway: input.gateway,
    gatewayMethod: "runReviewerInWorkspace",
    onStream: input.onStream,
    toolContext: input.toolContext,
    gatewayExtraArgs: input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : undefined,
  });
}

export async function runContinuableTester(input: {
  ticketId: string;
  epicId: string;
  runId: string;
  cwd: string;
  prompt: string;
  gateway: ModelGateway;
  onStream?: StreamHook;
  toolContext?: ToolExecutionContext;
}): Promise<ContinuableAgentResult<import("./role-ledgers.ts").TesterLedger, unknown>> {
  return runContinuableAgent<import("./role-ledgers.ts").TesterLedger, unknown>({
    role: "tester",
    objective: input.prompt,
    cwd: input.cwd,
    runId: input.runId,
    ticketId: input.ticketId,
    epicId: input.epicId,
    gateway: input.gateway,
    gatewayMethod: "runTesterInWorkspace",
    onStream: input.onStream,
    toolContext: input.toolContext,
  });
}

export async function runContinuableCoder(input: {
  ticketId: string;
  epicId: string;
  runId: string;
  cwd: string;
  prompt: string;
  skipExplorer?: boolean;
  gateway: ModelGateway;
  onStream?: StreamHook;
  toolContext?: ToolExecutionContext;
}): Promise<ContinuableAgentResult<import("./role-ledgers.ts").BuilderLedger, unknown>> {
  return runContinuableAgent<import("./role-ledgers.ts").BuilderLedger, unknown>({
    role: "builder",
    objective: input.prompt,
    cwd: input.cwd,
    runId: input.runId,
    ticketId: input.ticketId,
    epicId: input.epicId,
    gateway: input.gateway,
    gatewayMethod: "runCoderInWorkspace",
    onStream: input.onStream,
    toolContext: input.toolContext,
    gatewayExtraArgs: input.skipExplorer !== undefined ? { skipExplorer: input.skipExplorer } : undefined,
  });
}

export async function runContinuableEpicDecoder(input: {
  epicId: string;
  runId?: string | null;
  cwd: string;
  prompt: string;
  gateway: ModelGateway;
  onStream?: StreamHook;
  toolContext?: ToolExecutionContext;
}): Promise<ContinuableAgentResult<import("./role-ledgers.ts").EpicDecoderLedger, unknown>> {
  return runContinuableAgent<import("./role-ledgers.ts").EpicDecoderLedger, unknown>({
    role: "epicDecoder",
    objective: input.prompt,
    cwd: input.cwd,
    runId: input.runId ?? undefined,
    epicId: input.epicId,
    gateway: input.gateway,
    gatewayMethod: "runEpicDecoderInWorkspace",
    onStream: input.onStream,
    toolContext: input.toolContext,
  });
}

export async function runContinuableGoalReview(input: {
  epicId: string;
  runId?: string | null;
  cwd: string;
  prompt: string;
  gateway: ModelGateway;
  onStream?: StreamHook;
  toolContext?: ToolExecutionContext;
}): Promise<ContinuableAgentResult<import("./role-ledgers.ts").EpicReviewerLedger, unknown>> {
  return runContinuableAgent<import("./role-ledgers.ts").EpicReviewerLedger, unknown>({
    role: "epicReviewer",
    objective: input.prompt,
    cwd: input.cwd,
    runId: input.runId ?? undefined,
    epicId: input.epicId,
    gateway: input.gateway,
    gatewayMethod: "runGoalReviewInWorkspace",
    onStream: input.onStream,
    toolContext: input.toolContext,
  });
}

export async function runContinuableDoctor(input: {
  ticketId?: string;
  epicId?: string;
  runId?: string;
  cwd: string;
  prompt: string;
  gateway: ModelGateway;
  onStream?: StreamHook;
  toolContext?: ToolExecutionContext;
}): Promise<ContinuableAgentResult<import("./role-ledgers.ts").DoctorLedger, unknown>> {
  // Doctor is currently deterministic (no model call), but this wrapper prepares
  // the system for future model-based doctor implementations.
  // For now, it creates a DoctorLedger and returns it without calling any gateway method.
  const ledger = (await import("./role-ledgers.ts")).createDoctorLedger();
  const state = createContinuationState<import("./role-ledgers.ts").DoctorLedger, unknown>({
    role: "doctor",
    objective: input.prompt,
    ledger,
    constraints: [],
    allowedPaths: [],
    epicId: input.epicId,
    ticketId: input.ticketId,
    runId: input.runId,
    workspaceId: undefined,
  });
  return {
    state,
    output: null,
    loopletCount: 0,
    totalModelCalls: 0,
    recoveredStalls: 0,
  };
}

export async function runContinuableKnowledgebaseBuilder(input: {
  epicId?: string;
  ticketId?: string;
  runId?: string;
  cwd: string;
  prompt: string;
  gateway: ModelGateway;
  onStream?: StreamHook;
  toolContext?: ToolExecutionContext;
}): Promise<ContinuableAgentResult<import("./role-ledgers.ts").KnowledgebaseLedger, unknown>> {
  return runContinuableAgent<import("./role-ledgers.ts").KnowledgebaseLedger, unknown>({
    role: "knowledgebaseBuilder",
    objective: input.prompt,
    cwd: input.cwd,
    runId: input.runId,
    ticketId: input.ticketId,
    epicId: input.epicId,
    gateway: input.gateway,
    gatewayMethod: "runBuilderInWorkspace",
    onStream: input.onStream,
    toolContext: input.toolContext,
  });
}
