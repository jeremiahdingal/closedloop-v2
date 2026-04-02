import { AppDatabase } from "../db/database.ts";
import { randomId, nowIso } from "../utils.ts";
import { epicDecoderPrompt, epicDecoderToolingPrompt, epicReviewerPrompt, epicReviewerToolingPrompt, epicReviewerCodexPrompt } from "./prompts.ts";
import type { ModelGateway } from "./models.ts";
import type { AgentStreamPayload, EpicRecord, GoalDecomposition, GoalTicketPlan } from "../types.ts";
import { TicketRunner } from "./ticket-runner.ts";
import { loadConfig } from "../config.ts";
import { loadLangGraphRuntime, type LangGraphRuntime } from "./langgraph-loader.ts";
import { formatOpenCodeFailure } from "./opencode.ts";
import { formatCodexFailure } from "./codex.ts";
import { LifecycleService } from "./lifecycle.ts";

type GoalGraphState = {
  runId: string;
  epicId: string;
  ticketIds: string[];
  ticketSummaries: string[];
  decompositionSummary: string;
  reviewVerdict: "approved" | "needs_followups" | "failed";
  reviewSummary: string;
  status: "pending" | "executing" | "reviewing" | "done" | "failed";
};

function sanitizeAllowedPaths(paths: string[]): string[] {
  if (!paths.length) return ["*"];
  const normalized = paths
    .map((pathValue) => String(pathValue || "").trim())
    .filter(Boolean)
    .map((pathValue) => {
      const lower = pathValue.toLowerCase();
      if (lower === "root" || lower === "repo-root" || lower === "repository-root" || lower === "project-root" || lower === "/") {
        return "*";
      }
      return pathValue.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/$/, "") || "*";
    });

  const hasInvalidTicketLike = normalized.some((p) => /^[A-Z]{2,}-\d+$/.test(p) || /^\d+$/.test(p));
  if (hasInvalidTicketLike) return ["src", "lib", "test", "docs"];
  return Array.from(new Set(normalized));
}

function normalizeGoalTicketPlans(epicId: string, tickets: GoalTicketPlan[]): GoalTicketPlan[] {
  const normalized = tickets.map((ticket) => ({
    ...ticket,
    id: ticket.id.startsWith(`${epicId}__`) ? ticket.id : `${epicId}__${ticket.id}`,
    allowedPaths: sanitizeAllowedPaths(ticket.allowedPaths)
  }));

  const idMap = new Map<string, string>();
  normalized.forEach((ticket, index) => {
    idMap.set(tickets[index].id, ticket.id);
    idMap.set(ticket.id, ticket.id);
  });

  return normalized.map((ticket, index) => ({
    ...ticket,
    dependencies: Array.from(new Set(
      (tickets[index]?.dependencies ?? [])
        .map((dependency) => idMap.get(dependency))
        .filter((dependency): dependency is string => Boolean(dependency))
    ))
  }));
}

export class GoalRunner {
  readonly config = loadConfig();
  private readonly heartbeatIntervalMs = 15_000;
  private readonly db: AppDatabase;
  private readonly ticketRunner: TicketRunner;
  private readonly gateway: ModelGateway;
  private readonly lifecycle: LifecycleService;

  constructor(db: AppDatabase, ticketRunner: TicketRunner, gateway: ModelGateway, lifecycle: LifecycleService) {
    this.db = db;
    this.ticketRunner = ticketRunner;
    this.gateway = gateway;
    this.lifecycle = lifecycle;
  }

  async enqueueGoal(epicId: string): Promise<string> {
    const runId = randomId("run");
    this.db.createRun({
      id: runId,
      kind: "epic",
      epicId,
      ticketId: null,
      status: "queued",
      currentNode: "queued",
      attempt: 0,
      heartbeatAt: null,
      lastMessage: "Queued epic run.",
      errorText: null
    });
    this.db.enqueueJob("run_epic", { epicId, runId });
    this.db.recordEvent({
      aggregateType: "epic",
      aggregateId: epicId,
      runId,
      kind: "epic_queued",
      message: "Epic run queued."
    });
    return runId;
  }

