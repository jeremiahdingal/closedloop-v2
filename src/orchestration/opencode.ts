import { createRequire } from "node:module";
import path from "node:path";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { loadConfig } from "../config.ts";
import type { AgentRole, AgentStreamPayload, GoalReview, OpenCodeBuilderResult, OpenCodeLaunchInfo } from "../types.ts";
import { truncate } from "../utils.ts";
import { parseJsonText } from "./validation.ts";

export type OpenCodeTaskInput = {
  role: Extract<AgentRole, "builder" | "epicDecoder" | "epicReviewer">;
  cwd: string;
  prompt: string;
  runId?: string | null;
  ticketId?: string | null;
  epicId?: string | null;
  onStream?: (event: AgentStreamPayload) => void;
};

export type OpenCodeLaunchKind =
  | "invalid_cwd"
  | "missing_binary"
  | "unsupported_override"
  | "spawn_error"
  | "exit_error";

export type OpenCodeLaunchPlan = {
  command: string;
  argsPrefix: string[];
  info: OpenCodeLaunchInfo;
};

export class OpenCodeLaunchError extends Error {
  readonly kind: OpenCodeLaunchKind;
  readonly launchInfo: OpenCodeLaunchInfo;
  readonly exitCode: number | null;
  readonly cause?: unknown;

  constructor(
    kind: OpenCodeLaunchKind,
    message: string,
    launchInfo: OpenCodeLaunchInfo,
    options?: { exitCode?: number | null; cause?: unknown }
  ) {
    super(message);
    this.name = "OpenCodeLaunchError";
    this.kind = kind;
    this.launchInfo = launchInfo;
    this.exitCode = options?.exitCode ?? null;
    this.cause = options?.cause;
  }

  get isInfrastructureFailure(): boolean {
    return this.kind !== "exit_error";
  }
}

type OpenCodeRunnerOptions = {
  spawnImpl?: typeof spawn;
};

function resolveBinaryFromRepoRoot(repoRoot: string): string {
  const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
  return requireFromRepo.resolve("opencode-ai/bin/opencode");
}

function isPathLike(value: string): boolean {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function normalizeModel(model: string): string {
  if (!model) return model;
  return model.includes("/") ? model : `ollama/${model}`;
}

function extractModel(raw: string): string {
  if (raw.startsWith("opencode:")) return raw.slice("opencode:".length);
  return raw;
}

function buildConfigContent(role: AgentRole, model: string): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: normalizeModel(extractModel(model)),
    small_model: normalizeModel(extractModel(model)),
    permission: "allow",
    watcher: { ignore: ["node_modules/**", ".git/**", "dist/**", "coverage/**"] }
  });
}

function buildPrompt(role: "builder" | "epicDecoder" | "epicReviewer", prompt: string): string {
  const preface = role === "builder"
    ? "You are the builder agent. Use the tools actually available in this OpenCode session: read, glob, grep, edit, write, task, todowrite, and skill. Do not call unavailable shell tools. Make the requested changes, then finish with a final JSON block."
    : role === "epicDecoder"
      ? "You are the epic decoder agent. Inspect the repository context using read, glob, grep, task, todowrite, and skill. Do not call unavailable shell tools. Understand the existing code structure and finish with a final JSON block."
      : "You are the epic reviewer agent. Inspect the repository context and supplied summaries using read, glob, grep, task, todowrite, and skill. Do not call unavailable shell tools. Finish with a final JSON block.";
  return `${preface}\n\n${prompt}`;
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

function isLikelyFinalJsonPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.summary === "string"
    || typeof record.sessionId === "string"
    || typeof record.verdict === "string"
    || Array.isArray(record.followupTickets);
}

function tryExtractJson(raw: string): any {
  const tagged = raw.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/i);
  const direct = tagged?.[1] ?? raw;
  const candidates = extractJsonObjectCandidates(direct);
  if (!candidates.length) throw new Error("OpenCode output did not contain any JSON object candidates.");

  let fallback: unknown = null;
  let lastError: Error | null = null;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]);
      if (isLikelyFinalJsonPayload(parsed)) return parsed;
      if (fallback == null) fallback = parsed;
    } catch (error) {
      lastError = error as Error;
    }
  }

  if (fallback != null) return fallback;
  if (lastError) throw lastError;
  throw new Error("OpenCode output did not contain a valid final JSON object.");
}

function buildLaunchInfo(input: {
  cwd: string;
  repoRoot: string;
  model: string;
  promptLength: number;
  command: string;
  argsPrefix: string[];
  binaryPath: string;
  binarySource: OpenCodeLaunchInfo["binarySource"];
  cwdExists: boolean;
  cwdIsDirectory: boolean;
}): OpenCodeLaunchInfo {
  return {
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    model: input.model,
    promptLength: input.promptLength,
    command: input.command,
    args: [...input.argsPrefix, "run", "--model", input.model, "<redacted>"],
    shell: false,
    binaryPath: input.binaryPath,
    binarySource: input.binarySource,
    cwdExists: input.cwdExists,
    cwdIsDirectory: input.cwdIsDirectory
  };
}

