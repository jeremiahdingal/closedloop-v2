import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../config.ts";
import type { AgentRole, AgentStreamPayload, GoalReview, OpenCodeBuilderResult } from "../types.ts";
import { truncate } from "../utils.ts";

export type OpenCodeTaskInput = {
  role: Extract<AgentRole, "builder" | "goalReviewer">;
  cwd: string;
  prompt: string;
  runId?: string | null;
  ticketId?: string | null;
  epicId?: string | null;
  onStream?: (event: AgentStreamPayload) => void;
};

function resolveBinary(): string {
  const rootBin = path.resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
  return rootBin;
}

function normalizeModel(model: string): string {
  if (!model) return model;
  return model.includes("/") ? model : `ollama/${model}`;
}

function buildConfigContent(role: AgentRole, model: string): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: normalizeModel(model),
    small_model: normalizeModel(model),
    permission: "allow",
    watcher: { ignore: ["node_modules/**", ".git/**", "dist/**", "coverage/**"] }
  });
}

function buildPrompt(role: "builder" | "goalReviewer", prompt: string): string {
  const preface = role === "builder"
    ? "You are the builder agent. Use your tools in the current repository to make the requested changes, then finish with a final JSON block."
    : "You are the epic reviewer agent. Inspect the repository context and supplied summaries, then finish with a final JSON block.";
  return `${preface}\n\n${prompt}`;
}

function tryExtractJson(raw: string): any {
  const tagged = raw.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/i);
  const direct = tagged?.[1] ?? raw;
  const start = direct.indexOf("{");
  const end = direct.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("OpenCode output did not contain FINAL_JSON block.");
  return JSON.parse(direct.slice(start, end + 1));
}

export class OpenCodeRunner {
  readonly config = loadConfig();

  async runBuilder(input: OpenCodeTaskInput): Promise<OpenCodeBuilderResult> {
    const raw = await this.runRaw(input);
    const parsed = tryExtractJson(raw.combined);
    return {
      summary: String(parsed.summary ?? "OpenCode builder completed."),
      sessionId: parsed.sessionId ? String(parsed.sessionId) : null,
      rawOutput: raw.combined
    };
  }

  async runGoalReviewer(input: OpenCodeTaskInput): Promise<GoalReview> {
    const raw = await this.runRaw(input);
    const parsed = tryExtractJson(raw.combined);
    return {
      verdict: parsed.verdict === "needs_followups" || parsed.verdict === "failed" ? parsed.verdict : "approved",
      summary: String(parsed.summary ?? "OpenCode epic review completed."),
      followupTickets: Array.isArray(parsed.followupTickets) ? parsed.followupTickets : []
    };
  }

  private async runRaw(input: OpenCodeTaskInput): Promise<{ combined: string }> {
    const binary = process.env.OPENCODE_BIN || resolveBinary();
    const model = input.role === "builder" ? this.config.models.builder : this.config.models.goalReviewer;
    const args = ["run", "--model", normalizeModel(model), buildPrompt(input.role, input.prompt)];
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
        metadata: { cwd: input.cwd }
      });
    };

    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: input.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        chunks.push(chunk);
        emit("assistant", chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        chunks.push(`\n[stderr]\n${chunk}`);
        const kind = /think|reason/i.test(chunk) ? "thinking" : "stderr";
        emit(kind, chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        emit("status", code === 0 ? "completed" : `failed (${code ?? 1})`, true);
        if (code === 0) resolve();
        else reject(new Error(`OpenCode exited with code ${code ?? 1}. Output: ${truncate(chunks.join(""), 2400)}`));
      });
    });

    return { combined: chunks.join("") };
  }
}
