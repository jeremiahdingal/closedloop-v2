import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.ts";
import type { AgentRole, AgentStreamPayload, GoalDecomposition, GoalReview } from "../types.ts";
import { parseJsonText, validateGoalDecomposition, validateGoalReview } from "./validation.ts";

export type ZaiTaskInput = {
  role: Extract<AgentRole, "epicDecoder" | "epicReviewer" | "builder"> | string;
  cwd?: string;
  prompt: string;
  runId?: string | null;
  ticketId?: string | null;
  epicId?: string | null;
  onStream?: (event: AgentStreamPayload) => void;
};

export type ZaiLaunchInfo = {
  cwd: string;
  repoRoot: string;
  promptLength: number;
  command: string;
  args: string[];
  shell: string | boolean;
  cwdExists: boolean;
  cwdIsDirectory: boolean;
  model: string;
};

export type ZaiLaunchKind =
  | "invalid_cwd"
  | "missing_api_key"
  | "spawn_error"
  | "exit_error";

export class ZaiLaunchError extends Error {
  readonly kind: ZaiLaunchKind;
  readonly launchInfo: ZaiLaunchInfo;
  readonly exitCode: number | null;
  readonly cause?: unknown;

  constructor(
    kind: ZaiLaunchKind,
    message: string,
    launchInfo: ZaiLaunchInfo,
    options?: { exitCode?: number | null; cause?: unknown }
  ) {
    super(message);
    this.name = "ZaiLaunchError";
    this.kind = kind;
    this.launchInfo = launchInfo;
    this.exitCode = options?.exitCode ?? null;
    this.cause = options?.cause;
  }

  get isInfrastructureFailure(): boolean {
    return this.kind !== "exit_error";
  }
}

type ZaiRunnerOptions = {
  spawnImpl?: typeof spawn;
  apiKey?: string;
  baseURL?: string;
  model?: string;
};

const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/anthropic";
const DEFAULT_ZAI_MODEL = "glm-5.1";

type ZaiRuntimeSettings = {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
};

function parseDotEnvFile(filePath: string): Record<string, string> {
  try {
    const raw = readFileSync(filePath, "utf8");
    const values: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\""))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function buildArgs(cwd: string, model: string): string[] {
  return [
    "-p",
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    "--add-dir",
    cwd,
    "--model",
    model
  ];
}

function buildLaunchInfo(input: {
  cwd: string;
  repoRoot: string;
  promptLength: number;
  args: string[];
  cwdExists: boolean;
  cwdIsDirectory: boolean;
  model: string;
}): ZaiLaunchInfo {
  const isWin = process.platform === "win32";
  return {
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    promptLength: input.promptLength,
    command: "claude",
    args: input.args,
    shell: isWin ? "cmd.exe" : true,
    cwdExists: input.cwdExists,
    cwdIsDirectory: input.cwdIsDirectory,
    model: input.model
  };
}

function describeLaunchInfo(info: ZaiLaunchInfo): string {
  return [
    `cwd=${info.cwd}`,
    `command=${info.command}`,
    `model=${info.model}`,
    `promptLength=${info.promptLength}`,
    `cwdExists=${String(info.cwdExists)}`,
    `cwdIsDirectory=${String(info.cwdIsDirectory)}`
  ].join(" ");
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
  if (!candidates.length) throw new Error("Z AI Claude output did not contain any JSON object candidates.");

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
  throw new Error("Z AI Claude output did not contain a valid final JSON object.");
}

export function formatZaiFailure(error: unknown): string {
  if (error instanceof ZaiLaunchError) {
    const extra = error.exitCode == null ? "" : ` exitCode=${error.exitCode}`;
    const cause = error.cause instanceof Error ? ` cause=${error.cause.message}` : error.cause ? ` cause=${String(error.cause)}` : "";
    return `Z AI Claude failed [${error.kind}]${extra}${cause}: ${error.message}. ${describeLaunchInfo(error.launchInfo)}`;
  }
  if (error instanceof Error) return `Z AI Claude failed: ${error.message}`;
  return `Z AI Claude failed: ${String(error)}`;
}

