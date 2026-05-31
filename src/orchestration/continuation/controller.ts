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
import { buildPhasePrompt, getNextPhase, getAllowedToolsForPhase, buildEpicDecoderContinuationPrompt, ROLE_PHASES } from "./prompts.ts";
import { persistState, loadState, persistHandoff } from "./persistence.ts";
import { createDefaultLedger } from "./role-ledgers.ts";
import type { EpicDecoderLedger } from "./role-ledgers.ts";
import {
  inferSearchTarget,
  isUsefulProjectFile,
  isWeakOrIrrelevantResult,
  recordNegativeEvidence,
  recordPositiveEvidence,
  shouldBlockSearch,
  shouldForceFinishDiscovery,
  buildNegativeEvidenceInjection,
  isTargetExhausted,
} from "./negative-evidence.ts";
import type { ModelGateway, StreamHook } from "../models.ts";
import type { ToolExecutionContext, MediatedHarnessEvent } from "../../mediated-agent-harness/types.ts";
import { parseJsonText } from "../validation.ts";

// ─── Negative evidence tracking helpers ──────────────────────────────────────

function extractSearchText(toolName: string, args: Record<string, unknown>): string {
  if (typeof args.pattern === "string") return args.pattern;
  if (typeof args.query === "string") return args.query;
  if (typeof args.path === "string") return args.path;
  if (Array.isArray(args.paths)) return args.paths.join(" ");
  return JSON.stringify(args);
}

function extractFileListFromResult(resultText: string): string[] {
  const fileMatches = resultText.match(/^[\w\-./]+\.\w+$/gm) ?? [];
  return fileMatches.filter(isUsefulProjectFile);
}

function classifyToolResultForEvidence(
  toolName: string,
  args: Record<string, unknown>,
  resultText: string
): { target: string | null; isNegative: boolean; isWeak: boolean; files: string[] } {
  const searchText = extractSearchText(toolName, args);
  const target = inferSearchTarget(searchText);
  const files = extractFileListFromResult(resultText);
  const isWeak = isWeakOrIrrelevantResult(resultText, files);
  const isNegative = isWeak || files.length === 0;

  return { target, isNegative, isWeak, files };
}

