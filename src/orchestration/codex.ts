import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.ts";
import type { AgentRole, AgentStreamPayload, GoalDecomposition, GoalReview } from "../types.ts";
import { validateGoalDecomposition, validateGoalReview, parseJsonText } from "./validation.ts";

export type CodexTaskInput = {
  role: Extract<AgentRole, "epicDecoder" | "epicReviewer" | "builder">;
  cwd: string;
  prompt: string;
  runId?: string | null;
  ticketId?: string | null;
  epicId?: string | null;
  onStream?: (event: AgentStreamPayload) => void;
};

export type CodexLaunchInfo = {
  cwd: string;
  repoRoot: string;
  promptLength: number;
  command: string;
  args: string[];
  shell: string | boolean;
  cwdExists: boolean;
  cwdIsDirectory: boolean;
};

export type CodexLaunchKind =
  | "invalid_cwd"
  | "missing_binary"
  | "spawn_error"
  | "exit_error";

export class CodexLaunchError extends Error {
  readonly kind: CodexLaunchKind;
  readonly launchInfo: CodexLaunchInfo;
  readonly exitCode: number | null;
  readonly cause?: unknown;

  constructor(
    kind: CodexLaunchKind,
    message: string,
    launchInfo: CodexLaunchInfo,
    options?: { exitCode?: number | null; cause?: unknown }
  ) {
    super(message);
    this.name = "CodexLaunchError";
    this.kind = kind;
    this.launchInfo = launchInfo;
    this.exitCode = options?.exitCode ?? null;
    this.cause = options?.cause;
  }

  get isInfrastructureFailure(): boolean {
    return this.kind !== "exit_error";
  }
}

type CodexRunnerOptions = {
  spawnImpl?: typeof spawn;
};

function buildLaunchInfo(input: {
  cwd: string;
  repoRoot: string;
  promptLength: number;
  cwdExists: boolean;
  cwdIsDirectory: boolean;
}): CodexLaunchInfo {
  const isWin = process.platform === "win32";
  return {
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    promptLength: input.promptLength,
    command: "codex",
    args: ["exec", "--yolo", "--skip-git-repo-check", "-C", input.cwd, "-"],
    shell: isWin ? "cmd.exe" : true, // Use cmd.exe on Windows to avoid PowerShell quirks
    cwdExists: input.cwdExists,
    cwdIsDirectory: input.cwdIsDirectory
  };
}

function describeLaunchInfo(info: CodexLaunchInfo): string {
  return [
    `cwd=${info.cwd}`,
    `command=${info.command}`,
    `promptLength=${info.promptLength}`,
    `cwdExists=${String(info.cwdExists)}`,
    `cwdIsDirectory=${String(info.cwdIsDirectory)}`
  ].join(" ");
}

export function formatCodexFailure(error: unknown): string {
  if (error instanceof CodexLaunchError) {
    const extra = error.exitCode == null ? "" : ` exitCode=${error.exitCode}`;
    const cause = error.cause instanceof Error ? ` cause=${error.cause.message}` : error.cause ? ` cause=${String(error.cause)}` : "";
    return `Codex launch failed [${error.kind}]${extra}${cause}: ${error.message}. ${describeLaunchInfo(error.launchInfo)}`;
  }
  if (error instanceof Error) return `Codex failed: ${error.message}`;
  return `Codex failed: ${String(error)}`;
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
  const direct = tagged?.[1] ?? raw;
  const candidates = extractJsonObjectCandidates(direct);
  if (!candidates.length) throw new Error("Codex output did not contain any JSON object candidates.");

  let fallback: unknown = null;
  let lastError: Error | null = null;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
      if (fallback == null) fallback = parsed;
    } catch (error) {
      lastError = error as Error;
    }
  }

  if (fallback != null) return fallback;
  if (lastError) throw lastError;
  throw new Error("Codex output did not contain a valid final JSON object.");
}

export class CodexRunner {
  private readonly spawnImpl: typeof spawn;

  constructor(options?: CodexRunnerOptions) {
    this.spawnImpl = options?.spawnImpl ?? spawn;
  }

  async resolveLaunch(input: { cwd: string; promptLength: number }): Promise<{ command: string; args: string[]; info: CodexLaunchInfo }> {
    const config = loadConfig();
    const cwd = path.resolve(input.cwd);
    const cwdStat = await stat(cwd)
      .then((value) => ({ exists: true, isDirectory: value.isDirectory() }))
      .catch(() => ({ exists: false, isDirectory: false }));

    const info = buildLaunchInfo({
      cwd,
      repoRoot: config.repoRoot,
      promptLength: input.promptLength,
      cwdExists: cwdStat.exists,
      cwdIsDirectory: cwdStat.isDirectory
    });

    if (!cwdStat.exists || !cwdStat.isDirectory) {
      throw new CodexLaunchError("invalid_cwd", `Codex workspace cwd does not exist or is not a directory: ${cwd}`, info);
    }

    return {
      command: info.command,
      args: info.args,
      info
    };
  }

  async runEpicDecoder(input: CodexTaskInput): Promise<GoalDecomposition> {
    const raw = await this.runRaw(input);
    try {
      const parsed = tryExtractJson(raw.combined);
      return validateGoalDecomposition(parsed);
    } catch {
      return validateGoalDecomposition(parseJsonText(raw.combined));
    }
  }

  async runEpicReviewer(input: CodexTaskInput): Promise<GoalReview> {
    const raw = await this.runRaw(input);
    try {
      const parsed = tryExtractJson(raw.combined);
      return validateGoalReview(parsed);
    } catch {
      return validateGoalReview(parseJsonText(raw.combined));
    }
  }

  async runBuilder(input: CodexTaskInput): Promise<import("../types.ts").OpenCodeBuilderResult> {
    const raw = await this.runRaw(input);
    return {
      summary: "Codex CLI build completed",
      sessionId: null,
      rawOutput: raw.combined
    };
  }

  private async runRaw(input: CodexTaskInput): Promise<{ combined: string; launchInfo: CodexLaunchInfo }> {
    const launch = await this.resolveLaunch({ cwd: input.cwd, promptLength: input.prompt.length });
    const args = [...launch.args];
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
      const child = this.spawnImpl(launch.command, args, {
        cwd: launch.info.cwd,
        env: { ...process.env },
        shell: launch.info.shell,
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
      child.stdin?.write(input.prompt);
      child.stdin?.end();
      child.on("error", (error) =>
        reject(new CodexLaunchError("spawn_error", `Codex spawn failed: ${(error as Error).message}`, launch.info, { cause: error }))
      );
      child.on("close", (code) => {
        emit("status", code === 0 ? "completed" : `failed (${code ?? 1})`, true);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new CodexLaunchError("exit_error", `Codex exited with code ${code ?? 1}`, launch.info, { exitCode: code ?? 1 }));
      });
    });

    return { combined: chunks.join(""), launchInfo: launch.info };
  }
}
