import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.ts";
import type { AgentRole, AgentStreamPayload, GoalDecomposition, GoalReview } from "../types.ts";
import { parseJsonText, validateGoalDecomposition, validateGoalReview } from "./validation.ts";

export type QwenTaskInput = {
  role: Extract<AgentRole, "epicDecoder" | "epicReviewer">;
  cwd: string;
  prompt: string;
  runId?: string | null;
  ticketId?: string | null;
  epicId?: string | null;
  onStream?: (event: AgentStreamPayload) => void;
};

export type QwenLaunchInfo = {
  cwd: string;
  repoRoot: string;
  promptLength: number;
  command: string;
  args: string[];
  shell: boolean;
  cwdExists: boolean;
  cwdIsDirectory: boolean;
};

export type QwenLaunchKind =
  | "invalid_cwd"
  | "missing_binary"
  | "spawn_error"
  | "exit_error";

export class QwenLaunchError extends Error {
  readonly kind: QwenLaunchKind;
  readonly launchInfo: QwenLaunchInfo;
  readonly exitCode: number | null;
  readonly cause?: unknown;

  constructor(
    kind: QwenLaunchKind,
    message: string,
    launchInfo: QwenLaunchInfo,
    options?: { exitCode?: number | null; cause?: unknown }
  ) {
    super(message);
    this.name = "QwenLaunchError";
    this.kind = kind;
    this.launchInfo = launchInfo;
    this.exitCode = options?.exitCode ?? null;
    this.cause = options?.cause;
  }

  get isInfrastructureFailure(): boolean {
    return this.kind !== "exit_error";
  }
}

type QwenRunnerOptions = {
  spawnImpl?: typeof spawn;
};

function buildArgs(prompt: string): string[] {
  const args = ["--approval-mode", "yolo", "--output-format", "text", "-i"];
  const model = process.env.QWEN_CLI_MODEL?.trim();
  if (model) args.push("--model", model);
  return args;
}

function buildStrictJsonPrompt(prompt: string): string {
  return [
    "CRITICAL OUTPUT REQUIREMENT: Your FINAL output MUST end with exactly one <FINAL_JSON>...</FINAL_JSON> block containing valid JSON. This is mandatory.",
    "",
    prompt,
    "",
    "REMINDER - Output constraints (MANDATORY):",
    "1. You MUST end your response with exactly one <FINAL_JSON>...</FINAL_JSON> block.",
    "2. JSON must be strict RFC8259 JSON (double-quoted keys/strings, no trailing commas).",
    "3. The FINAL_JSON block is required even if you wrote analysis above it."
  ].join("\n");
}

function buildLaunchInfo(input: {
  cwd: string;
  repoRoot: string;
  promptLength: number;
  args: string[];
  cwdExists: boolean;
  cwdIsDirectory: boolean;
}): QwenLaunchInfo {
  return {
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    promptLength: input.promptLength,
    command: "qwen",
    args: input.args,
    shell: true,
    cwdExists: input.cwdExists,
    cwdIsDirectory: input.cwdIsDirectory
  };
}

function describeLaunchInfo(info: QwenLaunchInfo): string {
  return [
    `cwd=${info.cwd}`,
    `command=${info.command}`,
    `promptLength=${info.promptLength}`,
    `cwdExists=${String(info.cwdExists)}`,
    `cwdIsDirectory=${String(info.cwdIsDirectory)}`
  ].join(" ");
}

export function formatQwenFailure(error: unknown): string {
  if (error instanceof QwenLaunchError) {
    const extra = error.exitCode == null ? "" : ` exitCode=${error.exitCode}`;
    const cause = error.cause instanceof Error ? ` cause=${error.cause.message}` : error.cause ? ` cause=${String(error.cause)}` : "";
    return `Qwen CLI failed [${error.kind}]${extra}${cause}: ${error.message}. ${describeLaunchInfo(error.launchInfo)}`;
  }
  if (error instanceof Error) return `Qwen CLI failed: ${error.message}`;
  return `Qwen CLI failed: ${String(error)}`;
}

function extractJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function tryExtractJson(raw: string): any {
  const tagged = raw.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/i);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const direct = (tagged?.[1] ?? fenced?.[1] ?? raw).trim();
  const candidates = extractJsonObjectCandidates(direct);
  if (!candidates.length) throw new Error("Qwen output did not contain any JSON object candidates.");

  let fallback: unknown = null;
  let lastError: Error | null = null;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = parseJsonLike(candidates[index]);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
      if (fallback == null) fallback = parsed;
    } catch (error) {
      lastError = error as Error;
    }
  }

  if (fallback != null) return fallback;
  if (lastError) throw lastError;
  throw new Error("Qwen output did not contain a valid final JSON object.");
}