function describeLaunchInfo(info: OpenCodeLaunchInfo): string {
  return [
    `cwd=${info.cwd}`,
    `command=${info.command}`,
    `binary=${info.binaryPath}`,
    `model=${info.model}`,
    `promptLength=${info.promptLength}`,
    `cwdExists=${String(info.cwdExists)}`,
    `cwdIsDirectory=${String(info.cwdIsDirectory)}`
  ].join(" ");
}

export function formatOpenCodeFailure(error: unknown): string {
  if (error instanceof OpenCodeLaunchError) {
    const extra = error.exitCode == null ? "" : ` exitCode=${error.exitCode}`;
    const cause = error.cause instanceof Error ? ` cause=${error.cause.message}` : error.cause ? ` cause=${String(error.cause)}` : "";
    return `OpenCode launch failed [${error.kind}]${extra}${cause}: ${error.message}. ${describeLaunchInfo(error.launchInfo)}`;
  }
  if (error instanceof Error) return `OpenCode failed: ${error.message}`;
  return `OpenCode failed: ${String(error)}`;
}

async function resolveLaunchTarget(repoRoot: string): Promise<{ command: string; argsPrefix: string[]; binaryPath: string; binarySource: OpenCodeLaunchInfo["binarySource"] }> {
  const override = process.env.OPENCODE_BIN?.trim();
  if (override) {
    if (!isPathLike(override)) {
      return {
        command: override,
        argsPrefix: [],
        binaryPath: override,
        binarySource: "override-command"
      };
    }

    const resolvedOverride = path.isAbsolute(override) ? override : path.resolve(repoRoot, override);
    const lowerName = path.basename(resolvedOverride).toLowerCase();
    if (lowerName.endsWith(".cmd") || lowerName.endsWith(".bat")) {
      if (lowerName === "opencode.cmd" || lowerName === "opencode.bat") {
        const resolvedShimTarget = path.resolve(path.dirname(resolvedOverride), "..", "opencode-ai", "bin", "opencode");
        await stat(resolvedShimTarget).catch(() => {
          throw new OpenCodeLaunchError(
            "missing_binary",
            `Resolved OpenCode shim target does not exist: ${resolvedShimTarget}`,
            buildLaunchInfo({
              cwd: repoRoot,
              repoRoot,
              model: "",
              promptLength: 0,
              command: process.execPath,
              argsPrefix: [resolvedShimTarget],
              binaryPath: resolvedShimTarget,
              binarySource: "override-path",
              cwdExists: true,
              cwdIsDirectory: true
            })
          );
        });
        return {
          command: process.execPath,
          argsPrefix: [resolvedShimTarget],
          binaryPath: resolvedShimTarget,
          binarySource: "override-path"
        };
      }
      throw new OpenCodeLaunchError(
        "unsupported_override",
        `OPENCODE_BIN points to a Windows shim that cannot be spawned directly without a shell: ${resolvedOverride}`,
        buildLaunchInfo({
          cwd: repoRoot,
          repoRoot,
          model: "",
          promptLength: 0,
          command: resolvedOverride,
          argsPrefix: [],
          binaryPath: resolvedOverride,
          binarySource: "override-path",
          cwdExists: true,
          cwdIsDirectory: true
        })
      );
    }

    await stat(resolvedOverride).catch(() => {
      throw new OpenCodeLaunchError(
        "missing_binary",
        `OPENCODE_BIN does not exist: ${resolvedOverride}`,
        buildLaunchInfo({
          cwd: repoRoot,
          repoRoot,
          model: "",
          promptLength: 0,
          command: process.execPath,
          argsPrefix: [resolvedOverride],
          binaryPath: resolvedOverride,
          binarySource: "override-path",
          cwdExists: true,
          cwdIsDirectory: true
        })
      );
    });
    return {
      command: process.execPath,
      argsPrefix: [resolvedOverride],
      binaryPath: resolvedOverride,
      binarySource: "override-path"
    };
  }

  const resolvedBinary = resolveBinaryFromRepoRoot(repoRoot);
  await stat(resolvedBinary).catch(() => {
    throw new OpenCodeLaunchError(
      "missing_binary",
      `OpenCode entrypoint does not exist: ${resolvedBinary}`,
      buildLaunchInfo({
        cwd: repoRoot,
        repoRoot,
        model: "",
        promptLength: 0,
        command: process.execPath,
        argsPrefix: [resolvedBinary],
        binaryPath: resolvedBinary,
        binarySource: "package-entrypoint",
        cwdExists: true,
        cwdIsDirectory: true
      })
    );
  });

  return {
    command: process.execPath,
    argsPrefix: [resolvedBinary],
    binaryPath: resolvedBinary,
    binarySource: "package-entrypoint"
  };
}

