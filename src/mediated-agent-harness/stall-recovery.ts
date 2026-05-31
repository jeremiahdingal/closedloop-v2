// ─── Types ───────────────────────────────────────────────────────────────────

export type StallKind = "empty_response" | "no_tool_calls" | "repeated_call" | "consecutive_errors";
export type StallLevel = "gentle" | "moderate" | "strong" | "forced";

export interface StallState {
  counts: Record<StallKind, number>;
  lastKind: StallKind | null;
  toolModeOverride: "native" | "xml" | null;
  compaction: { passCount: number; totalRemovedTokens: number };
}

export interface RecoveryAction {
  nudgeMessage: string;
  allowRetry: boolean;
  forceFinish: boolean;
  forceXmlMode: boolean;
  maxAdditionalRetries: number;
}

export interface LoopStallSignals {
  hasEmptyResponse: boolean;
  hasNoToolCalls: boolean;
  repeatedCallCount: number;
  consecutiveErrors: number;
}

// ─── Stall classification ────────────────────────────────────────────────────

export function classifyStall(signals: LoopStallSignals): StallKind | null {
  if (signals.consecutiveErrors >= 5) return "consecutive_errors";
  if (signals.repeatedCallCount >= 3) return "repeated_call";
  if (signals.hasEmptyResponse) return "empty_response";
  if (signals.hasNoToolCalls) return "no_tool_calls";
  return null;
}

// ─── Level computation ───────────────────────────────────────────────────────

export function computeStallLevel(
  kind: StallKind,
  consecutiveOccurrences: number,
  contextWindow: number
): StallLevel {
  // Small-context models (≤8k) escalate one level faster
  const smallCtxBoost = contextWindow <= 8192 ? 1 : 0;
  const effective = consecutiveOccurrences + smallCtxBoost;

  if (effective >= 4) return "forced";
  if (effective >= 3) return "strong";
  if (effective >= 2) return "moderate";
  return "gentle";
}

// ─── Recovery actions ────────────────────────────────────────────────────────

export function getRecoveryAction(
  kind: StallKind,
  level: StallLevel,
  role: string | undefined,
  iteration: number,
  maxIterations: number
): RecoveryAction {
  // Forced level always terminates
  if (level === "forced") {
    return {
      nudgeMessage: "[SYSTEM] Maximum recovery attempts reached. You MUST call the finish tool NOW with whatever analysis you have. This is not optional.",
      allowRetry: false,
      forceFinish: true,
      forceXmlMode: false,
      maxAdditionalRetries: 0,
    };
  }

  const remaining = maxIterations - iteration;
  const finishReminder = `You are at iteration ${iteration + 1} of ${maxIterations}. ${remaining} iterations remain.`;

  if (kind === "empty_response" || kind === "no_tool_calls") {
    return getEmptyResponseAction(level, finishReminder, role);
  }

  if (kind === "repeated_call") {
    return getRepeatedCallAction(level, finishReminder);
  }

  // consecutive_errors
  return getConsecutiveErrorAction(level, finishReminder);
}

function getEmptyResponseAction(level: StallLevel, reminder: string, role: string | undefined): RecoveryAction {
  switch (level) {
    case "gentle":
      return {
        nudgeMessage: `continue\n\nNo tool call received. Call a tool now. If done, call finish.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 3,
      };
    case "moderate":
      return {
        nudgeMessage: `continue\n\nSwitching to XML tool format. Use: <function=tool_name><parameter name="param">value</parameter></function>`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: true,
        maxAdditionalRetries: 2,
      };
    case "strong":
      return {
        nudgeMessage: `continue\n\nCall finish NOW with whatever you have.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 1,
      };
    default:
      return {
        nudgeMessage: "Call finish NOW.",
        allowRetry: false,
        forceFinish: true,
        forceXmlMode: false,
        maxAdditionalRetries: 0,
      };
  }
}

function getRepeatedCallAction(level: StallLevel, reminder: string): RecoveryAction {
  switch (level) {
    case "gentle":
      return {
        nudgeMessage: `continue\n\nYou are repeating the same tool call. Use different arguments or call finish.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 3,
      };
    case "moderate":
      return {
        nudgeMessage: `continue\n\nRepeated same call. Call finish or use a different tool.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 2,
      };
    case "strong":
      return {
        nudgeMessage: `continue\n\nCall finish NOW with whatever you have.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 1,
      };
    default:
      return {
        nudgeMessage: "Call finish NOW.",
        allowRetry: false,
        forceFinish: true,
        forceXmlMode: false,
        maxAdditionalRetries: 0,
      };
  }
}

function getConsecutiveErrorAction(level: StallLevel, reminder: string): RecoveryAction {
  switch (level) {
    case "gentle":
      return {
        nudgeMessage: `continue\n\nTool errors detected. Try simpler arguments or call finish.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 3,
      };
    case "moderate":
      return {
        nudgeMessage: `continue\n\nSwitching to XML tool format. Use: <function=tool_name><parameter name="param">value</parameter></function>`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: true,
        maxAdditionalRetries: 2,
      };
    case "strong":
      return {
        nudgeMessage: `continue\n\nCall finish NOW with whatever you have.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 1,
      };
    default:
      return {
        nudgeMessage: "Call finish NOW.",
        allowRetry: false,
        forceFinish: true,
        forceXmlMode: false,
        maxAdditionalRetries: 0,
      };
  }
}

// ─── State helpers ───────────────────────────────────────────────────────────

export function createStallState(): StallState {
  return {
    counts: {
      empty_response: 0,
      no_tool_calls: 0,
      repeated_call: 0,
      consecutive_errors: 0,
    },
    lastKind: null,
    toolModeOverride: null,
    compaction: { passCount: 0, totalRemovedTokens: 0 },
  };
}

export function recordStall(state: StallState, kind: StallKind): StallState {
  return {
    ...state,
    counts: {
      ...state.counts,
      [kind]: state.counts[kind] + 1,
    },
    lastKind: kind,
  };
}

export function resetStallCounters(state: StallState): StallState {
  return {
    ...state,
    counts: {
      empty_response: 0,
      no_tool_calls: 0,
      repeated_call: 0,
      consecutive_errors: 0,
    },
    lastKind: null,
  };
}
