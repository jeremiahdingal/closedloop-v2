import type { ChatMessage } from "./types.ts";
import type { BannedCallSignature, DuplicateRecoveryState } from "./types.ts";
import type { CallHistory } from "./validator.ts";
import { stableStringify } from "./validator.ts";
import { formatMessagesForSummary, COMPACTION_MODEL } from "./context-budget.ts";

// ─── Recovery state factory ────────────────────────────────────────────────

export function createDuplicateRecoveryState(): DuplicateRecoveryState {
  return {
    bannedSignatures: [],
    recoveryCount: 0,
    postRecoveryCallCount: 0,
    isInRecovery: false,
    hasMadeProgress: false,
  };
}

// ─── Error classification ──────────────────────────────────────────────────

function classifyError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("enoent") || lower.includes("does not exist") || lower.includes("not found")) return "ENOENT";
  if (lower.includes("permission") || lower.includes("eacces") || lower.includes("forbidden")) return "PERMISSION";
  if (lower.includes("timeout") || lower.includes("timed out")) return "TIMEOUT";
  if (lower.includes("validation") || lower.includes("invalid")) return "VALIDATION";
  if (lower.includes("command failed") || lower.includes("exit code")) return "COMMAND_FAILED";
  return "UNKNOWN";
}

// ─── Duplicate check ──────────────────────────────────────────────────────

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  bannedSignature?: BannedCallSignature;
}

/**
 * Check if a tool call is a duplicate of a prior errored call.
 * Uses the last 20 call records from history.
 */
export function checkDuplicateCall(
  name: string,
  args: Record<string, unknown>,
  history: CallHistory,
  _state: DuplicateRecoveryState,
): DuplicateCheckResult {
  const hash = stableStringify(args);
  const recentRecords = history.getRecentCalls(20);

  // Search backwards for the most recent matching errored call
  for (let i = recentRecords.length - 1; i >= 0; i--) {
    const record = recentRecords[i];
    if (record.name === name && record.argsHash === hash && record.isError) {
      const errorMsg = history.getErrorMessage(name, hash) ?? "Unknown error";
      const sig: BannedCallSignature = {
        toolName: name,
        argsHash: hash,
        errorMessage: errorMsg,
        errorKind: classifyError(errorMsg),
        bannedAt: Date.now(),
      };
      return { isDuplicate: true, bannedSignature: sig };
    }
  }

  return { isDuplicate: false };
}

// ─── Banned signature check ──────────────────────────────────────────────

export function isCallBanned(
  name: string,
  args: Record<string, unknown>,
  state: DuplicateRecoveryState,
): boolean {
  const hash = stableStringify(args);
  return state.bannedSignatures.some(
    sig => sig.toolName === name && sig.argsHash === hash,
  );
}

// ─── Recovery compaction ─────────────────────────────────────────────────

const RECOVERY_SYSTEM_PROMPT = `You are compressing a stalled coding-agent session into a recovery packet.

Rules:
- Preserve exact file paths, tool names, command names, and error messages.
- Do not invent files or implementation details.
- Do not solve the ticket.
- Explain what failed and why.
- Explain what the next model must avoid.
- Suggest only safe next tool calls.

Return strict JSON:
{
  "objective": "...",
  "knownFacts": [],
  "failedAction": {
    "toolName": "...",
    "args": {},
    "error": "...",
    "whyItLikelyFailed": "..."
  },
  "bannedActions": [],
  "recommendedNextToolCalls": [],
  "handoffPrompt": "..."
}`;