export class ZaiRunner {
  private readonly spawnImpl: typeof spawn;
  private readonly apiKeyOverride?: string;
  private readonly baseURLOverride?: string;
  private readonly defaultModelOverride?: string;

  constructor(opts?: ZaiRunnerOptions) {
    this.spawnImpl = opts?.spawnImpl ?? spawn;
    this.apiKeyOverride = opts?.apiKey;
    this.baseURLOverride = opts?.baseURL;
    this.defaultModelOverride = opts?.model;
  }

  private resolveRuntimeSettings(): ZaiRuntimeSettings {
    const config = loadConfig();
    const dotEnv = parseDotEnvFile(path.resolve(config.repoRoot, ".env"));

    return {
      apiKey: firstNonEmpty(
        this.apiKeyOverride,
        process.env.ANTHROPIC_AUTH_TOKEN,
        process.env.ZAI_API_KEY,
        dotEnv.ANTHROPIC_AUTH_TOKEN,
        dotEnv.ZAI_API_KEY
      ) ?? "",
      baseURL: firstNonEmpty(
        this.baseURLOverride,
        process.env.ANTHROPIC_BASE_URL,
        process.env.ZAI_BASE_URL,
        dotEnv.ANTHROPIC_BASE_URL,
        dotEnv.ZAI_BASE_URL
      ) ?? DEFAULT_ZAI_BASE_URL,
      defaultModel: firstNonEmpty(
        this.defaultModelOverride,
        process.env.ZAI_MODEL,
        dotEnv.ZAI_MODEL
      ) ?? DEFAULT_ZAI_MODEL
    };
  }

  resolveModel(configValue: string): string {
    const runtime = this.resolveRuntimeSettings();
    if (configValue.startsWith("zai:")) return configValue.slice(4);
    return runtime.defaultModel;
  }

