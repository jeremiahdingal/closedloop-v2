// ─── Types ───────────────────────────────────────────────────────────────────

export type StallKind = "empty_response" | "no_tool_calls" | "repeated_call" | "consecutive_errors";
export type StallLevel = "gentle" | "moderate" | "strong" | "forced";

export interface StallState {
  counts: Record<StallKind, number>;
  lastKind: StallKind | null;
  toolModeOverride: "native" | "xml" | null;
  contextCompacted: boolean;
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
  if (signals.consecutiveErrors >= 3) return "consecutive_errors";
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
        nudgeMessage: `${reminder}\nYour last response had no tool call. You MUST call a tool in every response. If you have enough information, call the 'finish' tool now. Otherwise call a tool to continue working.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 3,
      };
    case "moderate":
      return {
        nudgeMessage: `${reminder}\nNative tool calling seems unreliable. Switching to XML format.\nUse this EXACT format for tool calls:\n<function=tool_name><parameter name="param1">value1</parameter></function>\n\nExample: <function=finish><parameter name="summary">my summary</parameter><parameter name="result">{"key":"value"}</parameter></function>\n\nYou MUST use this XML format for your next response. No prose, no markdown, just one XML function call.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: true,
        maxAdditionalRetries: 2,
      };
    case "strong":
      return {
        nudgeMessage: `[SYSTEM] ${reminder}\nYou keep failing to produce tool calls. Call the 'finish' tool NOW with whatever you have. This is your last chance before forced termination.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 1,
      };
    default:
      return {
        nudgeMessage: "[SYSTEM] Call finish NOW.",
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
        nudgeMessage: `${reminder}\nYou are repeating the same tool call. Try a different approach — use different arguments, a different tool, or call finish with what you have.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 3,
      };
    case "moderate":
      return {
        nudgeMessage: `${reminder}\nYou keep repeating the same call. Either call the 'finish' tool with your current findings, or try a completely different tool. Do not repeat the same call.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 2,
      };
    case "strong":
      return {
        nudgeMessage: `[SYSTEM] ${reminder}\nRepeated calls are not making progress. Call finish NOW with whatever you have.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 1,
      };
    default:
      return {
        nudgeMessage: "[SYSTEM] Call finish NOW.",
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
        nudgeMessage: `${reminder}\nYou have had several tool errors. Review the error messages above. Try a simpler call or use different arguments. If you cannot proceed, call finish.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 3,
      };
    case "moderate":
      return {
        nudgeMessage: `${reminder}\nMultiple consecutive errors suggest the current approach isn't working. Try using XML format for your next call:\n<function=tool_name><parameter name="param">value</parameter></function>\nOr call finish if you have enough to proceed.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: true,
        maxAdditionalRetries: 2,
      };
    case "strong":
      return {
        nudgeMessage: `[SYSTEM] ${reminder}\nToo many errors. Call finish NOW with whatever partial results you have.`,
        allowRetry: true,
        forceFinish: false,
        forceXmlMode: false,
        maxAdditionalRetries: 1,
      };
    default:
      return {
        nudgeMessage: "[SYSTEM] Call finish NOW.",
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
    contextCompacted: false,
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
