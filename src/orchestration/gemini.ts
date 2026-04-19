import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.ts";
import type { AgentRole, AgentStreamPayload, GoalDecomposition, GoalReview, OpenCodeBuilderResult } from "../types.ts";
import { parseJsonText, validateGoalDecomposition, validateGoalReview } from "./validation.ts";

export type GeminiTaskInput = {
  role: Extract<AgentRole, "epicDecoder" | "epicReviewer" | "builder">;
  cwd: string;
  prompt: string;
  runId?: string | null;
  ticketId?: string | null;
  epicId?: string | null;
  onStream?: (event: AgentStreamPayload) => void;
};

export type GeminiLaunchInfo = {
  cwd: string;
  repoRoot: string;
  promptLength: number;
  command: string;
  args: string[];
  shell: boolean;
  cwdExists: boolean;
  cwdIsDirectory: boolean;
};

export type GeminiLaunchKind =
  | "invalid_cwd"
  | "missing_binary"
  | "spawn_error"
  | "exit_error";

export class GeminiLaunchError extends Error {
  readonly kind: GeminiLaunchKind;
  readonly launchInfo: GeminiLaunchInfo;
  readonly exitCode: number | null;
  readonly cause?: unknown;

  constructor(
    kind: GeminiLaunchKind,
    message: string,
    launchInfo: GeminiLaunchInfo,
    options?: { exitCode?: number | null; cause?: unknown }
  ) {
    super(message);
    this.name = "GeminiLaunchError";
    this.kind = kind;
    this.launchInfo = launchInfo;
    this.exitCode = options?.exitCode ?? null;
    this.cause = options?.cause;
  }

  get isInfrastructureFailure(): boolean {
    return this.kind !== "exit_error";
  }
}

type GeminiRunnerOptions = {
  spawnImpl?: typeof spawn;
};

function buildArgs(prompt: string): string[] {
  // Gemini CLI flags: --approval-mode yolo --output-format text -p (for prompt)
  // But we want to pipe to stdin if possible for large prompts
  const args = ["--approval-mode", "yolo", "--output-format", "text"];
  const model = process.env.GEMINI_CLI_MODEL?.trim();
  if (model) args.push("--model", model);
  return args;
}

function buildLaunchInfo(input: {
  cwd: string;
  repoRoot: string;
  promptLength: number;
  args: string[];
  cwdExists: boolean;
  cwdIsDirectory: boolean;
}): GeminiLaunchInfo {
  return {
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    promptLength: input.promptLength,
    command: "gemini",
    args: input.args,
    shell: true,
    cwdExists: input.cwdExists,
    cwdIsDirectory: input.cwdIsDirectory
  };
}

function describeLaunchInfo(info: GeminiLaunchInfo): string {
  return [
    `cwd=${info.cwd}`,
    `command=${info.command}`,
    `promptLength=${info.promptLength}`,
    `cwdExists=${String(info.cwdExists)}`,
    `cwdIsDirectory=${String(info.cwdIsDirectory)}`
  ].join(" ");
}

export function formatGeminiFailure(error: unknown): string {
  if (error instanceof GeminiLaunchError) {
    const extra = error.exitCode == null ? "" : ` exitCode=${error.exitCode}`;
    const cause = error.cause instanceof Error ? ` cause=${error.cause.message}` : error.cause ? ` cause=${String(error.cause)}` : "";
    return `Gemini CLI failed [${error.kind}]${extra}${cause}: ${error.message}. ${describeLaunchInfo(error.launchInfo)}`;
  }
  if (error instanceof Error) return `Gemini CLI failed: ${error.message}`;
  return `Gemini CLI failed: ${String(error)}`;
}

function tryExtractJson(raw: string): any {
  // Try to find JSON in the output. Gemini CLI might wrap it in code blocks or tags.
  const tagged = raw.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/i);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const direct = (tagged?.[1] ?? fenced?.[1] ?? raw).trim();
  
  return parseJsonText(direct);
}

export class GeminiRunner {
  private readonly spawnImpl: typeof spawn;

  constructor(options?: GeminiRunnerOptions) {
    this.spawnImpl = options?.spawnImpl ?? spawn;
  }

  async resolveLaunch(input: { cwd: string; prompt: string }): Promise<{ command: string; args: string[]; info: GeminiLaunchInfo }> {
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
      throw new GeminiLaunchError("invalid_cwd", `Gemini workspace cwd does not exist or is not a directory: ${cwd}`, info);
    }

    return {
      command: "gemini",
      args,
      info
    };
  }

  async runEpicDecoder(input: GeminiTaskInput): Promise<GoalDecomposition> {
    const raw = await this.runRaw(input);
    try {
      const parsed = tryExtractJson(raw.combined);
      return validateGoalDecomposition(parsed);
    } catch {
      // Fallback to basic parsing if structured extraction fails
      return validateGoalDecomposition(parseJsonText(raw.combined));
    }
  }

  async runEpicReviewer(input: GeminiTaskInput): Promise<GoalReview> {
    const raw = await this.runRaw(input);
    try {
      const parsed = tryExtractJson(raw.combined);
      return validateGoalReview(parsed);
    } catch {
      return validateGoalReview(parseJsonText(raw.combined));
    }
  }

  async runBuilder(input: GeminiTaskInput): Promise<OpenCodeBuilderResult> {
    const raw = await this.runRaw(input);
    return {
      summary: "Gemini CLI build completed",
      sessionId: null,
      rawOutput: raw.combined
    };
  }

  private async runRaw(input: GeminiTaskInput): Promise<{ combined: string; launchInfo: GeminiLaunchInfo }> {
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

    emit("system", `--- PROMPT ---\n${input.prompt}\n--------------`);

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
        reject(new GeminiLaunchError("spawn_error", `Gemini spawn failed: ${(error as Error).message}`, launch.info, { cause: error }))
      );
      child.on("close", (code) => {
        emit("status", code === 0 ? "completed" : `failed (${code ?? 1})`, true);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new GeminiLaunchError("exit_error", `Gemini exited with code ${code ?? 1}`, launch.info, { exitCode: code ?? 1 }));
      });

      // Write prompt to stdin
      child.stdin?.write(input.prompt);
      child.stdin?.end();
    });

    return { combined: chunks.join(""), launchInfo: launch.info };
  }
}