  async runExisting(runId: string): Promise<void> {
    if (!this.config.useLangGraph) return this.runExistingLegacy(runId);
    const runtime = await loadLangGraphRuntime();
    if (!runtime) return this.runExistingLegacy(runId);
    return this.runExistingWithLangGraph(runId, runtime);
  }

  private async runExistingWithLangGraph(runId: string, runtime: LangGraphRuntime): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run || !run.epicId) throw new Error(`Epic run not found: ${runId}`);
    const epic = this.db.getEpic(run.epicId);
    if (!epic) throw new Error(`Epic not found: ${run.epicId}`);
    this.assertNotCancelled(epic.id);

    this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Starting LangGraph epic run for: ${epic.title}`, runId, epicId: epic.id, sequence: 0 });

    const { StateGraph, StateSchema, START, END, MemorySaver, z } = runtime;
    const GoalState = new StateSchema({
      runId: z.string(),
      epicId: z.string(),
      ticketIds: z.array(z.string()).default([]),
      ticketSummaries: z.array(z.string()).default([]),
      decompositionSummary: z.string().default(""),
      reviewVerdict: z.enum(["approved", "needs_followups", "failed"]).default("approved"),
      reviewSummary: z.string().default(""),
      status: z.enum(["pending", "executing", "reviewing", "done", "failed"]).default("pending")
    });

    const decomposeGoal = async (_state: GoalGraphState) => {
      this.assertNotCancelled(epic.id);
      this.db.updateRun({ runId, status: "running", currentNode: "decompose_goal", heartbeatAt: nowIso(), lastMessage: "Decomposing goal." });
      this.db.updateEpicStatus(epic.id, "executing");

      const plan = await this.withEpicHeartbeat(runId, epic.id, "decompose_goal", "Decomposing goal.", () => this.runEpicDecoder(epic, runId));
      const normalizedPlans = normalizeGoalTicketPlans(epic.id, plan.tickets);
      const createdTickets = this.db.transaction(() => normalizedPlans.map((ticket) =>
        this.db.createTicket({
          id: ticket.id,
          epicId: epic.id,
          title: ticket.title,
          description: ticket.description,
          acceptanceCriteria: ticket.acceptanceCriteria,
          dependencies: ticket.dependencies,
          allowedPaths: ticket.allowedPaths,
          priority: ticket.priority,
          status: "queued",
          diffFiles: [],
          prUrl: null,
          metadata: { maxBuildAttempts: 3, sourceTicketId: ticket.id }
        })
      ));
      return {
        ticketIds: createdTickets.map((item) => item.id),
        decompositionSummary: plan.summary,
        status: "executing"
      } satisfies Partial<GoalGraphState>;
    };

    const executeTickets = async (state: GoalGraphState) => {
      this.assertNotCancelled(epic.id);
      this.db.updateRun({ runId, status: "running", currentNode: "execute_tickets", heartbeatAt: nowIso(), lastMessage: "Executing tickets." });
      this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Found ${state.ticketIds.length} tickets to execute`, runId, epicId: epic.id, sequence: 0 });
      const createdTickets = state.ticketIds.map((ticketId) => this.db.getTicket(ticketId)).filter(Boolean) as any[];
      const summaries: string[] = [];
      for (const ticket of createdTickets.filter((item) => item.dependencies.length === 0)) {
        this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Starting ticket: ${ticket.id}`, runId, epicId: epic.id, ticketId: ticket.id, sequence: 1 });
        if (!ticket.currentRunId) await this.ticketRunner.start(ticket.id, epic.id);
      }

      for (const ticket of createdTickets) {
        this.assertNotCancelled(epic.id);
        let current = this.db.getTicket(ticket.id);
        while (current && (current.status === "queued" || current.status === "building" || current.status === "reviewing" || current.status === "testing")) {
          const queuedRun = this.db.listRuns().find((record) => record.ticketId === ticket.id && (record.status === "queued" || record.status === "running"));
          if (!queuedRun) break; // no run started yet and none running — ticket is waiting on deps that won't be satisfied
          if (queuedRun.status === "queued") {
            try {
              await this.ticketRunner.runExisting(queuedRun.id);
            } catch {
              // ticket run crashed — DB already updated to failed; continue to next ticket
              break;
            }
          }
          current = this.db.getTicket(ticket.id);
        }
        summaries.push(`${ticket.id}:${current?.status ?? "unknown"}`);
        for (const dependent of createdTickets.filter((candidate) => candidate.dependencies.includes(ticket.id))) {
          const depCurrent = this.db.getTicket(dependent.id);
          const depsReady = dependent.dependencies.every((dependencyId: string) => this.db.getTicket(dependencyId)?.status === "approved");
          if (depCurrent?.status === "queued" && depsReady && !depCurrent.currentRunId) {
            await this.ticketRunner.start(depCurrent.id, epic.id);
            const depRun = this.db.listRuns().find((record) => record.ticketId === depCurrent.id && record.status === "queued");
            if (depRun) {
              try {
                await this.ticketRunner.runExisting(depRun.id);
              } catch {
                // dependent ticket crashed — continue
              }
            }
          }
        }
      }
      return { ticketSummaries: summaries, status: "reviewing" } satisfies Partial<GoalGraphState>;
    };

    const reviewGoal = async (state: GoalGraphState) => {
      this.assertNotCancelled(epic.id);
      this.db.updateRun({ runId, status: "running", currentNode: "goal_review", heartbeatAt: nowIso(), lastMessage: "Reviewing epic." });
      this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Starting goal review with ${state.ticketIds.length} tickets`, runId, epicId: epic.id, sequence: 0 });
      const ticketPlans = state.ticketIds.map((ticketId) => this.db.getTicket(ticketId)).filter(Boolean).map((ticket) => ({
        id: ticket!.id,
        title: ticket!.title,
        description: ticket!.description,
        acceptanceCriteria: ticket!.acceptanceCriteria,
        dependencies: ticket!.dependencies,
        allowedPaths: ticket!.allowedPaths,
        priority: ticket!.priority
      })) as GoalTicketPlan[];
      const tickets = this.db.listTickets(epic.id);
      const incompleteTickets = tickets.filter((ticket) => ticket.status !== "approved");
      if (incompleteTickets.length) {
        const summary = `Epic review blocked: ${incompleteTickets.map((ticket) => `${ticket.id}:${ticket.status}`).join(", ")}`;
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: summary, runId, epicId: epic.id, sequence: 1, done: true });
        return {
          reviewVerdict: "failed",
          reviewSummary: summary,
          status: "failed"
        } satisfies Partial<GoalGraphState>;
      }
      const prUrls = tickets.filter(t => t.prUrl).map(t => t.prUrl!);
      const review = await this.withEpicHeartbeat(runId, epic.id, "goal_review", "Reviewing epic.", () =>
        this.runEpicReview(epic, ticketPlans, state.ticketSummaries, prUrls, runId)
      );
      this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Goal review complete: ${review.verdict}`, runId, epicId: epic.id, sequence: 1 });
      return {
        reviewVerdict: review.verdict,
        reviewSummary: review.summary,
        status: review.verdict === "approved" ? "done" : "failed"
      } satisfies Partial<GoalGraphState>;
    };

    const finalizeGoal = async (state: GoalGraphState) => {
      this.assertNotCancelled(epic.id);
      const approved = state.reviewVerdict === "approved";
      this.db.updateEpicStatus(epic.id, approved ? "done" : "failed");
      this.db.updateRun({
        runId,
        status: approved ? "succeeded" : "failed",
        currentNode: "complete",
        heartbeatAt: nowIso(),
        lastMessage: state.reviewSummary,
        errorText: approved ? null : state.reviewSummary
      });
      this.db.recordEvent({
        aggregateType: "epic",
        aggregateId: epic.id,
        runId,
        kind: "epic_reviewed",
        message: state.reviewSummary,
        payload: {
          verdict: state.reviewVerdict,
          ticketSummaries: state.ticketSummaries
        }
      });
      return state;
    };

    const graphBuilder = new StateGraph(GoalState)
      .addNode("decompose_goal", decomposeGoal)
      .addNode("execute_tickets", executeTickets)
      .addNode("goal_review", reviewGoal)
      .addNode("finalize_goal", finalizeGoal)
      .addEdge(START, "decompose_goal")
      .addEdge("decompose_goal", "execute_tickets")
      .addEdge("execute_tickets", "goal_review")
      .addEdge("goal_review", "finalize_goal")
      .addEdge("finalize_goal", END);

    const graph = graphBuilder.compile(MemorySaver ? { checkpointer: new MemorySaver() } : undefined);
    try {
      await graph.invoke({ runId, epicId: epic.id }, { configurable: { thread_id: runId } });
    } catch (error) {
      if (error instanceof EpicCancelledError) return;
      throw error;
    }
  }

  private async runExistingLegacy(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run || !run.epicId) throw new Error(`Epic run not found: ${runId}`);
    const epic = this.db.getEpic(run.epicId);
    if (!epic) throw new Error(`Epic not found: ${run.epicId}`);
    this.assertNotCancelled(epic.id);

    this.db.updateRun({ runId, status: "running", currentNode: "decompose_goal", heartbeatAt: nowIso(), lastMessage: "Decomposing goal." });
    this.db.updateEpicStatus(epic.id, "executing");

    const plan = await this.withEpicHeartbeat(runId, epic.id, "decompose_goal", "Decomposing goal.", () => this.runEpicDecoder(epic, runId));
    const normalizedPlans = normalizeGoalTicketPlans(epic.id, plan.tickets);

    const createdTickets = this.db.transaction(() => normalizedPlans.map((ticket) =>
      this.db.createTicket({
        id: ticket.id,
        epicId: epic.id,
        title: ticket.title,
        description: ticket.description,
        acceptanceCriteria: ticket.acceptanceCriteria,
        dependencies: ticket.dependencies,
        allowedPaths: ticket.allowedPaths,
        priority: ticket.priority,
        status: "queued",
        diffFiles: [],
        prUrl: null,
        metadata: { maxBuildAttempts: 3, sourceTicketId: ticket.id }
      })
    ));

    for (const ticket of createdTickets.filter((item) => item.dependencies.length === 0)) {
      this.assertNotCancelled(epic.id);
      await this.ticketRunner.start(ticket.id, epic.id);
    }

    const summaries: string[] = [];
    const ticketPlans: GoalTicketPlan[] = normalizedPlans;
    for (const ticket of createdTickets) {
      this.assertNotCancelled(epic.id);
      let current = this.db.getTicket(ticket.id);
      while (current && (current.status === "queued" || current.status === "building" || current.status === "reviewing" || current.status === "testing")) {
        const queuedRun = this.db.listRuns().find((record) => record.ticketId === ticket.id && (record.status === "queued" || record.status === "running"));
        if (!queuedRun) break; // no run started yet and none running — ticket is waiting on deps that won't be satisfied
        if (queuedRun.status === "queued") {
          try {
            await this.ticketRunner.runExisting(queuedRun.id);
          } catch {
            break;
          }
        }
        current = this.db.getTicket(ticket.id);
      }
      summaries.push(`${ticket.id}:${current?.status ?? "unknown"}`);
      for (const dependent of createdTickets.filter((candidate) => candidate.dependencies.includes(ticket.id))) {
        const depCurrent = this.db.getTicket(dependent.id);
        const depsReady = dependent.dependencies.every((dependencyId) => this.db.getTicket(dependencyId)?.status === "approved");
        if (depCurrent?.status === "queued" && depsReady && !depCurrent.currentRunId) {
          await this.ticketRunner.start(depCurrent.id, epic.id);
          const depRun = this.db.listRuns().find((record) => record.ticketId === depCurrent.id && record.status === "queued");
          if (depRun) {
            try {
              await this.ticketRunner.runExisting(depRun.id);
            } catch {
              // continue
            }
          }
        }
      }
    }

    this.db.updateRun({ runId, currentNode: "goal_review", heartbeatAt: nowIso(), lastMessage: "Reviewing epic." });
    const tickets = this.db.listTickets(epic.id);
    const incompleteTickets = tickets.filter((ticket) => ticket.status !== "approved");
    if (incompleteTickets.length) {
      const summary = `Epic review blocked: ${incompleteTickets.map((ticket) => `${ticket.id}:${ticket.status}`).join(", ")}`;
      this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: summary, runId, epicId: epic.id, sequence: 1, done: true });
      this.db.updateEpicStatus(epic.id, "failed");
      this.db.updateRun({
        runId,
        status: "failed",
        currentNode: "complete",
        heartbeatAt: nowIso(),
        lastMessage: summary,
        errorText: summary
      });
      this.db.recordEvent({
        aggregateType: "epic",
        aggregateId: epic.id,
        runId,
        kind: "epic_reviewed",
        message: summary,
        payload: { verdict: "failed", ticketSummaries: summaries }
      });
      return;
    }
    const prUrls = tickets.filter(t => t.prUrl).map(t => t.prUrl!);
    const review = await this.withEpicHeartbeat(runId, epic.id, "goal_review", "Reviewing epic.", () =>
      this.runEpicReview(epic, ticketPlans, summaries, prUrls, runId)
    );
    this.db.updateEpicStatus(epic.id, review.verdict === "approved" ? "done" : "failed");
    this.db.updateRun({
      runId,
      status: review.verdict === "approved" ? "succeeded" : "failed",
      currentNode: "complete",
      heartbeatAt: nowIso(),
      lastMessage: review.summary,
      errorText: review.verdict === "approved" ? null : review.summary
    });
    this.db.recordEvent({
      aggregateType: "epic",
      aggregateId: epic.id,
      runId,
      kind: "epic_reviewed",
      message: review.summary,
      payload: review as any
    });
  }

  private async runEpicDecoder(epic: EpicRecord, runId: string): Promise<GoalDecomposition> {
    if (this.gateway.runEpicDecoderInWorkspace && this.gateway.models.epicDecoder === "codex-cli") {
      try {
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "status", content: "Decomposing via Codex...", runId, epicId: epic.id, sequence: 0 });
        const result = await this.gateway.runEpicDecoderInWorkspace({
          cwd: epic.targetDir,
          prompt: epicDecoderToolingPrompt(epic),
          runId,
          epicId: epic.id,
          onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
        });
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "assistant", content: `Decomposed into ${result.tickets.length} tickets.\nSummary: ${result.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
        return result;
      } catch (err) {
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "stderr", content: `${formatCodexFailure(err)}. Falling back to Ollama.`, runId, epicId: epic.id, sequence: 0 });
      }
    }
    if (this.gateway.runEpicDecoderOpenCode && this.gateway.models.epicDecoder.startsWith("opencode:")) {
      try {
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "status", content: "Decomposing via OpenCode...", runId, epicId: epic.id, sequence: 0 });
        const result = await this.gateway.runEpicDecoderOpenCode({
          cwd: epic.targetDir,
          prompt: epicDecoderToolingPrompt(epic),
          runId,
          epicId: epic.id,
          onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
        });
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "assistant", content: `Decomposed into ${result.tickets.length} tickets.\nSummary: ${result.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
        return result;
      } catch (err) {
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "stderr", content: `${formatOpenCodeFailure(err)}. Falling back to Ollama.`, runId, epicId: epic.id, sequence: 0 });
      }
    }
    if (this.gateway.runEpicDecoderInWorkspace && this.gateway.models.epicDecoder.startsWith("mediated:")) {
      try {
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "status", content: "Decomposing via mediated agent harness...", runId, epicId: epic.id, sequence: 0 });
        const result = await this.gateway.runEpicDecoderInWorkspace({
          cwd: epic.targetDir,
          prompt: epicDecoderToolingPrompt(epic),
          runId,
          epicId: epic.id,
          onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
        });
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "assistant", content: `Decomposed into ${result.tickets.length} tickets.\nSummary: ${result.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
        return result;
      } catch (err) {
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "stderr", content: `Mediated harness failed: ${err instanceof Error ? err.message : String(err)}. Falling back to Ollama.`, runId, epicId: epic.id, sequence: 0 });
      }
    }
    this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "status", content: "Decomposing goal into tickets via Ollama...", runId, epicId: epic.id, sequence: 0, done: false });
    const plan = await this.gateway.getGoalDecomposition(epicDecoderPrompt(epic));
    this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "assistant", content: `Decomposed into ${plan.tickets.length} tickets.\nSummary: ${plan.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
    return plan;
  }

  private async runEpicReview(epic: EpicRecord, ticketPlans: GoalTicketPlan[], summaries: string[], prUrls: string[], runId: string) {
    if (this.gateway.runEpicReviewerCodex && this.gateway.models.epicReviewer === "codex-cli") {
      try {
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "status", content: "Goal review started via Codex...", runId, epicId: epic.id, sequence: 0 });
        const review = await this.gateway.runEpicReviewerCodex({
          cwd: epic.targetDir,
          prompt: epicReviewerCodexPrompt(epic, ticketPlans, summaries, prUrls),
          runId,
          epicId: epic.id,
          onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
        });
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: `Verdict: ${review.verdict} — ${review.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
        return review;
      } catch (err) {
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "stderr", content: `${formatCodexFailure(err)}. Falling back to OpenCode.`, runId, epicId: epic.id, sequence: 0 });
      }
    }
    if (this.gateway.runGoalReviewInWorkspace && !this.gateway.models.epicReviewer.startsWith("mediated:")) {
      try {
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "status", content: "Goal review started via OpenCode...", runId, epicId: epic.id, sequence: 0 });
        const review = await this.gateway.runGoalReviewInWorkspace({
          cwd: epic.targetDir,
          prompt: epicReviewerToolingPrompt(epic, ticketPlans, summaries, prUrls),
          runId,
          epicId: epic.id,
          onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
        });
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: `Verdict: ${review.verdict} — ${review.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
        return review;
      } catch (err) {
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "stderr", content: `${formatOpenCodeFailure(err)}. Falling back to Ollama.`, runId, epicId: epic.id, sequence: 0 });
      }
    }
    if (this.gateway.runGoalReviewInWorkspace && this.gateway.models.epicReviewer.startsWith("mediated:")) {
      try {
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "status", content: "Goal review started via mediated agent harness...", runId, epicId: epic.id, sequence: 0 });
        const review = await this.gateway.runGoalReviewInWorkspace({
          cwd: epic.targetDir,
          prompt: epicReviewerToolingPrompt(epic, ticketPlans, summaries, prUrls),
          runId,
          epicId: epic.id,
          onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
        });
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: `Verdict: ${review.verdict} — ${review.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
        return review;
      } catch (err) {
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "stderr", content: `Mediated harness failed: ${err instanceof Error ? err.message : String(err)}. Falling back to Ollama.`, runId, epicId: epic.id, sequence: 0 });
      }
    }
    this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "status", content: "Goal review started via Ollama...", runId, epicId: epic.id, sequence: 0 });
    const review = await this.gateway.getGoalReview(epicReviewerPrompt(epic, ticketPlans, summaries, prUrls));
    this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: `Verdict: ${review.verdict} — ${review.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
    return review;
  }

  private recordAgentStream(event: AgentStreamPayload): void {
    this.db.recordEvent({
      aggregateType: event.ticketId ? "ticket" : "epic",
      aggregateId: event.ticketId ?? event.epicId ?? event.runId ?? "stream",
      runId: event.runId ?? null,
      ticketId: event.ticketId ?? null,
      kind: "agent_stream",
      message: `${event.agentRole}:${event.streamKind}`,
      payload: event as any
    });
  }

  static createEpic(db: AppDatabase, input: { id?: string; title: string; goalText: string; targetDir: string }): EpicRecord {
    return db.createEpic({
      id: input.id ?? randomId("epic"),
      title: input.title,
      goalText: input.goalText,
      targetDir: input.targetDir,
      status: "planning"
    });
  }

  private assertNotCancelled(epicId: string): void {
    if (this.lifecycle.isEpicCancelled(epicId)) {
      throw new EpicCancelledError(`Epic ${epicId} cancelled by user.`);
    }
  }

  private epicHeartbeat(runId: string, epicId: string, node: string, message: string): void {
    this.assertNotCancelled(epicId);
    this.db.updateRun({ runId, status: "running", currentNode: node, heartbeatAt: nowIso(), lastMessage: message });
  }

  private async withEpicHeartbeat<T>(runId: string, epicId: string, node: string, message: string, task: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      try {
        this.epicHeartbeat(runId, epicId, node, message);
      } catch {
        // Let the in-flight task surface the real failure.
      }
    }, this.heartbeatIntervalMs);
    try {
      return await task();
    } finally {
      clearInterval(timer);
    }
  }
}

class EpicCancelledError extends Error {}
