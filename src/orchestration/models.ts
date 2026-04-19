import { loadConfig } from "../config.ts";
import type {
  AgentRole,
  AgentStreamPayload,
  BuilderPlan,
  FailureDecision,
  GoalDecomposition,
  GoalReview,
  OpenCodeBuilderResult,
  ReviewerVerdict,
  TesterResult
} from "../types.ts";
import {
  parseJsonText,
  validateBuilderPlan,
  validateFailureDecision,
  validateGoalDecomposition,
  validateGoalReview,
  validateReviewerVerdict
} from "./validation.ts";
import { OpenCodeRunner } from "./opencode.ts";
import { CodexRunner } from "./codex.ts";
import { QwenRunner } from "./qwen.ts";
import { GeminiRunner } from "./gemini.ts";
import { ZaiRunner } from "./zai.ts";
import { MediatedAgentHarness } from "../mediated-agent-harness/index.ts";
import type { ToolExecutionContext } from "../mediated-agent-harness/types.ts";
import { ensureModelLoaded, markModelLoaded, unloadCurrentModel } from "./ollama-memory-manager.ts";

export type StreamHook = (event: AgentStreamPayload) => void;

export interface ModelGateway {
  readonly models: Record<AgentRole, string>;
  rawPrompt(role: AgentRole, prompt: string): Promise<string>;
  getGoalDecomposition(prompt: string): Promise<GoalDecomposition>;
  getBuilderPlan(prompt: string): Promise<BuilderPlan>;
  getReviewerVerdict(prompt: string): Promise<ReviewerVerdict>;
  getGoalReview(prompt: string): Promise<GoalReview>;
  getFailureDecision(prompt: string): Promise<FailureDecision>;
  runBuilderInWorkspace?(input: { cwd: string; prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<OpenCodeBuilderResult>;
  runReviewerInWorkspace?(input: { cwd: string; prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<ReviewerVerdict>;
  runTesterInWorkspace?(input: { cwd: string; prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<TesterResult>;
  runExplorerInWorkspace?(input: { cwd: string; prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<string>;
  runCoderDirect?(input: { prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<string>;
  runGoalReviewInWorkspace?(input: { cwd: string; prompt: string; runId?: string | null; epicId?: string | null; onStream?: StreamHook; ragIndexId?: number; db?: any }): Promise<GoalReview>;
  runEpicDecoderInWorkspace?(input: { cwd: string; prompt: string; runId?: string | null; epicId?: string | null; onStream?: StreamHook; ragIndexId?: number; db?: any }): Promise<GoalDecomposition>;
  runEpicDecoderOpenCode?(input: { cwd: string; prompt: string; runId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<GoalDecomposition>;
  runEpicReviewerCodex?(input: { cwd: string; prompt: string; runId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<GoalReview>;
}

const DEFAULT_TEMPERATURE = 1.0;
const DEFAULT_TOP_P = 0.95;
const DEFAULT_TOP_K = 64;

function resolveOllamaContextWindow(model: string): number {
  if (model.startsWith("glm-4.7-flash")) return 4096;
  if (model.startsWith("qwen3.5:9b")) return 16384;
  if (model.startsWith("qwen3.5:27b")) return 4096;
  if (model.startsWith("devstral-small-2:24b")) return 393216;
  if (model.startsWith("qwen2.5-coder:14b")) return 65536;
  return 32768;
}

function buildZodSchemas(z: any) {
  const GoalTicketPlanSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()),
    dependencies: z.array(z.string()),
    allowedPaths: z.array(z.string()),
    priority: z.enum(["high", "medium", "low"])
  });

  return {
    goalDecomposition: z.object({
      summary: z.string(),
      tickets: z.array(GoalTicketPlanSchema)
    }),
    builderPlan: z.object({
      summary: z.string(),
      intendedFiles: z.array(z.string()),
      operations: z.array(z.object({
        kind: z.enum(["replace_file", "append_file"]),
        path: z.string(),
        content: z.string()
      }))
    }),
    reviewerVerdict: z.object({
      approved: z.boolean(),
      blockers: z.array(z.string()),
      suggestions: z.array(z.string()),
      riskLevel: z.enum(["low", "medium", "high"])
    }),
    goalReview: z.object({
      verdict: z.enum(["approved", "needs_followups", "failed"]),
      summary: z.string(),
      followupTickets: z.array(GoalTicketPlanSchema)
    }),
    failureDecision: z.object({
      decision: z.enum(["retry_same_node", "retry_builder", "blocked", "todo", "escalate"]),
      reason: z.string()
    })
  };
}

function resolveOllamaModel(role: AgentRole, models: Record<AgentRole, string>): string {
  const raw = models[role];
  if (role === "explorer" && !raw) return "qwen3.5:9b";
  if (role === "coder" && !raw) return "qwen3.5:27b";
  if (!raw) return process.env.OLLAMA_FALLBACK_MODEL || models.doctor || "qwen3:8b";

  if (raw.startsWith("zai:")) return raw;
  if (raw.startsWith("opencode:")) return raw.slice("opencode:".length);
  if (raw.startsWith("mediated:")) return raw.slice("mediated:".length);
  if (raw === "ollama") return process.env.OLLAMA_FALLBACK_MODEL || models.doctor || "qwen3:8b";
  if (raw === "codex-cli") {
    if (role === "epicDecoder") return process.env.OLLAMA_EPICDECODER_MODEL || process.env.OLLAMA_FALLBACK_MODEL || models.doctor || "qwen3:8b";
    if (role === "epicReviewer") return process.env.OLLAMA_EPICREVIEWER_MODEL || process.env.OLLAMA_FALLBACK_MODEL || models.doctor || "qwen3:8b";
    return process.env.OLLAMA_FALLBACK_MODEL || models.doctor || "qwen3:8b";
  }
  if (raw === "qwen-cli") {
    if (role === "epicDecoder") return process.env.OLLAMA_EPICDECODER_MODEL || process.env.OLLAMA_FALLBACK_MODEL || models.doctor || "qwen3:8b";
    if (role === "epicReviewer") return process.env.OLLAMA_EPICREVIEWER_MODEL || process.env.OLLAMA_FALLBACK_MODEL || models.doctor || "qwen3:8b";
    return process.env.OLLAMA_FALLBACK_MODEL || models.doctor || "qwen3:8b";
  }
  return raw;
}

export class OllamaGateway implements ModelGateway {
  get models(): Record<AgentRole, string> {
    return loadConfig().models;
  }
  private readonly baseUrl: string;
  constructor(baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434") {
    this.baseUrl = baseUrl;
  }

  async rawPrompt(role: AgentRole, prompt: string, onStream?: StreamHook): Promise<string> {
    const model = resolveOllamaModel(role, this.models);
    const numCtx = resolveOllamaContextWindow(model);

    onStream?.({
      agentRole: role,
      source: "orchestrator",
      streamKind: "system",
      content: `--- PROMPT ---\n${prompt}\n--------------`,
      sequence: 0,
    });

    // Memory management: unload previous model before loading this one
    await ensureModelLoaded(model);
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(900_000),
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: DEFAULT_TEMPERATURE,
          top_p: DEFAULT_TOP_P,
          top_k: DEFAULT_TOP_K,
          num_ctx: numCtx
        }
      })
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed for ${role}: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json() as { response: string };
    markModelLoaded(model);
    return payload.response;
  }

  private async invokeStructured<T>(role: AgentRole, prompt: string, fallback: (raw: unknown) => T, schemaName: keyof ReturnType<typeof buildZodSchemas>): Promise<T> {
    try {
      const [{ ChatOllama }, zodPkg] = await Promise.all([
        import("@langchain/ollama"),
        import("zod")
      ]);
      const z = (zodPkg as any).z ?? zodPkg;
      const schemas = buildZodSchemas(z);
      const resolvedModel = resolveOllamaModel(role, this.models);
      const numCtx = resolveOllamaContextWindow(resolvedModel);
      const model = new ChatOllama({
        model: resolvedModel,
        temperature: DEFAULT_TEMPERATURE,
        topP: DEFAULT_TOP_P,
        topK: DEFAULT_TOP_K,
        baseUrl: this.baseUrl,
        numCtx,
      });
      const structured = model.withStructuredOutput((schemas as any)[schemaName]);
      return await structured.invoke(prompt) as T;
    } catch {
      return fallback(parseJsonText(await this.rawPrompt(role, prompt)));
    }
  }

  async getGoalDecomposition(prompt: string): Promise<GoalDecomposition> {
    return this.invokeStructured("epicDecoder", prompt, validateGoalDecomposition, "goalDecomposition");
  }

  async getBuilderPlan(prompt: string): Promise<BuilderPlan> {
    return this.invokeStructured("builder", prompt, validateBuilderPlan, "builderPlan");
  }

  async getReviewerVerdict(prompt: string): Promise<ReviewerVerdict> {
    return this.invokeStructured("reviewer", prompt, validateReviewerVerdict, "reviewerVerdict");
  }

  async getGoalReview(prompt: string): Promise<GoalReview> {
    return this.invokeStructured("epicReviewer", prompt, validateGoalReview, "goalReview");
  }

  async getFailureDecision(prompt: string): Promise<FailureDecision> {
    return this.invokeStructured("doctor", prompt, validateFailureDecision, "failureDecision");
  }

  runExplorerInWorkspace(_input: { cwd: string; prompt: string }): Promise<string> {
    throw new Error("Explorer requires mediated harness (MediatedAgentHarnessGateway)");
  }

  async runCoderDirect(input: { prompt: string; onStream?: StreamHook }): Promise<string> {
    const model = resolveOllamaModel("coder", this.models);
    input.onStream?.({
      agentRole: "coder",
      source: "orchestrator",
      streamKind: "system",
      content: `--- PROMPT ---\n${input.prompt}\n--------------`,
      sequence: 0,
    });
    input.onStream?.({
      agentRole: "coder",
      source: "orchestrator",
      streamKind: "status",
      content: `Coding via direct model call (${model})...`,
      sequence: 1,
    });
    const response = await this.rawPrompt("coder", input.prompt);
    input.onStream?.({
      agentRole: "coder",
      source: "orchestrator",
      streamKind: "assistant",
      content: response,
      sequence: 2,
      metadata: { model },
    });
    return response;
  }
}

export class OpenCodeHybridGateway implements ModelGateway {
  private readonly _models?: Record<AgentRole, string>;
  get models(): Record<AgentRole, string> {
    return this._models || loadConfig().models;
  }
  private readonly ollama: OllamaGateway;
  private readonly opencode: OpenCodeRunner;
  private readonly codex: CodexRunner;
  private readonly qwen: QwenRunner;
  private readonly gemini: GeminiRunner;
  private readonly zai: ZaiRunner;

  constructor(models?: Record<AgentRole, string>) {
    this._models = models;
    this.ollama = new OllamaGateway();
    this.opencode = new OpenCodeRunner();
    this.codex = new CodexRunner();
    this.qwen = new QwenRunner();
    this.gemini = new GeminiRunner();
    this.zai = new ZaiRunner();
  }

  rawPrompt(role: AgentRole, prompt: string): Promise<string> {
    return this.ollama.rawPrompt(role, prompt);
  }

  getGoalDecomposition(prompt: string): Promise<GoalDecomposition> {
    return this.ollama.getGoalDecomposition(prompt);
  }

  getBuilderPlan(prompt: string): Promise<BuilderPlan> {
    return this.ollama.getBuilderPlan(prompt);
  }

  getReviewerVerdict(prompt: string): Promise<ReviewerVerdict> {
    return this.ollama.getReviewerVerdict(prompt);
  }

  getGoalReview(prompt: string): Promise<GoalReview> {
    return this.ollama.getGoalReview(prompt);
  }

  getFailureDecision(prompt: string): Promise<FailureDecision> {
    return this.ollama.getFailureDecision(prompt);
  }

  runBuilderInWorkspace(input: { cwd: string; prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<OpenCodeBuilderResult> {
    if (this.models.builder === "gemini-cli") {
      return this.gemini.runBuilder({ role: "builder", ...input });
    }
    if (this.models.builder === "qwen-cli") {
      return this.qwen.runBuilder({ role: "builder", ...input });
    }
    if (this.models.builder === "codex-cli") {
      return this.codex.runBuilder({ role: "builder", ...input });
    }
    return this.opencode.runBuilder({ role: "builder", ...input });
  }

  runTesterInWorkspace(input: { cwd: string; prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<TesterResult> {
    return this.opencode.runTester({ role: "tester", ...input });
  }

  runExplorerInWorkspace(input: { cwd: string; prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<string> {
    // OpenCodeRunner doesn't have runExplorer, but we can reuse runBuilder-like logic or just fail if not mediated.
    // The requirement says only explorer should remain mediated.
    throw new Error("Explorer role requires MediatedAgentHarnessGateway");
  }

  async runCoderDirect(input: { prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<string> {
    const model = resolveOllamaModel("coder", this.models);
    input.onStream?.({
      agentRole: "coder",
      source: "orchestrator",
      streamKind: "status",
      content: `Coding via direct model call (${model})...`,
      runId: input.runId,
      ticketId: input.ticketId,
      epicId: input.epicId,
      sequence: 0,
    });

    const response = await this.rawPrompt("coder", input.prompt);

    input.onStream?.({
      agentRole: "coder",
      source: "orchestrator",
      streamKind: "assistant",
      content: response,
      runId: input.runId,
      ticketId: input.ticketId,
      epicId: input.epicId,
      sequence: 1,
      metadata: { model },
    });

    return response;
  }

  runGoalReviewInWorkspace(input: { cwd: string; prompt: string; runId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<GoalReview> {
    return this.opencode.runEpicReviewer({ role: "epicReviewer", ...input });
  }

  runEpicDecoderInWorkspace(input: { cwd: string; prompt: string; runId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<GoalDecomposition> {
    if (this.models.epicDecoder === "gemini-cli") {
      return this.gemini.runEpicDecoder({ role: "epicDecoder", ...input });
    }
    if (this.models.epicDecoder === "qwen-cli") {
      return this.qwen.runEpicDecoder({ role: "epicDecoder", ...input });
    }
    return this.codex.runEpicDecoder({ role: "epicDecoder", ...input });
  }

  async runEpicDecoderOpenCode(input: { cwd: string; prompt: string; runId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<GoalDecomposition> {
    const parsed = await this.opencode.runEpicDecoder({ role: "epicDecoder", ...input });
    return validateGoalDecomposition(parsed);
  }

  runEpicReviewerCodex(input: { cwd: string; prompt: string; runId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<GoalReview> {
    if (this.models.epicReviewer === "gemini-cli") {
      return this.gemini.runEpicReviewer({ role: "epicReviewer", ...input });
    }
    if (this.models.epicReviewer === "qwen-cli") {
      return this.qwen.runEpicReviewer({ role: "epicReviewer", ...input });
    }
    return this.codex.runEpicReviewer({ role: "epicReviewer", ...input });
  }
}

export class DryRunGateway implements ModelGateway {
  get models(): Record<AgentRole, string> {
    return loadConfig().models;
  }

  async rawPrompt(_role: AgentRole, _prompt: string): Promise<string> {
    return JSON.stringify({ ok: true });
  }

  async getGoalDecomposition(prompt: string): Promise<GoalDecomposition> {
    const title = /Goal:\s*(.+)/.exec(prompt)?.[1] || "Generated goal";
    return {
      summary: "Dry run decomposition",
      tickets: [
        {
          id: "ticket_impl",
          title: `${title} - implementation`,
          description: "Implement the requested behavior.",
          acceptanceCriteria: ["Behavior implemented"],
          dependencies: [],
          allowedPaths: ["src", "README.md"],
          priority: "high"
        },
        {
          id: "ticket_tests",
          title: `${title} - tests`,
          description: "Add or update tests for the behavior.",
          acceptanceCriteria: ["Tests cover the behavior"],
          dependencies: ["ticket_impl"],
          allowedPaths: ["test", "src"],
          priority: "medium"
        }
      ]
    };
  }

  async getBuilderPlan(prompt: string): Promise<BuilderPlan> {
    const allowedLine = /Allowed paths:\s*(.+)/.exec(prompt)?.[1] ?? "README.md";
    const firstAllowed = allowedLine.split(",")[0]?.trim() || "README.md";
    const targetPath = firstAllowed.endsWith("/") || !firstAllowed.includes(".")
      ? `${firstAllowed.replace(/\/$/, "")}/dry-run.txt`
      : firstAllowed;

    return {
      summary: "Dry run builder plan",
      intendedFiles: [targetPath],
      operations: [
        {
          kind: "append_file",
          path: targetPath,
          content: "\n\n<!-- orchestrator dry-run change -->\n"
        }
      ]
    };
  }

  async getReviewerVerdict(_prompt: string): Promise<ReviewerVerdict> {
    return {
      approved: true,
      blockers: [],
      suggestions: ["Run tests."],
      riskLevel: "low"
    };
  }

  async getGoalReview(_prompt: string): Promise<GoalReview> {
    return {
      verdict: "approved",
      summary: "Dry run goal review approved.",
      followupTickets: []
    };
  }

  async getFailureDecision(_prompt: string): Promise<FailureDecision> {
    return { decision: "retry_builder", reason: "Dry run doctor requested another build." };
  }

  async runBuilderInWorkspace(input: { cwd: string; prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<OpenCodeBuilderResult> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const plan = await this.getBuilderPlan(input.prompt);
    input.onStream?.({ agentRole: "builder", source: "orchestrator", streamKind: "status", content: "[dry-run] Builder started", runId: input.runId, ticketId: input.ticketId, epicId: input.epicId, sequence: 0, done: false });
    // Write the planned files so gitDiff sees a real diff
    for (const op of plan.operations) {
      const fullPath = path.join(input.cwd, op.path);
      await mkdir(path.dirname(fullPath), { recursive: true });
      if (op.kind === "append_file") {
        const existing = await import("node:fs/promises").then((m) => m.readFile(fullPath, "utf8").catch(() => ""));
        await writeFile(fullPath, existing + op.content, "utf8");
      } else {
        await writeFile(fullPath, op.content, "utf8");
      }
    }
    input.onStream?.({ agentRole: "builder", source: "orchestrator", streamKind: "assistant", content: plan.summary, runId: input.runId, ticketId: input.ticketId, epicId: input.epicId, sequence: 1, done: false });
    input.onStream?.({ agentRole: "builder", source: "orchestrator", streamKind: "status", content: "[dry-run] Builder completed", runId: input.runId, ticketId: input.ticketId, epicId: input.epicId, sequence: 2, done: true });
    return { summary: plan.summary, sessionId: null, rawOutput: plan.summary };
  }
}

export class MockGateway implements ModelGateway {
  get models(): Record<AgentRole, string> {
    return loadConfig().models;
  }
  private readonly responses: Partial<{
    goalDecomposition: GoalDecomposition;
    builderPlans: BuilderPlan[];
    reviewerVerdicts: ReviewerVerdict[];
    goalReview: GoalReview;
    failureDecisions: FailureDecision[];
  }>;
  constructor(responses: Partial<{
    goalDecomposition: GoalDecomposition;
    builderPlans: BuilderPlan[];
    reviewerVerdicts: ReviewerVerdict[];
    goalReview: GoalReview;
    failureDecisions: FailureDecision[];
  }> = {}) {
    this.responses = responses;
  }

  async rawPrompt(_role: AgentRole, _prompt: string): Promise<string> {
    return JSON.stringify({ ok: true });
  }

  async getGoalDecomposition(_prompt: string): Promise<GoalDecomposition> {
    if (!this.responses.goalDecomposition) throw new Error("Missing mock goal decomposition");
    return this.responses.goalDecomposition;
  }

  async getBuilderPlan(_prompt: string): Promise<BuilderPlan> {
    const plan = this.responses.builderPlans?.shift();
    if (!plan) throw new Error("Missing mock builder plan");
    return plan;
  }

  async getReviewerVerdict(_prompt: string): Promise<ReviewerVerdict> {
    const verdict = this.responses.reviewerVerdicts?.shift();
    if (!verdict) throw new Error("Missing mock reviewer verdict");
    return verdict;
  }

  async getGoalReview(_prompt: string): Promise<GoalReview> {
    if (!this.responses.goalReview) throw new Error("Missing mock goal review");
    return this.responses.goalReview;
  }

  async getFailureDecision(_prompt: string): Promise<FailureDecision> {
    const decision = this.responses.failureDecisions?.shift();
    if (!decision) throw new Error("Missing mock failure decision");
    return decision;
  }

  async runExplorerInWorkspace(input: { cwd: string; prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<string> {
    input.onStream?.({ agentRole: "explorer", source: "orchestrator", streamKind: "status", content: "[mock] Explorer started", runId: input.runId, ticketId: input.ticketId, epicId: input.epicId, sequence: 0, done: false });
    const result = JSON.stringify({
      relevantFiles: ["README.md"],
      relevantSymbols: [],
      likelyEditRegions: [],
      summary: "Mock exploration result",
      risks: [],
      missingContext: [],
      recommendedFilesForCoding: ["README.md"]
    });
    input.onStream?.({ agentRole: "explorer", source: "orchestrator", streamKind: "assistant", content: result, runId: input.runId, ticketId: input.ticketId, epicId: input.epicId, sequence: 1, done: true });
    return result;
  }

  async runCoderDirect(input: { prompt: string; runId?: string | null; ticketId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<string> {
    const plan = this.responses.builderPlans?.[0]; // Use first plan if available as coder output
    const content = plan ? JSON.stringify(plan) : "Mock coder output";
    input.onStream?.({ agentRole: "coder", source: "orchestrator", streamKind: "assistant", content, runId: input.runId, ticketId: input.ticketId, epicId: input.epicId, sequence: 0, done: true });
    return content;
  }
}

export class MediatedAgentHarnessGateway implements ModelGateway {
  private readonly _models?: Record<AgentRole, string>;
  get models(): Record<AgentRole, string> {
    return this._models || loadConfig().models;
  }

  private readonly ollama: OllamaGateway;
  private readonly opencode: OpenCodeRunner;
  private readonly codex: CodexRunner;
  private readonly qwen: QwenRunner;
  private readonly gemini: GeminiRunner;
  private readonly zai: ZaiRunner;
  private readonly ollamaBaseURL: string;
  private readonly braveApiKey: string | undefined;

  constructor(ollamaBaseURL?: string, models?: Record<AgentRole, string>) {
    this._models = models;
    this.ollamaBaseURL = ollamaBaseURL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
    this.ollama = new OllamaGateway(this.ollamaBaseURL);
    this.opencode = new OpenCodeRunner();
    this.codex = new CodexRunner();
    this.qwen = new QwenRunner();
    this.gemini = new GeminiRunner();
    this.zai = new ZaiRunner();
    this.braveApiKey = process.env.BRAVE_API_KEY;
  }

  rawPrompt(role: AgentRole, prompt: string): Promise<string> {
    const model = this.resolveHarnessModel(role);
    if (model.startsWith("zai:")) {
      return this.zai.rawPrompt(role, prompt, this.zai.resolveModel(model));
    }
    return this.ollama.rawPrompt(role, prompt);
  }

  getGoalDecomposition(prompt: string): Promise<GoalDecomposition> {
    return this.ollama.getGoalDecomposition(prompt);
  }

  getBuilderPlan(prompt: string): Promise<BuilderPlan> {
    return this.ollama.getBuilderPlan(prompt);
  }

  getReviewerVerdict(prompt: string): Promise<ReviewerVerdict> {
    return this.ollama.getReviewerVerdict(prompt);
  }

  async runReviewerInWorkspace(input: {
    cwd: string;
    prompt: string;
    runId?: string | null;
    ticketId?: string | null;
    epicId?: string | null;
    onStream?: StreamHook;
  }): Promise<ReviewerVerdict> {
    const model = this.resolveHarnessModel("reviewer");
    input.onStream?.({
      agentRole: "reviewer",
      source: "orchestrator",
      streamKind: "status",
      content: "Reviewing via mediated agent harness...",
      runId: input.runId,
      ticketId: input.ticketId,
      epicId: input.epicId,
      sequence: 0,
    });

    const toolContext = this.buildToolContext(input.cwd, "reviewer");
    const harness = new MediatedAgentHarness({
      baseURL: `${this.ollamaBaseURL}/v1`,
      apiKey: "ollama",
      model,
      braveApiKey: this.braveApiKey,
      toolContext,
    });

    await ensureModelLoaded(model);
    const result = await harness.run("reviewer", input.prompt, {
      maxIterations: 80,
      timeoutMs: 300_000,
      onEvent: (event) => {
        if (event.kind === "text" || event.kind === "thinking") {
          input.onStream?.({
            agentRole: "reviewer",
            source: "mediated-harness",
            streamKind: event.kind === "thinking" ? "thinking" : "assistant",
            content: event.text,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
        if (event.kind === "tool_call") {
          const argsPreview = JSON.stringify(event.call.args ?? {}).slice(0, 300);
          input.onStream?.({
            agentRole: "reviewer",
            source: "mediated-harness",
            streamKind: "tool_call",
            content: `${event.call.name}(${argsPreview})`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.call.name, toolArgs: event.call.args as import("../types.ts").Json },
          });
        }
        if (event.kind === "tool_result") {
          input.onStream?.({
            agentRole: "reviewer",
            source: "mediated-harness",
            streamKind: "tool_result",
            content: event.result.output,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.result.name, toolResult: event.result.output, isError: Boolean(event.result.isError) },
          });
        }
        if (event.kind === "tool_error") {
          input.onStream?.({
            agentRole: "reviewer",
            source: "mediated-harness",
            streamKind: "stderr",
            content: `Tool error: ${event.error}`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
        if (event.kind === "complete") {
          input.onStream?.({
            agentRole: "reviewer",
            source: "mediated-harness",
            streamKind: "status",
            content: `Completed in ${event.iterations} iterations`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
      },
    });
    markModelLoaded(model);

    return validateReviewerVerdict(parseJsonText(result.text));
  }

  getGoalReview(prompt: string): Promise<GoalReview> {
    return this.ollama.getGoalReview(prompt);
  }

  getFailureDecision(prompt: string): Promise<FailureDecision> {
    return this.ollama.getFailureDecision(prompt);
  }

  async runEpicDecoderInWorkspace(input: {
    cwd: string;
    prompt: string;
    runId?: string | null;
    epicId?: string | null;
    onStream?: StreamHook;
    ragIndexId?: number;
    db?: any;
  }): Promise<GoalDecomposition> {
    const configuredModel = this.models.epicDecoder;

    if (configuredModel === "gemini-cli") {
      return this.gemini.runEpicDecoder({ role: "epicDecoder", ...input });
    }
    if (configuredModel === "codex-cli") {
      return this.codex.runEpicDecoder({ role: "epicDecoder", ...input });
    }
    if (configuredModel === "qwen-cli") {
      return this.qwen.runEpicDecoder({ role: "epicDecoder", ...input });
    }
    if (configuredModel.startsWith("opencode:")) {
      const parsed = await this.opencode.runEpicDecoder({ role: "epicDecoder", ...input });
      return validateGoalDecomposition(parsed);
    }

    const model = this.resolveHarnessModel("epicDecoder");
    input.onStream?.({
      agentRole: "epicDecoder",
      source: "orchestrator",
      streamKind: "status",
      content: "Decomposing via mediated agent harness...",
      runId: input.runId,
      epicId: input.epicId,
      sequence: 0,
    });

    const toolContext = this.buildToolContext(input.cwd, "epicDecoder", { ragIndexId: input.ragIndexId, db: input.db });

    const harness = new MediatedAgentHarness({
      baseURL: `${this.ollamaBaseURL}/v1`,
      apiKey: "ollama",
      model,
      braveApiKey: this.braveApiKey,
      toolContext,
    });

    await ensureModelLoaded(model);
    const result = await harness.run("epicDecoder", input.prompt, {
      maxIterations: 80,
      timeoutMs: 900_000,
      onEvent: (event) => {
        if (event.kind === "text" || event.kind === "thinking") {
          input.onStream?.({
            agentRole: "epicDecoder",
            source: "mediated-harness",
            streamKind: event.kind === "thinking" ? "thinking" : "assistant",
            content: event.text,
            runId: input.runId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
        if (event.kind === "tool_call") {
          const argsPreview = JSON.stringify(event.call.args ?? {}).slice(0, 300);
          input.onStream?.({
            agentRole: "epicDecoder",
            source: "mediated-harness",
            streamKind: "tool_call",
            content: `${event.call.name}(${argsPreview})`,
            runId: input.runId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.call.name, toolArgs: event.call.args as import("../types.ts").Json },
          });
        }
        if (event.kind === "complete") {
          input.onStream?.({
            agentRole: "epicDecoder",
            source: "mediated-harness",
            streamKind: "status",
            content: `Completed in ${event.iterations} iterations`,
            runId: input.runId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
      },
    });
    markModelLoaded(model);

    return validateGoalDecomposition(parseJsonText(result.text));
  }

  async runGoalReviewInWorkspace(input: {
    cwd: string;
    prompt: string;
    runId?: string | null;
    epicId?: string | null;
    onStream?: StreamHook;
    ragIndexId?: number;
    db?: any;
  }): Promise<GoalReview> {
    const configuredModel = this.models.epicReviewer;
    if (configuredModel === "gemini-cli") {
      return this.gemini.runEpicReviewer({ role: "epicReviewer", ...input });
    }
    if (configuredModel === "qwen-cli") {
      return this.qwen.runEpicReviewer({ role: "epicReviewer", ...input });
    }
    if (configuredModel.startsWith("opencode:")) {
      return this.opencode.runEpicReviewer({ role: "epicReviewer", ...input });
    }

    const model = this.resolveHarnessModel("epicReviewer");
    input.onStream?.({
      agentRole: "epicReviewer",
      source: "orchestrator",
      streamKind: "status",
      content: "Reviewing via mediated agent harness...",
      runId: input.runId,
      epicId: input.epicId,
      sequence: 0,
    });

    const toolContext = this.buildToolContext(input.cwd, "epicReviewer", { ragIndexId: input.ragIndexId, db: input.db });

    const harness = new MediatedAgentHarness({
      baseURL: `${this.ollamaBaseURL}/v1`,
      apiKey: "ollama",
      model,
      braveApiKey: this.braveApiKey,
      toolContext,
    });

    await ensureModelLoaded(model);
    const result = await harness.run("epicReviewer", input.prompt, {
      maxIterations: 80,
      timeoutMs: 900_000,
      onEvent: (event) => {
        if (event.kind === "text" || event.kind === "thinking") {
          input.onStream?.({
            agentRole: "epicReviewer",
            source: "mediated-harness",
            streamKind: event.kind === "thinking" ? "thinking" : "assistant",
            content: event.text,
            runId: input.runId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
        if (event.kind === "tool_call") {
          const argsPreview = JSON.stringify(event.call.args ?? {}).slice(0, 300);
          input.onStream?.({
            agentRole: "epicReviewer",
            source: "mediated-harness",
            streamKind: "tool_call",
            content: `${event.call.name}(${argsPreview})`,
            runId: input.runId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.call.name, toolArgs: event.call.args as import("../types.ts").Json },
          });
        }
        if (event.kind === "complete") {
          input.onStream?.({
            agentRole: "epicReviewer",
            source: "mediated-harness",
            streamKind: "status",
            content: `Completed in ${event.iterations} iterations`,
            runId: input.runId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
      },
    });
    markModelLoaded(model);

    return validateGoalReview(parseJsonText(result.text));
  }

  async runEpicDecoderOpenCode(input: {
    cwd: string;
    prompt: string;
    runId?: string | null;
    epicId?: string | null;
    onStream?: StreamHook;
  }): Promise<GoalDecomposition> {
    const parsed = await this.opencode.runEpicDecoder({ role: "epicDecoder", ...input });
    return validateGoalDecomposition(parsed);
  }

  runEpicReviewerCodex(input: {
    cwd: string;
    prompt: string;
    runId?: string | null;
    epicId?: string | null;
    onStream?: StreamHook;
  }): Promise<GoalReview> {
    if (this.models.epicReviewer === "gemini-cli") {
      return this.gemini.runEpicReviewer({ role: "epicReviewer", ...input });
    }
    if (this.models.epicReviewer === "qwen-cli") {
      return this.qwen.runEpicReviewer({ role: "epicReviewer", ...input });
    }
    return this.codex.runEpicReviewer({ role: "epicReviewer", ...input });
  }

  async runExplorerInWorkspace(input: {
    cwd: string;
    prompt: string;
    runId?: string | null;
    ticketId?: string | null;
    epicId?: string | null;
    onStream?: StreamHook;
  }): Promise<string> {
    const model = this.resolveHarnessModel("explorer");
    input.onStream?.({
      agentRole: "explorer",
      source: "orchestrator",
      streamKind: "status",
      content: "Exploring via mediated agent harness...",
      runId: input.runId,
      ticketId: input.ticketId,
      epicId: input.epicId,
      sequence: 0,
    });

    const toolContext = this.buildToolContext(input.cwd, input.ticketId || "unknown");
    const harness = new MediatedAgentHarness({
      baseURL: `${this.ollamaBaseURL}/v1`,
      apiKey: "ollama",
      model,
      braveApiKey: this.braveApiKey,
      toolContext,
    });

    await ensureModelLoaded(model);
    const result = await harness.run("explorer", input.prompt, {
      maxIterations: 50,
      timeoutMs: 900_000,
      onEvent: (event) => {
        if (event.kind === "text" || event.kind === "thinking") {
          input.onStream?.({
            agentRole: "explorer",
            source: "mediated-harness",
            streamKind: event.kind === "thinking" ? "thinking" : "assistant",
            content: event.text,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
        if (event.kind === "tool_call") {
          const argsPreview = JSON.stringify(event.call.args ?? {}).slice(0, 300);
          input.onStream?.({
            agentRole: "explorer",
            source: "mediated-harness",
            streamKind: "tool_call",
            content: `${event.call.name}(${argsPreview})`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.call.name, toolArgs: event.call.args as import("../types.ts").Json },
          });
        }
        if (event.kind === "tool_result") {
          input.onStream?.({
            agentRole: "explorer",
            source: "mediated-harness",
            streamKind: "tool_result",
            content: event.result.output,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.result.name, toolResult: event.result.output, isError: Boolean(event.result.isError) },
          });
        }
        if (event.kind === "tool_error") {
          input.onStream?.({
            agentRole: "explorer",
            source: "mediated-harness",
            streamKind: "error",
            content: `Tool error: ${event.error}`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.call.name, error: event.error },
          });
        }
        if (event.kind === "complete") {
          input.onStream?.({
            agentRole: "explorer",
            source: "mediated-harness",
            streamKind: "status",
            content: `Completed in ${event.iterations} iterations`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
      },
    });
    markModelLoaded(model);

    return result.text;
  }

  async runCoderDirect(input: {
    prompt: string;
    runId?: string | null;
    ticketId?: string | null;
    epicId?: string | null;
    onStream?: StreamHook;
  }): Promise<string> {
    const model = resolveOllamaModel("coder", this.models);
    input.onStream?.({
      agentRole: "coder",
      source: "orchestrator",
      streamKind: "status",
      content: `Coding via direct model call (${model})...`,
      runId: input.runId,
      ticketId: input.ticketId,
      epicId: input.epicId,
      sequence: 0,
    });

    // Use rawPrompt for direct call
    const response = await this.rawPrompt("coder", input.prompt);
    
    input.onStream?.({
      agentRole: "coder",
      source: "orchestrator",
      streamKind: "assistant",
      content: response,
      runId: input.runId,
      ticketId: input.ticketId,
      epicId: input.epicId,
      sequence: 1,
      metadata: { model },
    });

    return response;
  }

  async runBuilderInWorkspace(input: {
    cwd: string;
    prompt: string;
    runId?: string | null;
    ticketId?: string | null;
    epicId?: string | null;
    onStream?: StreamHook;
  }): Promise<OpenCodeBuilderResult> {
    if (this.models.builder === "gemini-cli") {
      return this.gemini.runBuilder({ role: "builder", ...input });
    }
    if (this.models.builder === "qwen-cli") {
      return this.qwen.runBuilder({ role: "builder", ...input });
    }
    if (this.models.builder === "codex-cli") {
      return this.codex.runBuilder({ role: "builder", ...input });
    }

    const model = this.resolveHarnessModel("builder");
    input.onStream?.({
      agentRole: "builder",
      source: "orchestrator",
      streamKind: "status",
      content: "Building via mediated agent harness...",
      runId: input.runId,
      ticketId: input.ticketId,
      epicId: input.epicId,
      sequence: 0,
    });

    try {
      return await this.runBuilderAttempt(input, model, "native");
    } catch (nativeError) {
      input.onStream?.({
        agentRole: "builder",
        source: "orchestrator",
        streamKind: "stderr",
        content: `Mediated builder failed in native tool mode: ${nativeError instanceof Error ? nativeError.message : String(nativeError)}. Retrying in XML compatibility mode.`,
        runId: input.runId,
        ticketId: input.ticketId,
        epicId: input.epicId,
        sequence: 0,
      });
    }

    return await this.runBuilderAttempt(input, model, "xml");
  }

  async runTesterInWorkspace(input: {
    cwd: string;
    prompt: string;
    runId?: string | null;
    ticketId?: string | null;
    epicId?: string | null;
    onStream?: StreamHook;
  }): Promise<TesterResult> {
    const model = this.resolveHarnessModel("tester");
    input.onStream?.({
      agentRole: "tester",
      source: "orchestrator",
      streamKind: "status",
      content: "Testing via mediated agent harness...",
      runId: input.runId,
      ticketId: input.ticketId,
      epicId: input.epicId,
      sequence: 0,
    });

    const toolContext = this.buildToolContext(input.cwd, "tester");

    const harness = new MediatedAgentHarness({
      baseURL: `${this.ollamaBaseURL}/v1`,
      apiKey: "ollama",
      model,
      braveApiKey: this.braveApiKey,
      toolContext,
    });

    // TIGHT LIMITS: Tester must decide within 50 iterations (prompt says 3 tool calls)
    await ensureModelLoaded(model);
    const result = await harness.run("tester", input.prompt, {
      maxIterations: 80,
      timeoutMs: 300_000, // 5 minutes
      onEvent: (event) => {
        if (event.kind === "text" || event.kind === "thinking") {
          input.onStream?.({
            agentRole: "tester",
            source: "mediated-harness",
            streamKind: event.kind === "thinking" ? "thinking" : "assistant",
            content: event.text,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
        if (event.kind === "tool_call") {
          const argsPreview = JSON.stringify(event.call.args ?? {}).slice(0, 300);
          input.onStream?.({
            agentRole: "tester",
            source: "mediated-harness",
            streamKind: "tool_call",
            content: `${event.call.name}(${argsPreview})`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.call.name, toolArgs: event.call.args as import("../types.ts").Json },
          });
        }
        if (event.kind === "complete") {
          input.onStream?.({
            agentRole: "tester",
            source: "mediated-harness",
            streamKind: "status",
            content: `Completed in ${event.iterations} iterations`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
      },
    });
    markModelLoaded(model);

    const parsed = parseJsonText(result.text) as TesterResult;
    return {
      testNecessityScore: parsed.testNecessityScore ?? 0,
      testNecessityReason: parsed.testNecessityReason ?? "",
      testsWritten: parsed.testsWritten ?? false,
      testFiles: parsed.testFiles ?? [],
      testResults: parsed.testResults ?? "SKIPPED",
      testOutput: parsed.testOutput ?? "",
      testsRun: parsed.testsRun ?? 0,
    };
  }

  private resolveHarnessModel(role: AgentRole): string {
    const raw = this.models[role];
    if (!raw) return process.env.OLLAMA_FALLBACK_MODEL || "qwen3:8b";
    if (raw.startsWith("mediated:")) return raw.slice("mediated:".length);
    return raw;
  }

  protected buildBuilderXmlPrompt(prompt: string): string {
    return [
      "You are a code-writing agent using XML function calls.",
      "Every assistant turn must be exactly one XML function call and nothing else.",
      "Use XML function calls instead of native tool calling.",
      "Available functions include read_file, read_files, write_file, write_files, list_dir, glob_files, grep_files, run_command, save_artifact, and finish.",
      "Use this exact syntax when calling tools:",
      "<function=read_file><parameter=path>package.json</parameter></function=read_file>",
      "After each tool result, continue with exactly one XML function call.",
      "Do not emit prose before or after tool calls.",
      "",
      prompt
    ].join("\n\n");
  }

  protected async runBuilderAttempt(
    input: {
      cwd: string;
      prompt: string;
      runId?: string | null;
      ticketId?: string | null;
      epicId?: string | null;
      onStream?: StreamHook;
    },
    model: string,
    toolMode: "native" | "xml"
  ): Promise<OpenCodeBuilderResult> {
    const toolContext = this.buildToolContext(input.cwd, "builder");
    const harness = new MediatedAgentHarness({
      baseURL: `${this.ollamaBaseURL}/v1`,
      apiKey: "ollama",
      model,
      braveApiKey: this.braveApiKey,
      toolContext,
    });

    const mediatedPrompt = [
      "MEDIATED HARNESS OVERRIDE:",
      "Ignore any instruction to output a FINAL_JSON block directly.",
      "Use only tool calls while working, then end by calling the finish tool.",
      "Do not return plain JSON or prose as your final answer.",
      "",
      toolMode === "xml" ? this.buildBuilderXmlPrompt(input.prompt) : input.prompt,
    ].join("\n");

    await ensureModelLoaded(model);
    const result = await harness.run("builder", mediatedPrompt, {
      maxIterations: 100,
      timeoutMs: 1_800_000,
      toolMode,
      onEvent: (event) => {
        if (event.kind === "text" || event.kind === "thinking") {
          input.onStream?.({
            agentRole: "builder",
            source: "mediated-harness",
            streamKind: event.kind === "thinking" ? "thinking" : "assistant",
            content: event.text,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
        if (event.kind === "tool_call") {
          const argsPreview = JSON.stringify(event.call.args ?? {}).slice(0, 300);
          input.onStream?.({
            agentRole: "builder",
            source: "mediated-harness",
            streamKind: "tool_call",
            content: `${event.call.name}(${argsPreview})`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.call.name, toolArgs: event.call.args as import("../types.ts").Json },
          });
        }
        if (event.kind === "tool_result") {
          input.onStream?.({
            agentRole: "builder",
            source: "mediated-harness",
            streamKind: "tool_result",
            content: event.result.output,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.result.name, toolResult: event.result.output, isError: Boolean(event.result.isError) },
          });
        }
        if (event.kind === "tool_error") {
          input.onStream?.({
            agentRole: "builder",
            source: "mediated-harness",
            streamKind: "stderr",
            content: `Tool error: ${event.error}`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
        if (event.kind === "complete") {
          input.onStream?.({
            agentRole: "builder",
            source: "mediated-harness",
            streamKind: "status",
            content: `Completed in ${event.iterations} iterations`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
      },
    });
    markModelLoaded(model);

    return {
      summary: result.text.slice(0, 500),
      sessionId: null,
      rawOutput: result.text,
    };
  }

  private buildToolContext(
    cwd: string,
    workspaceId: string,
    ragOptions?: { ragIndexId?: number; db?: any }
  ): ToolExecutionContext {
    return {
      cwd,
      workspaceId,
      ragIndexId: ragOptions?.ragIndexId,
      db: ragOptions?.db,
      allowedPaths: ["*"],
      braveApiKey: this.braveApiKey,
      readFiles: async (paths) => {
        const { readFile } = await import("node:fs/promises");
        const path = await import("node:path");
        const result: Record<string, string> = {};
        for (const p of paths) {
          try {
            result[p] = await readFile(path.join(cwd, p), "utf-8");
          } catch {}
        }
        return result;
      },
      writeFiles: async (files) => {
        const { writeFile, mkdir } = await import("node:fs/promises");
        const path = await import("node:path");
        for (const f of files) {
          const fullPath = path.join(cwd, f.path);
          await mkdir(path.dirname(fullPath), { recursive: true });
          await writeFile(fullPath, f.content, "utf-8");
        }
      },
      gitDiff: async () => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        try {
          const { stdout } = await execFileAsync("git", ["diff"], { cwd, timeout: 10000 });
          return stdout;
        } catch { return ""; }
      },
      gitStatus: async () => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        try {
          const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd, timeout: 10000 });
          return stdout;
        } catch { return ""; }
      },
      runNamedCommand: async (name) => {
        const config = loadConfig();
        const command = config.commandCatalog[name as keyof typeof config.commandCatalog];
        if (!command) return { stdout: "", stderr: `Unknown command: ${name}`, exitCode: 1 };
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        try {
          const { stdout, stderr } = await execAsync(command, { cwd, timeout: 120_000 });
          return { stdout, stderr, exitCode: 0 };
        } catch (err: any) {
          return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(err), exitCode: err.code ?? 1 };
        }
      },
      saveArtifact: async (opts) => {
        const { writeFile, mkdir } = await import("node:fs/promises");
        const path = await import("node:path");
        const config = loadConfig();
        const dir = path.join(config.artifactsDir, workspaceId);
        await mkdir(dir, { recursive: true });
        const artifactPath = path.join(dir, `${opts.name}.txt`);
        await writeFile(artifactPath, opts.content, "utf-8");
        return artifactPath;
      },
    };
  }
}

export function createGateway(modelsOverride?: Record<AgentRole, string>): ModelGateway {
  const models = modelsOverride || loadConfig().models;
  // If any role uses mediated: prefix, use the mediated harness gateway
  const hasMediated = Object.values(models).some(m => m.startsWith("mediated:"));
  if (hasMediated) {
    return new MediatedAgentHarnessGateway(undefined, modelsOverride);
  }
  return new OpenCodeHybridGateway(modelsOverride);
}
