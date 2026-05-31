import type { AgentRole } from "../../types.ts";

// ─── Role enum ──────────────────────────────────────────────────────────────

export type LocalAgentRole =
  | "explorer"
  | "epicDecoder"
  | "ticketHardener"
  | "decompositionJudge"
  | "ticketRepair"
  | "builder"
  | "reviewer"
  | "tester"
  | "epicReviewer"
  | "doctor"
  | "knowledgebaseBuilder";

export const LOCAL_AGENT_ROLES: ReadonlySet<LocalAgentRole> = new Set<LocalAgentRole>([
  "explorer",
  "epicDecoder",
  "ticketHardener",
  "decompositionJudge",
  "ticketRepair",
  "builder",
  "reviewer",
  "tester",
  "epicReviewer",
  "doctor",
  "knowledgebaseBuilder",
]);

export function toLocalAgentRole(role: AgentRole | string): LocalAgentRole | null {
  if (LOCAL_AGENT_ROLES.has(role as LocalAgentRole)) return role as LocalAgentRole;
  if (role === "coder") return "builder";
  return null;
}

// ─── Progress events ────────────────────────────────────────────────────────

export type AgentProgressEvent = {
  kind: string;
  loopletIndex: number;
  timestamp: string;
  detail?: string;
};

// ─── Visited file tracking ──────────────────────────────────────────────────

export type VisitedFileEntry = {
  path: string;
  readCount: number;
  usefulFor: string[];
  lastReadLooplet: number;
};

// ─── Continuation state ─────────────────────────────────────────────────────

export type AgentContinuationState<TLedger = unknown, TOutput = unknown> = {
  version: 1;
  role: LocalAgentRole;

  epicId?: string;
  ticketId?: string;
  runId?: string;
  workspaceId?: string;

  phase: string;
  loopletIndex: number;
  totalModelCalls: number;
  totalToolCalls: number;

  objective: string;
  constraints: string[];
  allowedPaths: string[];

  ledger: TLedger;
  draftOutput: TOutput | null;

  visitedFiles: Record<string, VisitedFileEntry>;

  artifacts: {
    latestStateArtifact?: string;
    latestDraftArtifact?: string;
    latestHandoffArtifact?: string;
  };

  progress: {
    lastUsefulLooplet: number;
    noProgressStreak: number;
    events: AgentProgressEvent[];
  };

  nextInstruction: string;
};

// ─── Continuation stall kinds ───────────────────────────────────────────────

export type ContinuationStallKind =
  | "busy_no_progress"
  | "same_file_loop"
  | "same_error_loop"
  | "same_blocker_loop"
  | "output_schema_avoidance"
  | "phase_mismatch"
  | "tool_success_but_state_static";

// ─── Continuation recovery actions ──────────────────────────────────────────

export type ContinuationRecoveryAction =
  | { kind: "cold_resume" }
  | { kind: "phase_shift"; phase: string }
  | { kind: "narrow_tools"; tools: string[] }
  | { kind: "restore_last_good_state" }
  | { kind: "handoff_to_doctor" }
  | { kind: "handoff_to_repair" };

// ─── Role-aware initial phases ────────────────────────────────────────────────

const ROLE_INITIAL_PHASES: Record<LocalAgentRole, string> = {
  explorer: "questions",
  epicDecoder: "skeleton",
  ticketHardener: "schema_check",
  decompositionJudge: "atomicity_check",
  ticketRepair: "load_feedback",
  builder: "understand_ticket",
  reviewer: "diff_map",
  tester: "test_need",
  epicReviewer: "ticket_outcomes",
  doctor: "collect_signals",
  knowledgebaseBuilder: "collect_approved_epics",
};

export function getInitialPhaseForRole(role: LocalAgentRole): string {
  return ROLE_INITIAL_PHASES[role] ?? "start";
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createContinuationState<TLedger, TOutput>(input: {
  role: LocalAgentRole;
  objective: string;
  ledger: TLedger;
  constraints?: string[];
  allowedPaths?: string[];
  epicId?: string;
  ticketId?: string;
  runId?: string;
  workspaceId?: string;
  phase?: string;
}): AgentContinuationState<TLedger, TOutput> {
  return {
    version: 1,
    role: input.role,
    epicId: input.epicId,
    ticketId: input.ticketId,
    runId: input.runId,
    workspaceId: input.workspaceId,
    phase: input.phase ?? getInitialPhaseForRole(input.role),
    loopletIndex: 0,
    totalModelCalls: 0,
    totalToolCalls: 0,
    objective: input.objective,
    constraints: input.constraints ?? [],
    allowedPaths: input.allowedPaths ?? [],
    ledger: input.ledger,
    draftOutput: null,
    visitedFiles: {},
    artifacts: {},
    progress: {
      lastUsefulLooplet: 0,
      noProgressStreak: 0,
      events: [],
    },
    nextInstruction: input.objective,
  };
}

export function recordProgressEvent<TLedger, TOutput>(
  state: AgentContinuationState<TLedger, TOutput>,
  kind: string,
  detail?: string,
): AgentContinuationState<TLedger, TOutput> {
  const event: AgentProgressEvent = {
    kind,
    loopletIndex: state.loopletIndex,
    timestamp: new Date().toISOString(),
    detail,
  };
  const events = [...state.progress.events, event];
  // Keep last 200 events to bound memory
  if (events.length > 200) events.splice(0, events.length - 200);
  return {
    ...state,
    progress: {
      ...state.progress,
      events,
    },
  };
}

export function recordVisitedFile<TLedger, TOutput>(
  state: AgentContinuationState<TLedger, TOutput>,
  path: string,
  usefulFor?: string,
): AgentContinuationState<TLedger, TOutput> {
  const existing = state.visitedFiles[path];
  const entry: VisitedFileEntry = existing
    ? {
        ...existing,
        readCount: existing.readCount + 1,
        lastReadLooplet: state.loopletIndex,
        usefulFor: usefulFor ? [...new Set([...existing.usefulFor, usefulFor])] : existing.usefulFor,
      }
    : {
        path,
        readCount: 1,
        usefulFor: usefulFor ? [usefulFor] : [],
        lastReadLooplet: state.loopletIndex,
      };
  return {
    ...state,
    visitedFiles: { ...state.visitedFiles, [path]: entry },
  };
}

export function incrementNoProgressStreak<TLedger, TOutput>(state: AgentContinuationState<TLedger, TOutput>): AgentContinuationState<TLedger, TOutput> {
  return {
    ...state,
    progress: {
      ...state.progress,
      noProgressStreak: state.progress.noProgressStreak + 1,
    },
  };
}

export function resetNoProgressStreak<TLedger, TOutput>(state: AgentContinuationState<TLedger, TOutput>): AgentContinuationState<TLedger, TOutput> {
  return {
    ...state,
    progress: {
      ...state.progress,
      noProgressStreak: 0,
      lastUsefulLooplet: state.loopletIndex,
    },
  };
}

export function advanceLooplet(state: AgentContinuationState): AgentContinuationState {
  return {
    ...state,
    loopletIndex: state.loopletIndex + 1,
  };
}

export function bumpModelCalls(state: AgentContinuationState, toolCallCount: number): AgentContinuationState {
  return {
    ...state,
    totalModelCalls: state.totalModelCalls + 1,
    totalToolCalls: state.totalToolCalls + toolCallCount,
  };
}