function updateDiscoveryLedgerFromToolResult<TLedger, TOutput>(
  state: AgentContinuationState<TLedger, TOutput>,
  toolName: string,
  args: Record<string, unknown>,
  resultText: string
): AgentContinuationState<TLedger, TOutput> {
  if (state.role !== "epicDecoder") return state;

  const ledger = state.ledger as EpicDecoderLedger;
  const discovery = ledger.discoveryLedger;

  const discoveryTools = new Set([
    "glob_files", "grep_files", "semantic_search",
    "read_file", "read_files", "list_dir",
  ]);

  if (!discoveryTools.has(toolName)) return state;

  const { target, isNegative, isWeak, files } = classifyToolResultForEvidence(toolName, args, resultText);

  if (!target) return state;

  const searchText = extractSearchText(toolName, args);

  const failed =
    resultText.toLowerCase().includes("no files matched") ||
    resultText.toLowerCase().includes("file not found") ||
    resultText.toLowerCase().includes("0 matches") ||
    resultText.toLowerCase().includes("error:");

  if (failed || isNegative) {
    const updatedDiscovery = recordNegativeEvidence(
      discovery,
      target,
      state.phase,
      searchText,
      resultText,
      isWeak || failed
    );
    return {
      ...state,
      ledger: { ...ledger, discoveryLedger: updatedDiscovery } as TLedger,
    };
  }

  if (files.length > 0) {
    const updatedDiscovery = recordPositiveEvidence(
      discovery,
      target,
      state.phase,
      files,
      [resultText.slice(0, 200)]
    );
    return {
      ...state,
      ledger: { ...ledger, discoveryLedger: updatedDiscovery } as TLedger,
    };
  }

  return state;
}

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

    // Emit continuation looplet start trace marker
    const allowedTools = getAllowedToolsForPhase(role, state.phase);
    onStream?.({
      agentRole: role as any,
      source: "continuation-controller",
      streamKind: "continuation_looplet_start",
      content: JSON.stringify({
        kind: 'continuation_looplet_start',
        role,
        phase: state.phase,
        loopletIndex: looplet,
        maxIterations: loopletIterations,
        allowedTools,
      }),
      runId,
      sequence: 0,
      metadata: { role, phase: state.phase, loopletIndex: looplet, maxIterations: loopletIterations, allowedTools },
    });

    // Build the prompt for this looplet
    const phasePrompt = buildPhasePrompt(role, state.phase);
    const resumeSuffix = looplet > 0 ? "\n\n" + buildColdResumePrompt(state) : "";
    
    // Use continuation-specific prompt for epicDecoder if available
    let prompt = objective + (phasePrompt ? "\n\n" + phasePrompt : "") + resumeSuffix;
    if (role === "epicDecoder" && state.phase !== "final_json") {
      // For epicDecoder in continuation mode, use the continuation-specific prompt
      // This will be passed through the gateway and override the default prompt
      const continuationPrompt = buildEpicDecoderContinuationPrompt({
        epic: objective,
        state,
      });
      if (continuationPrompt) {
        prompt = continuationPrompt + resumeSuffix;
      }
    }

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
      const toolResultsToProcess: Array<{ name: string; args: Record<string, unknown>; resultText: string }> = [];

      // Force phase completion if target is exhausted
      let retryNote: string | null = null;
      if (
        state.role === "epicDecoder" &&
        (state.phase === "skeleton" || state.phase === "evidence") &&
        shouldSkipDiscoveryPhase(state)
      ) {
        state = { ...state, phase: "fill_tickets" };
        state = recordProgressEvent(state, "phase_advanced_forced", "target_exhausted");
        retryNote = [
          buildNegativeEvidenceInjection((state.ledger as EpicDecoderLedger).discoveryLedger),
          "",
          "Discovery is exhausted. Do not call glob_files, grep_files, semantic_search, list_dir, or read_file for the missing target.",
          "Fill tickets now. Any missing target path must be described as CREATE, not MODIFY.",
        ].join("\n");
        onStream?.({
          agentRole: role as any,
          source: "continuation-controller",
          streamKind: "status",
          content: `[continuation-guard] Target exhausted, forcing phase to fill_tickets.`,
          runId,
          sequence: 0,
          metadata: { phase: state.phase },
        });
      }

      try {
        result = await callGateway(gateway, gatewayMethod, {
          cwd,
          prompt: retryNote ? `${prompt}\n\n${retryNote}` : prompt,
          runId,
          ticketId: config.ticketId,
          epicId: config.epicId,
          ...config.gatewayExtraArgs,
          continuation: {
            enabled: true,
            phase: state.phase,
            state,
            maxIterations: loopletIterations,
            allowedToolsOverride: allowedTools,
            beforeToolCall: createEpicDecoderBeforeToolCall(state),
            afterToolResult: undefined,
          },
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
            // Track search tool results for negative evidence
            if (event.kind === "tool_result" && event.result?.name) {
              const discoveryTools = ["glob_files", "grep_files", "semantic_search", "read_file", "read_files", "list_dir"];
              if (discoveryTools.includes(event.result.name)) {
                toolResultsToProcess.push({
                  name: event.result.name,
                  args: event.call?.args ?? {},
                  resultText: event.result.output ?? "",
                });
              }
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

      // Process collected tool results for negative evidence tracking
      for (const toolResult of toolResultsToProcess) {
        state = updateDiscoveryLedgerFromToolResult(state, toolResult.name, toolResult.args, toolResult.resultText);
      }

    // Try to extract output from result
    let loopletPhaseAdvanced = false;
    if (result !== null && result !== undefined) {
      const parsedResult = typeof result === "string" ? parseJsonText(result) : result;
      if (isLoopletPayload(parsedResult)) {
        const updated = updateStateFromLooplet(state, parsedResult);
        state = updated.state;
        loopletPhaseAdvanced = updated.phaseAdvanced;
        state = recordProgressEvent(state, "looplet_payload_applied", parsedResult.summary ?? state.phase);
        onStream?.({
          agentRole: role as any,
          source: "continuation-controller",
          streamKind: "status",
          content: `Looplet payload captured in phase ${state.phase}.`,
          runId,
          sequence: 0,
          metadata: { phase: state.phase, looplet: looplet + 1 },
        });
      } else {
        state = { ...state, draftOutput: parsedResult as TOutput };
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
    }

    // Advance phase if appropriate
    const nextPhase = getNextPhase(role, state.phase);
    const shouldAdvance = !loopletPhaseAdvanced && (shouldAdvancePhase(role, state) || (nextPhase && state.draftOutput !== null));
    if (shouldAdvance && nextPhase) {
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

type LoopletPayload = {
  summary?: string;
  phaseComplete?: boolean;
  requestedNextPhase?: string;
  ticketUpdates?: Array<{ id: string; responsibility?: string; status?: string }>;
  evidenceUpdates?: Array<{ slotId: string; facts?: string[]; files?: string[] }>;
  finalCandidate?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLoopletPayload(value: unknown): value is LoopletPayload {
  if (!isRecord(value)) return false;
  return (
    "phaseComplete" in value
    || "requestedNextPhase" in value
    || "ticketUpdates" in value
    || "evidenceUpdates" in value
    || "finalCandidate" in value
  );
}

function updateStateFromLooplet<TLedger, TOutput>(
  state: AgentContinuationState<TLedger, TOutput>,
  payload: LoopletPayload,
): { state: AgentContinuationState<TLedger, TOutput>; phaseAdvanced: boolean } {
  let nextState = state;
  let phaseAdvanced = false;

  if (state.role === "epicDecoder") {
    const ledger = { ...(state.ledger as any) };
    if (Array.isArray(payload.ticketUpdates) && payload.ticketUpdates.length > 0) {
      const existingTickets = Array.isArray(ledger.ticketSkeletons) ? [...ledger.ticketSkeletons] : [];
      const byId = new Map(existingTickets.map((ticket: any) => [ticket.id, ticket]));
      for (const update of payload.ticketUpdates) {
        if (!update?.id) continue;
        const current = byId.get(update.id) ?? {};

        // Validate ticket path intent against discovery ledger
        const ticketText = update.responsibility ?? current.responsibility ?? "";
        if (ticketText && ledger.discoveryLedger) {
          const validation = validateTicketPathIntent(ticketText, ledger);
          if (!validation.ok && validation.rewrittenText) {
            update.responsibility = validation.rewrittenText;
          }
        }

        byId.set(update.id, {
          ...current,
          id: update.id,
          responsibility: update.responsibility ?? current.responsibility ?? "",
          status: update.status ?? current.status ?? "skeleton",
        });
      }
      ledger.ticketSkeletons = [...byId.values()];
    }
    if (Array.isArray(payload.evidenceUpdates) && payload.evidenceUpdates.length > 0) {
      const evidenceSlots = { ...(ledger.evidenceSlots ?? {}) };
      for (const update of payload.evidenceUpdates) {
        if (!update?.slotId) continue;
        const current = evidenceSlots[update.slotId] ?? { status: "missing", files: [], facts: [], ticketImplications: [] };
        const facts = [...new Set([...(current.facts ?? []), ...(update.facts ?? [])])];
        const files = [...new Set([...(current.files ?? []), ...(update.files ?? [])])];
        evidenceSlots[update.slotId] = {
          ...current,
          files,
          facts,
          status: facts.length > 0 || files.length > 0 ? "filled" : current.status,
        };
      }
      ledger.evidenceSlots = evidenceSlots;
    }
    if ("finalCandidate" in payload) {
      ledger.finalCandidate = payload.finalCandidate ?? null;
    }
    nextState = { ...state, ledger: ledger as TLedger };
  }

  const requestedPhase = typeof payload.requestedNextPhase === "string" && ROLE_PHASES[state.role]?.includes(payload.requestedNextPhase)
    ? payload.requestedNextPhase
    : null;
  if (requestedPhase) {
    nextState = { ...nextState, phase: requestedPhase };
    phaseAdvanced = true;
  } else if (payload.phaseComplete) {
    const nextPhase = getNextPhase(state.role, nextState.phase);
    if (nextPhase) {
      nextState = { ...nextState, phase: nextPhase };
      phaseAdvanced = true;
    }
  }

  return { state: nextState, phaseAdvanced };
}

// ─── State-progress detection ──────────────────────────────────────────────

function classifyDecoderToolProgress(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  state: AgentContinuationState<any>
): { kind: string; slotId?: string; facts?: string[] }[] {
  if (toolName === "read_file") {
    const path = args.path as string;
    if (!path) return [];
    
    // Check if this file maps to an evidence slot
    const ledger = state.ledger as any;
    if (!ledger?.evidenceSlots) return [];
    
    for (const [slotId, slot] of Object.entries(ledger.evidenceSlots)) {
      const slotFiles = (slot as any).files ?? [];
      if (slotFiles.some((f: string) => path.includes(f) || f.includes(path))) {
        // Extract facts from the result
        const facts = extractEvidenceFacts(result);
        if (facts.length > 0) {
          return [{
            kind: "evidence_slot_updated",
            slotId,
            facts,
          }];
        }
      }
    }
  }
  
  return [];
}

function extractEvidenceFacts(result: string): string[] {
  // Extract facts from file read result - take meaningful lines
  const lines = result.split("\n")
    .filter(l => l.trim().length > 10 && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
    .slice(0, 10);
  return lines;
}

// ─── Deterministic phase transitions ────────────────────────────────────────

function shouldAdvancePhase(role: LocalAgentRole, state: AgentContinuationState<any>): boolean {
  if (role === "epicDecoder") {
    const ledger = state.ledger as any;
    
    if (state.phase === "skeleton" && ledger.ticketSkeletons?.length >= 5) {
      return true;
    }
    
    if (state.phase === "evidence") {
      const totalSlots = Object.keys(ledger.evidenceSlots ?? {}).length;
      const filledSlots = Object.values(ledger.evidenceSlots ?? {})
        .filter((s: any) => s.status === "filled").length;
      if (totalSlots > 0 && filledSlots / totalSlots >= 0.7) {
        return true;
      }
    }
    
    if (state.phase === "fill_tickets") {
      const allPartiallyFilled = (ledger.ticketSkeletons ?? []).every((t: any) => 
        t.status === "filled" || t.status === "skeleton"
      );
      if (allPartiallyFilled && ledger.ticketSkeletons?.length > 0) {
        return true;
      }
    }
    
    if (state.phase === "self_check") {
      // If validation passes or is repairable, advance
      return true;
    }
  }
  
  return false;
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

// ─── EpicDecoder beforeToolCall guard ────────────────────────────────────────

export function createEpicDecoderBeforeToolCall(state: AgentContinuationState<any>) {
  return (input: { role: string; phase?: string; toolName: string; args: Record<string, unknown>; state: unknown }) => {
    if (input.role !== "epicDecoder") return {};

    const discoveryTools = new Set([
      "glob_files", "grep_files", "semantic_search",
      "read_file", "read_files", "list_dir",
    ]);

    if (!discoveryTools.has(input.toolName)) return {};

    const searchText = extractSearchText(input.toolName, input.args);
    const target = inferSearchTarget(searchText);

    if (!target) return {};

    const ledger = state.ledger as EpicDecoderLedger;
    const discovery = ledger.discoveryLedger;

    const blocked =
      shouldBlockSearch(discovery, target, searchText) ||
      shouldForceFinishDiscovery(discovery, target);

    if (!blocked) return {};

    const injection = buildNegativeEvidenceInjection(discovery, target);

    return {
      blocked: true,
      state: input.state,
      nudge: [
        `[DISCOVERY GUARD] Do not run that search.`,
        `Target "${target}" is already missing/exhausted.`,
        "",
        injection,
        "",
        `You must now call finish_looplet.`,
        `If the target file is needed, ticket wording must say CREATE, not MODIFY.`,
      ].join("\n"),
    };
  };
}

// ─── Ticket path validation ──────────────────────────────────────────────────

type PathIntent = "create" | "modify" | "unknown";

function classifyTicketIntent(text: string): PathIntent {
  const lower = text.toLowerCase();

  if (
    lower.includes("create ") ||
    lower.includes("add new ") ||
    lower.includes("new file") ||
    lower.includes("because no existing")
  ) {
    return "create";
  }

  if (
    lower.includes("modify ") ||
    lower.includes("update ") ||
    lower.includes("edit ") ||
    lower.includes("replace ") ||
    lower.includes("in existing ")
  ) {
    return "modify";
  }

  return "unknown";
}

function extractMentionedPaths(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9._/-]+\.(tsx|ts|jsx|js|json|md|css|scss)/g);
  return [...new Set(matches ?? [])];
}

function getVerifiedFiles(ledger: EpicDecoderLedger): Set<string> {
  const files = new Set<string>();
  for (const ev of ledger.discoveryLedger.successfulEvidence) {
    for (const file of ev.files) files.add(file);
  }
  for (const slot of Object.values(ledger.evidenceSlots)) {
    for (const file of slot.files ?? []) files.add(file);
  }
  return files;
}

function getNegativelyVerifiedFiles(ledger: EpicDecoderLedger): Set<string> {
  const files = new Set<string>();
  for (const ev of ledger.discoveryLedger.negativeEvidence) {
    for (const pattern of ev.failedPatterns) {
      if (/\.(tsx|ts|jsx|js|json|md|css|scss)$/.test(pattern)) {
        files.add(pattern);
      }
    }
  }
  return files;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateTicketPathIntent(
  ticketText: string,
  ledger: EpicDecoderLedger
): { ok: boolean; reason?: string; rewrittenText?: string } {
  const intent = classifyTicketIntent(ticketText);
  const paths = extractMentionedPaths(ticketText);

  if (paths.length === 0) return { ok: true };

  const verified = getVerifiedFiles(ledger);
  const negative = getNegativelyVerifiedFiles(ledger);

  for (const path of paths) {
    const isVerified = verified.has(path);
    const isKnownMissing = negative.has(path);

    if (intent === "modify" && !isVerified) {
      return {
        ok: false,
        reason: `Ticket says modify ${path}, but that file was not verified.`,
        rewrittenText: ticketText.replace(
          new RegExp(`(Modify|Update|Edit|Replace)(.*?${escapeRegex(path)})`, "i"),
          `Create ${path}`
        ),
      };
    }

    if (intent === "modify" && isKnownMissing) {
      return {
        ok: false,
        reason: `Ticket says modify ${path}, but that file was proven missing.`,
        rewrittenText: ticketText.replace(
          new RegExp(`(Modify|Update|Edit|Replace)(.*?${escapeRegex(path)})`, "i"),
          `Create ${path}`
        ),
      };
    }
  }

  return { ok: true };
}

// ─── Force phase completion after target exhaustion ──────────────────────────

function shouldSkipDiscoveryPhase(state: AgentContinuationState<any>): boolean {
  if (state.role !== "epicDecoder") return false;
  const ledger = state.ledger as EpicDecoderLedger;
  return ledger.discoveryLedger.negativeEvidence.some(
    (e) => e.exhausted || e.searchCount >= 3
  );
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