  async rawPrompt(
    role: string,
    prompt: string,
    model: string,
    onStream?: ZaiTaskInput["onStream"],
    meta?: { runId?: string | null; ticketId?: string | null; epicId?: string | null }
  ): Promise<string> {
    const runtime = this.resolveRuntimeSettings();
    const url = `${runtime.baseURL}/v1/messages`;
    let sequence = 0;

    const emit = (streamKind: AgentStreamPayload["streamKind"], content: string, done = false) => {
      if (!content && !done) return;
      onStream?.({
        agentRole: role as AgentStreamPayload["agentRole"],
        source: "zai",
        streamKind,
        content,
        runId: meta?.runId ?? null,
        ticketId: meta?.ticketId ?? null,
        epicId: meta?.epicId ?? null,
        sequence: sequence++,
        done,
        metadata: { model },
      });
    };

    emit("system", `Calling Z AI (${model})...`);

    if (!runtime.apiKey) {
      throw new Error("Missing Z AI API key. Set ZAI_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment or repo .env file.");
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": runtime.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(900_000),
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Z AI returned ${response.status}: ${body}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body from Z AI");

    const decoder = new TextDecoder();
    let buffer = "";
    let combined = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("event:")) continue;
        if (!trimmed.startsWith("data:")) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);

          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            const text = event.delta.text;
            combined += text;
            emit("assistant", text);
          }

          if (event.type === "message_delta" && event.delta?.stop_reason) {
            emit("status", `completed (${event.delta.stop_reason})`, true);
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    return combined;
  }

  async resolveLaunch(input: { cwd: string; prompt: string; model: string }): Promise<{ command: string; args: string[]; info: ZaiLaunchInfo; env: NodeJS.ProcessEnv }> {
    const config = loadConfig();
    const runtime = this.resolveRuntimeSettings();
    const cwd = path.resolve(input.cwd);
    const cwdStat = await stat(cwd)
      .then((value) => ({ exists: true, isDirectory: value.isDirectory() }))
      .catch(() => ({ exists: false, isDirectory: false }));

    const args = buildArgs(cwd, input.model);
    const info = buildLaunchInfo({
      cwd,
      repoRoot: config.repoRoot,
      promptLength: input.prompt.length,
      args,
      cwdExists: cwdStat.exists,
      cwdIsDirectory: cwdStat.isDirectory,
      model: input.model
    });

    if (!cwdStat.exists || !cwdStat.isDirectory) {
      throw new ZaiLaunchError("invalid_cwd", `Z AI Claude workspace cwd does not exist or is not a directory: ${cwd}`, info);
    }

    const apiKey = firstNonEmpty(
      process.env.ANTHROPIC_AUTH_TOKEN,
      process.env.ZAI_API_KEY,
      runtime.apiKey
    ) ?? "";
    if (!apiKey) {
      throw new ZaiLaunchError("missing_api_key", "Missing Z AI / Anthropic auth token for Claude CLI launch.", info);
    }

    const env = {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_BASE_URL: firstNonEmpty(process.env.ANTHROPIC_BASE_URL, runtime.baseURL) ?? DEFAULT_ZAI_BASE_URL,
      API_TIMEOUT_MS: process.env.API_TIMEOUT_MS || "3000000"
    };

    return {
      command: info.command,
      args,
      info,
      env
    };
  }

  async runEpicDecoder(input: ZaiTaskInput & { cwd: string }): Promise<GoalDecomposition> {
    const raw = await this.runRaw(input);
    try {
      const parsed = tryExtractJson(raw.combined);
      return validateGoalDecomposition(parsed);
    } catch {
      return validateGoalDecomposition(parseJsonText(raw.combined));
    }
  }

  async runEpicReviewer(input: ZaiTaskInput & { cwd: string }): Promise<GoalReview> {
    const raw = await this.runRaw(input);
    try {
      const parsed = tryExtractJson(raw.combined);
      return validateGoalReview(parsed);
    } catch {
      return validateGoalReview(parseJsonText(raw.combined));
    }
  }

  async runBuilder(input: ZaiTaskInput & { cwd: string }): Promise<import("../types.ts").OpenCodeBuilderResult> {
    const raw = await this.runRaw(input);
    return {
      summary: "Z AI Claude CLI build completed",
      sessionId: null,
      rawOutput: raw.combined
    };
  }

  private async runRaw(input: ZaiTaskInput & { cwd: string }): Promise<{ combined: string; launchInfo: ZaiLaunchInfo }> {
    const configuredModel = loadConfig().models[input.role as AgentRole] ?? "";
    const model = this.resolveModel(configuredModel);
    const launch = await this.resolveLaunch({ cwd: input.cwd, prompt: input.prompt, model });
    const chunks: string[] = [];
    let sequence = 0;

    const emit = (streamKind: AgentStreamPayload["streamKind"], chunk: string, done = false) => {
      if (!chunk && !done) return;
      input.onStream?.({
        agentRole: input.role as AgentStreamPayload["agentRole"],
        source: "orchestrator",
        streamKind,
        content: chunk,
        runId: input.runId,
        ticketId: input.ticketId,
        epicId: input.epicId,
        sequence: sequence++,
        done,
        metadata: { cwd: input.cwd, command: launch.command, promptLength: launch.info.promptLength, model }
      });
    };

    emit("system", `--- PROMPT ---\n${input.prompt}\n--------------`);

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnImpl(launch.command, launch.args, {
        cwd: launch.info.cwd,
        env: launch.env,
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
      child.on("error", (error) =>
        reject(new ZaiLaunchError("spawn_error", `Z AI Claude spawn failed: ${(error as Error).message}`, launch.info, { cause: error }))
      );
      child.on("close", (code) => {
        emit("status", code === 0 ? "completed" : `failed (${code ?? 1})`, true);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new ZaiLaunchError("exit_error", `Z AI Claude exited with code ${code ?? 1}`, launch.info, { exitCode: code ?? 1 }));
      });

      child.stdin?.write(input.prompt);
      child.stdin?.end();
    });

    return { combined: chunks.join(""), launchInfo: launch.info };
  }
}