export async function performDuplicateRecovery(
  messages: ChatMessage[],
  systemPrompt: string,
  bannedSig: BannedCallSignature,
  numCtx: number,
  baseURL: string,
): Promise<string> {
  // 1. Build raw recovery packet
  const historyText = formatMessagesForSummary(messages);

  const rawPacket = {
    failedAction: {
      toolName: bannedSig.toolName,
      argsHash: bannedSig.argsHash,
      error: bannedSig.errorMessage,
      errorKind: bannedSig.errorKind,
    },
    recentHistory: historyText.slice(0, 6000),
  };

  // 2. Try compactor model
  let compactedJson: string | null = null;

  try {
    const response = await fetch(`${baseURL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: COMPACTION_MODEL,
        messages: [
          { role: "system", content: RECOVERY_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Compress this stalled session:\n\n${JSON.stringify(rawPacket, null, 2)}`,
          },
        ],
        stream: false,
        options: { temperature: 0.2 },
      }),
    });

    if (response.ok) {
      const payload = await response.json() as { message?: { content?: string } };
      const content = payload.message?.content?.trim() ?? "";
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        compactedJson = jsonMatch[0];
      }
    }
  } catch (err) {
    console.warn(`[duplicate-recovery] Compactor call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Build recovery prompt
  const bannedDescription = `Tool: ${bannedSig.toolName}, Error: ${bannedSig.errorMessage} (${bannedSig.errorKind})`;

  let recoveryPrompt: string;

  if (compactedJson) {
    try {
      const parsed = JSON.parse(compactedJson) as {
        objective?: string;
        knownFacts?: string[];
        failedAction?: { toolName: string; args: unknown; error: string; whyItLikelyFailed: string };
        bannedActions?: string[];
        recommendedNextToolCalls?: string[];
        handoffPrompt?: string;
      };

      recoveryPrompt = `You are recovering a stalled coding ticket. The previous builder repeated a failed tool call and you are starting from a clean context.

Hard rules:
1. Do not repeat any banned tool call.
2. If a tool call is banned, choose a different discovery action.
3. Prefer list_dir, grep_files, or read_file with corrected paths.
4. If you cannot make progress within 3 tool calls, finish with a blocker.
5. Do not guess file contents. Do not invent paths.

Objective: ${parsed.objective ?? "Continue the ticket from where it stalled."}

Failed action: ${parsed.failedAction?.toolName ?? bannedSig.toolName} — ${parsed.failedAction?.error ?? bannedSig.errorMessage}
Why it likely failed: ${parsed.failedAction?.whyItLikelyFailed ?? "Unknown"}

Known facts:
${(parsed.knownFacts ?? []).map(f => `- ${f}`).join("\n")}

Banned actions:
- ${bannedDescription}
${(parsed.bannedActions ?? []).map(a => `- ${a}`).join("\n")}

Recommended next moves:
${(parsed.recommendedNextToolCalls ?? []).map(m => `- ${m}`).join("\n")}

${parsed.handoffPrompt ?? ""}`;
    } catch {
      recoveryPrompt = buildFallbackRecoveryPrompt(bannedSig, historyText);
    }
  } else {
    recoveryPrompt = buildFallbackRecoveryPrompt(bannedSig, historyText);
  }

  return recoveryPrompt;
}

function buildFallbackRecoveryPrompt(bannedSig: BannedCallSignature, historyText: string): string {
  const recentSummary = historyText.slice(-4000);
  return `You are recovering a stalled coding ticket. The previous builder repeated a failed tool call and you are starting from a clean context.

Hard rules:
1. Do not repeat any banned tool call.
2. If a tool call is banned, choose a different discovery action.
3. Prefer list_dir, grep_files, or read_file with corrected paths.
4. If you cannot make progress within 3 tool calls, finish with a blocker.
5. Do not guess file contents. Do not invent paths.

Banned action: Tool: ${bannedSig.toolName}, Error: ${bannedSig.errorMessage} (${bannedSig.errorKind})
You MUST NOT call ${bannedSig.toolName} with the same arguments that caused this error.

Recent context summary:
${recentSummary}

Find a different approach to accomplish the ticket objective.`;
}

// ─── Post-recovery progress tracking ─────────────────────────────────────

const MAX_POST_RECOVERY_CALLS = 3;

export function recordPostRecoveryProgress(
  state: DuplicateRecoveryState,
  isError: boolean,
): DuplicateRecoveryState {
  return {
    ...state,
    postRecoveryCallCount: state.postRecoveryCallCount + 1,
    hasMadeProgress: state.hasMadeProgress || !isError,
  };
}

export function shouldForceFinishAfterRecovery(state: DuplicateRecoveryState): boolean {
  if (!state.isInRecovery) return false;
  return state.postRecoveryCallCount >= MAX_POST_RECOVERY_CALLS && !state.hasMadeProgress;
}