export class OpenCodeRunner {
  private readonly spawnImpl: typeof spawn;

  constructor(options?: OpenCodeRunnerOptions) {
    this.spawnImpl = options?.spawnImpl ?? spawn;
  }

  async resolveLaunch(input: { cwd: string; model: string; promptLength: number }): Promise<OpenCodeLaunchPlan> {
    const config = loadConfig();
    const cwd = path.resolve(input.cwd);
    const launchTarget = await resolveLaunchTarget(config.repoRoot);
    const cwdStat = await stat(cwd).then((value) => ({ exists: true, isDirectory: value.isDirectory() })).catch(() => ({ exists: false, isDirectory: false }));
    const info = buildLaunchInfo({
      cwd,
      repoRoot: config.repoRoot,
      model: normalizeModel(input.model),
      promptLength: input.promptLength,
      command: launchTarget.command,
      argsPrefix: launchTarget.argsPrefix,
      binaryPath: launchTarget.binaryPath,
      binarySource: launchTarget.binarySource,
      cwdExists: cwdStat.exists,
      cwdIsDirectory: cwdStat.isDirectory
    });
    if (!cwdStat.exists || !cwdStat.isDirectory) {
      throw new OpenCodeLaunchError(
        "invalid_cwd",
        `OpenCode workspace cwd does not exist or is not a directory: ${cwd}`,
        info
      );
    }
    return {
      command: launchTarget.command,
      argsPrefix: launchTarget.argsPrefix,
      info
    };
  }

  async runBuilder(input: OpenCodeTaskInput): Promise<OpenCodeBuilderResult> {
    const raw = await this.runRaw(input);
    const parsed = tryExtractJson(raw.combined);
    return {
      summary: String(parsed.summary ?? "OpenCode builder completed."),
      sessionId: parsed.sessionId ? String(parsed.sessionId) : null,
      rawOutput: raw.combined,
      launchInfo: raw.launchInfo
    };
  }

  async runEpicDecoder(input: OpenCodeTaskInput): Promise<GoalReview | any> {
    const raw = await this.runRaw(input);
    try {
      const parsed = tryExtractJson(raw.combined);
      return parsed;
    } catch {
      return parseJsonText(raw.combined);
    }
  }

  async runEpicReviewer(input: OpenCodeTaskInput): Promise<GoalReview> {
    const raw = await this.runRaw(input);
    const parsed = tryExtractJson(raw.combined);
    return {
      verdict: parsed.verdict === "needs_followups" || parsed.verdict === "failed" ? parsed.verdict : "approved",
      summary: String(parsed.summary ?? "OpenCode epic review completed."),
      followupTickets: Array.isArray(parsed.followupTickets) ? parsed.followupTickets : []
    };
  }

  private async runRaw(input: OpenCodeTaskInput): Promise<{ combined: string; launchInfo: OpenCodeLaunchInfo }> {
    const models = loadConfig().models;
    const rawModel = input.role === "builder"
      ? models.builder
      : input.role === "epicDecoder"
        ? models.epicDecoder
        : models.epicReviewer;
    const model = extractModel(rawModel);
    const prompt = buildPrompt(input.role, input.prompt);
    const launch = await this.resolveLaunch({ cwd: input.cwd, model, promptLength: prompt.length });
    const args = [...launch.argsPrefix, "run", "--model", normalizeModel(model), prompt];
    const env = {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: buildConfigContent(input.role, model)
    };
    const chunks: string[] = [];
    let sequence = 0;
    const emit = (streamKind: AgentStreamPayload["streamKind"], chunk: string, done = false) => {
      if (!chunk && !done) return;
      input.onStream?.({
        agentRole: input.role,
        source: "opencode",
        streamKind,
        content: chunk,
        runId: input.runId,
        ticketId: input.ticketId,
        epicId: input.epicId,
        sequence: sequence++,
        done,
        metadata: { cwd: input.cwd, command: launch.command, binaryPath: launch.info.binaryPath, promptLength: launch.info.promptLength }
      });
    };

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnImpl(launch.command, args, {
        cwd: launch.info.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk: string) => {
        chunks.push(chunk);
        emit("assistant", chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        chunks.push(`\n[stderr]\n${chunk}`);
        const kind = /think|reason/i.test(chunk) ? "thinking" : "stderr";
        emit(kind, chunk);
      });
      child.on("error", (error) => reject(new OpenCodeLaunchError("spawn_error", `OpenCode spawn failed: ${(error as Error).message}`, launch.info, { cause: error })));
      child.on("close", (code) => {
        emit("status", code === 0 ? "completed" : `failed (${code ?? 1})`, true);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new OpenCodeLaunchError("exit_error", `OpenCode exited with code ${code ?? 1}`, launch.info, { exitCode: code ?? 1 }));
      });
    });

    return { combined: chunks.join(""), launchInfo: launch.info };
  }
}
