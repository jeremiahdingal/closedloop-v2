import { loadConfig } from "../config.ts";
import type {
  AgentRole,
  AgentStreamPayload,
  BuilderPlan,
  FailureDecision,
  GoalDecomposition,
  GoalReview,
  OpenCodeBuilderResult,
  ReviewerVerdict
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
  runGoalReviewInWorkspace?(input: { cwd: string; prompt: string; runId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<GoalReview>;
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

export class OllamaGateway implements ModelGateway {
  readonly models = loadConfig().models;
  private readonly baseUrl: string;
  constructor(baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434") {
    this.baseUrl = baseUrl;
  }

  async rawPrompt(role: AgentRole, prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.models[role],
        prompt,
        stream: false,
        options: { temperature: 0 }
      })
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed for ${role}: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json() as { response: string };
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
      const model = new ChatOllama({
        model: this.models[role],
        temperature: 0,
        baseUrl: this.baseUrl
      });
      const structured = model.withStructuredOutput((schemas as any)[schemaName]);
      return await structured.invoke(prompt) as T;
    } catch {
      return fallback(parseJsonText(await this.rawPrompt(role, prompt)));
    }
  }

  async getGoalDecomposition(prompt: string): Promise<GoalDecomposition> {
    return this.invokeStructured("goalDecomposer", prompt, validateGoalDecomposition, "goalDecomposition");
  }

  async getBuilderPlan(prompt: string): Promise<BuilderPlan> {
    return this.invokeStructured("builder", prompt, validateBuilderPlan, "builderPlan");
  }

  async getReviewerVerdict(prompt: string): Promise<ReviewerVerdict> {
    return this.invokeStructured("reviewer", prompt, validateReviewerVerdict, "reviewerVerdict");
  }

  async getGoalReview(prompt: string): Promise<GoalReview> {
    return this.invokeStructured("goalReviewer", prompt, validateGoalReview, "goalReview");
  }

  async getFailureDecision(prompt: string): Promise<FailureDecision> {
    return this.invokeStructured("doctor", prompt, validateFailureDecision, "failureDecision");
  }
}

export class OpenCodeHybridGateway implements ModelGateway {
  readonly models = loadConfig().models;
  private readonly ollama: OllamaGateway;
  private readonly opencode: OpenCodeRunner;

  constructor() {
    this.ollama = new OllamaGateway();
    this.opencode = new OpenCodeRunner();
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
    return this.opencode.runBuilder({ role: "builder", ...input });
  }

  runGoalReviewInWorkspace(input: { cwd: string; prompt: string; runId?: string | null; epicId?: string | null; onStream?: StreamHook }): Promise<GoalReview> {
    return this.opencode.runGoalReviewer({ role: "goalReviewer", ...input });
  }
}

export class DryRunGateway implements ModelGateway {
  readonly models = loadConfig().models;

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
    const plan = await this.getBuilderPlan(input.prompt);
    input.onStream?.({ agentRole: "builder", source: "orchestrator", streamKind: "status", content: "[dry-run] Builder started", runId: input.runId, ticketId: input.ticketId, epicId: input.epicId, sequence: 0, done: false });
    input.onStream?.({ agentRole: "builder", source: "orchestrator", streamKind: "assistant", content: plan.summary, runId: input.runId, ticketId: input.ticketId, epicId: input.epicId, sequence: 1, done: false });
    input.onStream?.({ agentRole: "builder", source: "orchestrator", streamKind: "status", content: "[dry-run] Builder completed", runId: input.runId, ticketId: input.ticketId, epicId: input.epicId, sequence: 2, done: true });
    return { summary: plan.summary, sessionId: null, rawOutput: plan.summary };
  }
}

export class MockGateway implements ModelGateway {
  readonly models = loadConfig().models;
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
}
