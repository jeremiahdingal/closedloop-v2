import type { ChatMessage } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContextBudget {
  windowTokens: number;
  usedTokens: number;
  usedFraction: number;
  compacted: boolean;
}

export type CompactionLevel = "none" | "gentle" | "aggressive" | "force_finish";

export interface CompactionResult {
  messages: ChatMessage[];
  removedTokens: number;
  level: CompactionLevel;
}

// ─── Token estimation ────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 3.5;
const TOOL_CALL_OVERHEAD = 20; // per tool_call entry
const PER_MESSAGE_OVERHEAD = 4;

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += PER_MESSAGE_OVERHEAD;
    if (typeof msg.content === "string") {
      total += Math.ceil(msg.content.length / CHARS_PER_TOKEN);
    } else if (msg.content) {
      total += Math.ceil(JSON.stringify(msg.content).length / CHARS_PER_TOKEN);
    }
    if (msg.tool_calls) {
      total += msg.tool_calls.length * TOOL_CALL_OVERHEAD;
      for (const tc of msg.tool_calls) {
        total += Math.ceil(tc.function.name.length / CHARS_PER_TOKEN);
        total += Math.ceil(tc.function.arguments.length / CHARS_PER_TOKEN);
      }
    }
  }
  return total;
}

// ─── Budget computation ──────────────────────────────────────────────────────

export function computeBudget(
  messages: ChatMessage[],
  windowTokens: number,
  alreadyCompacted: boolean
): ContextBudget {
  const usedTokens = estimateMessagesTokens(messages);
  return {
    windowTokens,
    usedTokens,
    usedFraction: usedTokens / windowTokens,
    compacted: alreadyCompacted,
  };
}

export function shouldCompact(budget: ContextBudget): CompactionLevel {
  if (budget.usedFraction >= 0.9) return "force_finish";
  if (budget.usedFraction >= 0.8) return "aggressive";
  if (budget.usedFraction >= 0.6) return "gentle";
  return "none";
}

// ─── Compaction ──────────────────────────────────────────────────────────────

function truncateContent(content: string, head: number, tail: number): string {
  if (content.length <= head + tail + 50) return content;
  return content.slice(0, head) + `\n[...compacted from ${content.length} chars...]\n` + content.slice(-tail);
}

/** Check if two messages form an assistant+tool_result pair */
function isToolExchangeStart(messages: ChatMessage[], idx: number): boolean {
  return (
    messages[idx].role === "assistant" &&
    idx + 1 < messages.length &&
    messages[idx + 1].role === "tool"
  );
}

/**
 * Gentle compaction: truncate old tool result content to head+tail.
 * Operates on the older half of exchange pairs.
 */
function compactGentle(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 4) return messages;

  const result = messages.map(m => ({ ...m }));

  // Find tool exchanges
  const exchangeStarts: number[] = [];
  for (let i = 2; i < result.length; i++) {
    if (isToolExchangeStart(result, i)) {
      exchangeStarts.push(i);
    }
  }

  // Compact the older half
  const cutoff = Math.ceil(exchangeStarts.length / 2);
  for (let i = 0; i < cutoff && i < exchangeStarts.length; i++) {
    const toolMsgIdx = exchangeStarts[i] + 1;
    const toolContent = result[toolMsgIdx].content;
    if (typeof toolContent === "string" && toolContent.length > 600) {
      result[toolMsgIdx] = {
        ...result[toolMsgIdx],
        content: truncateContent(toolContent, 300, 200),
      };
    }
  }

  return result;
}

/**
 * Aggressive compaction: collapse old exchanges into single-line summaries.
 * Keep last 6 messages verbatim.
 */
function compactAggressive(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 8) return messages;

  const keepTail = 6;
  const head = messages.slice(0, 2); // system + user prompt
  const tail = messages.slice(-keepTail);
  const middle = messages.slice(2, -keepTail);

  // Summarize middle into a single system message
  const summaryLines: string[] = ["[PRIOR CONTEXT SUMMARY]"];
  for (let i = 0; i < middle.length; i++) {
    const msg = middle[i];
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const args = tc.function.arguments.slice(0, 80);
        summaryLines.push(`Called ${tc.function.name}(${args}...)`);
      }
    } else if (msg.role === "tool" && typeof msg.content === "string") {
      const preview = msg.content.slice(0, 150).replace(/\n/g, " ");
      summaryLines.push(`→ ${preview}...`);
    } else if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
      const preview = msg.content.slice(0, 120).replace(/\n/g, " ");
      summaryLines.push(`Assistant: ${preview}...`);
    } else if (msg.role === "user" && typeof msg.content === "string" && msg.content.trim()) {
      const preview = msg.content.slice(0, 120).replace(/\n/g, " ");
      summaryLines.push(`User: ${preview}...`);
    }
  }

  const summaryMsg: ChatMessage = {
    role: "system",
    content: summaryLines.join("\n"),
  };

  return [...head, summaryMsg, ...tail];
}

/**
 * Safety net: drop oldest exchange pairs until under target tokens.
 * Never splits assistant/tool_result pairs. Never drops messages[0] or messages[1].
 */
function enforceTokenBudget(messages: ChatMessage[], targetTokens: number): ChatMessage[] {
  let current = estimateMessagesTokens(messages);
  if (current <= targetTokens) return messages;

  const result = [...messages];

  // Drop from index 2 onward, in pairs (assistant + tool_result)
  while (current > targetTokens && result.length > 4) {
    // Find the first droppable exchange pair starting from index 2
    let dropped = false;
    for (let i = 2; i < result.length - 2; i++) {
      if (result[i].role === "assistant" && result[i + 1]?.role === "tool") {
        const before = estimateMessagesTokens(result);
        result.splice(i, 2);
        current -= (before - estimateMessagesTokens(result));
        dropped = true;
        break;
      }
    }
    // If no pair found, drop single oldest non-essential message
    if (!dropped) {
      for (let i = 2; i < result.length - 2; i++) {
        const before = estimateMessagesTokens(result);
        result.splice(i, 1);
        current -= (before - estimateMessagesTokens(result));
        break;
      }
    }
  }

  return result;
}

export function compactMessages(
  messages: ChatMessage[],
  windowTokens: number,
  level: CompactionLevel
): CompactionResult {
  if (level === "none") {
    return { messages, removedTokens: 0, level };
  }

  const before = estimateMessagesTokens(messages);
  let result: ChatMessage[];

  if (level === "gentle") {
    result = compactGentle(messages);
  } else if (level === "aggressive") {
    result = compactAggressive(messages);
  } else {
    // force_finish — minimal compaction just to keep the model responding
    result = compactAggressive(messages);
  }

  // Safety net: ensure we're under 85% of window
  result = enforceTokenBudget(result, Math.floor(windowTokens * 0.85));

  const after = estimateMessagesTokens(result);
  return {
    messages: result,
    removedTokens: before - after,
    level,
  };
}
