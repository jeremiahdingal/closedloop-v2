/**
 * Plan Runner
 * Runs the epic decoder in interactive "plan mode" — for use by plan sessions.
 * Completely detached from the main build/ticket/reviewer pipeline.
 */

import type { ModelGateway, StreamHook } from "./models.ts";
import type { GoalDecomposition } from "../types.ts";
import type { AppDatabase } from "../db/database.ts";
import { epicDecoderPlanModePrompt } from "./prompts.ts";
import { ensureProjectStructureFile } from "./project-structure.ts";
import { buildContextForQuery } from "../rag/context-builder.ts";
import { git } from "../bridge/git.ts";
import { parseJsonText, validateGoalDecomposition } from "./validation.ts";

export interface PlanRunInput {
  cwd: string;
  epicTitle: string;
  epicDescription: string;
  userMessages: string[];
  gateway: ModelGateway;
  db?: AppDatabase;
  onStream?: StreamHook;
  sessionId?: string;
}

export interface PlanRunResult {
  plan: GoalDecomposition;
  rawText: string;
}

/**
 * Run the epic decoder in plan mode and return the resulting GoalDecomposition.
 * Uses the mediated/qwen/codex/opencode path depending on the configured epicDecoder model.
 * Falls back to plain Ollama if all tool-using paths are unavailable.
 *
 * This function is ONLY called from plan sessions and is entirely separate from
 * GoalRunner.runEpicDecoder — it never writes to the DB, never records events,
 * and never creates runs, tickets, or epics.
 */
export async function runPlanDecoder(input: PlanRunInput): Promise<PlanRunResult> {
  const emit = (content: string) =>
    input.onStream?.({
      agentRole: "epicDecoder",
      source: "orchestrator",
      streamKind: "status",
      content,
      sequence: 0,
    });

  emit("Loading project structure…");
  const [projectStructure, ragCtx] = await Promise.all([
    ensureProjectStructureFile(input.cwd).catch(() => null),
    input.db
      ? git(input.cwd, ["rev-parse", "HEAD"])
          .then(({ stdout }) => {
            emit("Building RAG context…");
            return buildContextForQuery({
              query: `${input.epicTitle} ${input.epicDescription}`.slice(0, 1000),
              db: input.db!,
              repoRoot: input.cwd,
              commitHash: stdout.trim(),
              onProgress: (msg) => emit(msg),
            });
          })
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const prompt = epicDecoderPlanModePrompt(
    input.epicTitle,
    input.epicDescription,
    input.userMessages,
    projectStructure,
    ragCtx
  );

  const { gateway } = input;
  const planSessionId = input.sessionId ?? "plan";
  const configuredModel = gateway.models.epicDecoder;

  // Mirror the same routing logic as GoalRunner.runEpicDecoder
  // to avoid sending qwen-cli/codex-cli as model IDs to OpenCode.

  // qwen-cli / codex-cli — runs via QwenRunner / CodexRunner
  if (
    gateway.runEpicDecoderInWorkspace &&
    (configuredModel === "codex-cli" || configuredModel === "qwen-cli")
  ) {
    try {
      const result = await gateway.runEpicDecoderInWorkspace({
        cwd: input.cwd,
        prompt,
        runId: null,
        epicId: planSessionId,
        onStream: input.onStream,
      });
      return { plan: result, rawText: JSON.stringify(result) };
    } catch (err) {
      console.warn(`[PlanRunner] ${configuredModel} failed: ${err}. Falling back to Ollama.`);
    }
  }

  // opencode:<model> — runs via OpenCodeRunner
  if (gateway.runEpicDecoderOpenCode && configuredModel.startsWith("opencode:")) {
    try {
      const result = await gateway.runEpicDecoderOpenCode({
        cwd: input.cwd,
        prompt,
        runId: null,
        epicId: planSessionId,
        onStream: input.onStream,
      });
      return { plan: result, rawText: JSON.stringify(result) };
    } catch (err) {
      console.warn(`[PlanRunner] OpenCode decoder failed: ${err}. Falling back to Ollama.`);
    }
  }

  // mediated:<model> — runs via MediatedAgentHarness
  if (gateway.runEpicDecoderInWorkspace && configuredModel.startsWith("mediated:")) {
    try {
      const result = await gateway.runEpicDecoderInWorkspace({
        cwd: input.cwd,
        prompt,
        runId: null,
        epicId: planSessionId,
        onStream: input.onStream,
      });
      return { plan: result, rawText: JSON.stringify(result) };
    } catch (err) {
      console.warn(`[PlanRunner] Mediated harness failed: ${err}. Falling back to Ollama.`);
    }
  }

  // Pure Ollama fallback — response is prose with embedded FINAL_JSON block
  emit("Querying model (no streaming on this path — output will appear when complete)…");
  const rawText = await gateway.rawPrompt("epicDecoder", prompt);
  const plan = validateGoalDecomposition(parseJsonText(rawText));
  return { plan, rawText };
}

/**
 * Extract the latest GoalDecomposition from accumulated stream text.
 * Returns null if no valid FINAL_JSON block is found yet.
 */
export function extractPlanFromStream(chunks: string[]): GoalDecomposition | null {
  const combined = chunks.join("");
  const match = combined.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/);
  if (!match) return null;
  try {
    return validateGoalDecomposition(JSON.parse(match[1].trim()));
  } catch {
    return null;
  }
}
