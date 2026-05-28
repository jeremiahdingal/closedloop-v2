import type { ChatMessage } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContextBudget {
  windowTokens: number;
  usedTokens: number;
  usedFraction: number;
}

export type CompactionLevel = "none" | "summarize";

export interface CompactionState {
  passCount: number;
  totalRemovedTokens: number;
}

export interface CompactionResult {
  messages: ChatMessage[];
  removedTokens: number;
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
): ContextBudget {
  const usedTokens = estimateMessagesTokens(messages);
  return {
    windowTokens,
    usedTokens,
    usedFraction: usedTokens / windowTokens,
  };
}

export function shouldCompact(budget: ContextBudget): CompactionLevel {
  if (budget.usedFraction >= 0.75) return "summarize";
  return "none";
}

// ─── LLM-based summarization ────────────────────────────────────────────────

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context compactor. Summarize the following conversation history into a concise summary that preserves:
- Key findings and discoveries
- File paths examined or modified
- Code changes made (function names, variable names, logic changes)
- Errors encountered and how they were resolved
- Decisions taken and their rationale
- Any important values, IDs, or configuration details

Be specific — preserve file paths, variable names, function signatures, and important values exactly as they appeared.
Omit exploratory dead-ends and redundant tool calls.
Keep the summary under 2000 tokens.`;

export function formatMessagesForSummary(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system" && msg.content && typeof msg.content === "string" && msg.content.startsWith("[COMPACTED HISTORY")) {
      lines.push(`[PRIOR SUMMARY]\n${msg.content}\n[/PRIOR SUMMARY]`);
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const argsPreview = tc.function.arguments.length > 200
          ? tc.function.arguments.slice(0, 200) + "..."
          : tc.function.arguments;
        lines.push(`Assistant called ${tc.function.name}(${argsPreview})`);
      }
      if (typeof msg.content === "string" && msg.content.trim()) {
        lines.push(`Assistant said: ${msg.content.slice(0, 300)}`);
      }
    } else if (msg.role === "tool" && typeof msg.content === "string") {
      const preview = msg.content.length > 500
        ? msg.content.slice(0, 500) + `...[${msg.content.length} chars total]`
        : msg.content;
      lines.push(`Tool result: ${preview}`);
    } else if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
      lines.push(`Assistant: ${msg.content.slice(0, 500)}`);
    } else if (msg.role === "user" && typeof msg.content === "string" && msg.content.trim()) {
      lines.push(`User: ${msg.content.slice(0, 500)}`);
    }
  }
  return lines.join("\n\n");
}

/**
 * Safety net: drop oldest exchange pairs until under target tokens.
 * Never splits assistant/tool_result pairs. Never drops messages[0].
 */
function enforceTokenBudget(messages: ChatMessage[], targetTokens: number): ChatMessage[] {
  let current = estimateMessagesTokens(messages);
  if (current <= targetTokens) return messages;

  const result = [...messages];

  while (current > targetTokens && result.length > 4) {
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

export const DEFAULT_COMPACTION_MODEL = process.env.COMPACTION_MODEL || "qwen3.5:2b";

export function resolveCompactionModel(primaryModel: string): string {
  if (process.env.COMPACTION_MODEL?.trim()) {
    return process.env.COMPACTION_MODEL.trim();
  }
  if (primaryModel.startsWith("glm-4.7")) {
    return primaryModel;
  }
  return DEFAULT_COMPACTION_MODEL;
}

export async function summarizeMessages(
  messages: ChatMessage[],
  windowTokens: number,
  model: string,
  baseURL: string,
  state: CompactionState,
): Promise<CompactionResult> {
  const before = estimateMessagesTokens(messages);

  // Keep first message (system prompt) and last N messages verbatim
  const minRecent = 6;
  const recentCount = Math.max(minRecent, Math.ceil(messages.length * 0.2));
  const headEnd = 1; // keep messages[0] (system prompt)
  const tailStart = Math.max(headEnd + 1, messages.length - recentCount);

  const head = messages.slice(0, headEnd);
  const tail = messages.slice(tailStart);
  const oldHistory = messages.slice(headEnd, tailStart);

  if (oldHistory.length === 0) {
    return { messages, removedTokens: 0 };
  }

  // Build summarization prompt
  const historyText = formatMessagesForSummary(oldHistory);

  const compactionModel = resolveCompactionModel(model);

  // Call the model to summarize via Ollama native /api/chat, with retry
  let summaryResponse: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      summaryResponse = await fetch(`${baseURL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model: compactionModel,
          messages: [
            { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
            { role: "user", content: historyText },
          ],
          stream: false,
          options: {
            temperature: 0.3,
          },
        }),
      });
      if (summaryResponse.ok || summaryResponse.status !== 404) break;
    } catch (err) {
      console.warn(`[context] Summarization attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt === 0) continue;
    }
  }

  let summaryText: string;
  if (summaryResponse?.ok) {
    const payload = await summaryResponse.json() as { message?: { content?: string } };
    summaryText = payload.message?.content?.trim() ?? "";
  } else {
    // If summarization fails, fall back to aggressive truncation of old history
    const errorText = summaryResponse ? await summaryResponse.text().catch(() => "unknown error") : "no response";
    console.error(`[context] Summarization API call failed (${summaryResponse?.status ?? "timeout"}): ${errorText}`);
    summaryText = formatMessagesForSummary(oldHistory).slice(0, 4000);
  }

  if (!summaryText) {
    summaryText = formatMessagesForSummary(oldHistory).slice(0, 4000);
  }

  const passNumber = state.passCount + 1;
  const summaryMessage: ChatMessage = {
    role: "system",
    content: `[COMPACTED HISTORY — Pass ${passNumber}]\n${summaryText}`,
  };

  let result = [...head, summaryMessage, ...tail];

  // Safety net: ensure we're under 85% of window
  result = enforceTokenBudget(result, Math.floor(windowTokens * 0.85));

  const after = estimateMessagesTokens(result);
  return {
    messages: result,
    removedTokens: before - after,
  };
}