function parseJsonLike(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Handle common model deviations from strict JSON.
    const repaired = raw
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
      .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null")
      .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

export class QwenRunner {
  private readonly spawnImpl: typeof spawn;

  constructor(options?: QwenRunnerOptions) {
    this.spawnImpl = options?.spawnImpl ?? spawn;
  }

  async resolveLaunch(input: { cwd: string; prompt: string }): Promise<{ command: string; args: string[]; info: QwenLaunchInfo }> {
    const config = loadConfig();
    const cwd = path.resolve(input.cwd);
    const cwdStat = await stat(cwd)
      .then((value) => ({ exists: true, isDirectory: value.isDirectory() }))
      .catch(() => ({ exists: false, isDirectory: false }));

    const args = buildArgs(input.prompt);
    const info = buildLaunchInfo({
      cwd,
      repoRoot: config.repoRoot,
      promptLength: input.prompt.length,
      args,
      cwdExists: cwdStat.exists,
      cwdIsDirectory: cwdStat.isDirectory
    });

    if (!cwdStat.exists || !cwdStat.isDirectory) {
      throw new QwenLaunchError("invalid_cwd", `Qwen workspace cwd does not exist or is not a directory: ${cwd}`, info);
    }

    return {
      command: "qwen",
      args,
      info
    };
  }

  async runEpicDecoder(input: QwenTaskInput): Promise<GoalDecomposition> {
    const raw = await this.runRaw(input);
    try {
      const parsed = tryExtractJson(raw.combined);
      return validateGoalDecomposition(parsed);
    } catch {
      return validateGoalDecomposition(parseFallbackFromRaw(raw.combined));
    }
  }

  async runEpicReviewer(input: QwenTaskInput): Promise<GoalReview> {
    const raw = await this.runRaw(input);
    try {
      const parsed = tryExtractJson(raw.combined);
      return validateGoalReview(parsed);
    } catch {
      try {
        return validateGoalReview(parseFallbackFromRaw(raw.combined));
      } catch {
        // Last resort: extract verdict from markdown output
        return extractVerdictFromMarkdown(raw.combined);
      }
    }
  }

  private async runRaw(input: QwenTaskInput): Promise<{ combined: string; launchInfo: QwenLaunchInfo }> {
    const launch = await this.resolveLaunch({ cwd: input.cwd, prompt: input.prompt });
    const chunks: string[] = [];
    let sequence = 0;

    const emit = (streamKind: AgentStreamPayload["streamKind"], chunk: string, done = false) => {
      if (!chunk && !done) return;
      input.onStream?.({
        agentRole: input.role,
        source: "orchestrator",
        streamKind,
        content: chunk,
        runId: input.runId,
        ticketId: input.ticketId,
        epicId: input.epicId,
        sequence: sequence++,
        done,
        metadata: { cwd: input.cwd, command: launch.command, promptLength: launch.info.promptLength }
      });
    };

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnImpl(launch.command, launch.args, {
        cwd: launch.info.cwd,
        env: { ...process.env },
        shell: true,
        stdio: ["pipe", "pipe", "pipe"]
      });

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk: string) => {
        chunks.push(chunk);
        emit("assistant", chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        const kind = /think|reason/i.test(chunk) ? "thinking" : "stderr";
        emit(kind, chunk);
      });
      child.on("error", (error) =>
        reject(new QwenLaunchError("spawn_error", `Qwen spawn failed: ${(error as Error).message}`, launch.info, { cause: error }))
      );
      child.on("close", (code) => {
        emit("status", code === 0 ? "completed" : `failed (${code ?? 1})`, true);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new QwenLaunchError("exit_error", `Qwen exited with code ${code ?? 1}`, launch.info, { exitCode: code ?? 1 }));
      });

      child.stdin?.write(buildStrictJsonPrompt(input.prompt));
      child.stdin?.end();
    });

    return { combined: chunks.join(""), launchInfo: launch.info };
  }
}

function extractVerdictFromMarkdown(raw: string): GoalReview {
  const lower = raw.toLowerCase();

  // Look for explicit verdict indicators
  const hasFailure = /❌|fail|not implemented|not met|missing|broken|incomplete/i.test(raw);
  const hasApproval = /✅.*all|approved|all.*pass|looks good|no issues|no destructive/i.test(raw);
  const hasFollowup = /needs.followup|send.*back|retry|rework/i.test(lower);

  let verdict: "approved" | "needs_followups" | "failed";
  if (hasFollowup || (hasFailure && /send.*back|re-implement|retry/i.test(raw))) {
    verdict = "needs_followups";
  } else if (hasFailure) {
    verdict = "failed";
  } else if (hasApproval) {
    verdict = "approved";
  } else {
    // Default: if qwen produced a review without clear signals, treat as approved
    verdict = "approved";
  }

  // Extract a summary from the first few lines
  const lines = raw.split("\n").filter(l => l.trim());
  const summary = lines.slice(0, 5).join(" ").substring(0, 500) || "Review completed (parsed from markdown output).";

  return {
    verdict,
    summary,
    followupTickets: []
  };
}

function parseFallbackFromRaw(raw: string): unknown {
  try {
    return parseJsonText(raw);
  } catch {
    const firstBrace = raw.indexOf("{");
    if (firstBrace >= 0) {
      const tail = raw.slice(firstBrace);
      const candidates = extractJsonObjectCandidates(tail);
      if (candidates.length) return parseJsonLike(candidates[candidates.length - 1]);
    }
    console.error("[Qwen] Failed to parse JSON. Raw output:", raw.substring(0, 2000));
    throw new Error("Qwen output could not be parsed as JSON.");
  }
}
