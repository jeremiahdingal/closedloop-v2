import { AppDatabase } from "../db/database.ts";
import { randomId, nowIso } from "../utils.ts";
import { goalDecomposerPrompt, goalReviewerPrompt, goalReviewerToolingPrompt } from "./prompts.ts";
import type { ModelGateway } from "./models.ts";
import type { AgentStreamPayload, EpicRecord, GoalTicketPlan } from "../types.ts";
import { TicketRunner } from "./ticket-runner.ts";
import { loadConfig } from "../config.ts";
import { loadLangGraphRuntime, type LangGraphRuntime } from "./langgraph-loader.ts";

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

export class GoalRunner {
  readonly config = loadConfig();
  private readonly db: AppDatabase;
  private readonly ticketRunner: TicketRunner;
  private readonly gateway: ModelGateway;

  constructor(db: AppDatabase, ticketRunner: TicketRunner, gateway: ModelGateway) {
    this.db = db;
    this.ticketRunner = ticketRunner;
    this.gateway = gateway;
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
      this.db.updateRun({ runId, status: "running", currentNode: "decompose_goal", heartbeatAt: nowIso(), lastMessage: "Decomposing goal." });
      this.db.updateEpicStatus(epic.id, "executing");

      const plan = await this.gateway.getGoalDecomposition(goalDecomposerPrompt(epic));
      const normalizedPlans = plan.tickets.map((ticket) => ({ ...ticket, id: `${epic.id}__${ticket.id}` }));
      const idMap = new Map(plan.tickets.map((ticket, index) => [ticket.id, normalizedPlans[index].id]));
      for (const planTicket of normalizedPlans) {
        planTicket.dependencies = plan.tickets
          .find((original) => `${epic.id}__${original.id}` === planTicket.id)?.dependencies
          .map((dependency) => idMap.get(dependency) ?? dependency) ?? [];
      }
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
      this.db.updateRun({ runId, status: "running", currentNode: "execute_tickets", heartbeatAt: nowIso(), lastMessage: "Executing tickets." });
      const createdTickets = state.ticketIds.map((ticketId) => this.db.getTicket(ticketId)).filter(Boolean) as any[];
      const summaries: string[] = [];
      for (const ticket of createdTickets.filter((item) => item.dependencies.length === 0)) {
        if (!ticket.currentRunId) await this.ticketRunner.start(ticket.id, epic.id);
      }

      for (const ticket of createdTickets) {
        let current = this.db.getTicket(ticket.id);
        while (current && (current.status === "queued" || current.status === "building" || current.status === "reviewing" || current.status === "testing")) {
          const queuedRun = this.db.listRuns().find((record) => record.ticketId === ticket.id && (record.status === "queued" || record.status === "running"));
          if (queuedRun?.status === "queued") {
            await this.ticketRunner.runExisting(queuedRun.id);
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
            if (depRun) await this.ticketRunner.runExisting(depRun.id);
          }
        }
      }
      return { ticketSummaries: summaries, status: "reviewing" } satisfies Partial<GoalGraphState>;
    };

    const reviewGoal = async (state: GoalGraphState) => {
      this.db.updateRun({ runId, status: "running", currentNode: "goal_review", heartbeatAt: nowIso(), lastMessage: "Reviewing epic." });
      const ticketPlans = state.ticketIds.map((ticketId) => this.db.getTicket(ticketId)).filter(Boolean).map((ticket) => ({
        id: ticket!.id,
        title: ticket!.title,
        description: ticket!.description,
        acceptanceCriteria: ticket!.acceptanceCriteria,
        dependencies: ticket!.dependencies,
        allowedPaths: ticket!.allowedPaths,
        priority: ticket!.priority
      })) as GoalTicketPlan[];
      const review = await this.runGoalReview(epic, ticketPlans, state.ticketSummaries, runId);
      return {
        reviewVerdict: review.verdict,
        reviewSummary: review.summary,
        status: review.verdict === "approved" ? "done" : "failed"
      } satisfies Partial<GoalGraphState>;
    };

    const finalizeGoal = async (state: GoalGraphState) => {
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
    await graph.invoke({ runId, epicId: epic.id }, { configurable: { thread_id: runId } });
  }

  private async runExistingLegacy(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run || !run.epicId) throw new Error(`Epic run not found: ${runId}`);
    const epic = this.db.getEpic(run.epicId);
    if (!epic) throw new Error(`Epic not found: ${run.epicId}`);

    this.db.updateRun({ runId, status: "running", currentNode: "decompose_goal", heartbeatAt: nowIso(), lastMessage: "Decomposing goal." });
    this.db.updateEpicStatus(epic.id, "executing");

    const plan = await this.gateway.getGoalDecomposition(goalDecomposerPrompt(epic));
    const normalizedPlans = plan.tickets.map((ticket) => ({ ...ticket, id: `${epic.id}__${ticket.id}` }));
    const idMap = new Map(plan.tickets.map((ticket, index) => [ticket.id, normalizedPlans[index].id]));
    for (const planTicket of normalizedPlans) {
      planTicket.dependencies = plan.tickets
        .find((original) => `${epic.id}__${original.id}` === planTicket.id)?.dependencies
        .map((dependency) => idMap.get(dependency) ?? dependency) ?? [];
    }

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
        metadata: { maxBuildAttempts: 3, sourceTicketId: ticket.id }
      })
    ));

    for (const ticket of createdTickets.filter((item) => item.dependencies.length === 0)) {
      await this.ticketRunner.start(ticket.id, epic.id);
    }

    const summaries: string[] = [];
    const ticketPlans: GoalTicketPlan[] = normalizedPlans;
    for (const ticket of createdTickets) {
      let current = this.db.getTicket(ticket.id);
      while (current && (current.status === "queued" || current.status === "building" || current.status === "reviewing" || current.status === "testing")) {
        const queuedRun = this.db.listRuns().find((record) => record.ticketId === ticket.id && (record.status === "queued" || record.status === "running"));
        if (queuedRun?.status === "queued") {
          await this.ticketRunner.runExisting(queuedRun.id);
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
          if (depRun) await this.ticketRunner.runExisting(depRun.id);
        }
      }
    }

    this.db.updateRun({ runId, currentNode: "goal_review", heartbeatAt: nowIso(), lastMessage: "Reviewing epic." });
    const review = await this.runGoalReview(epic, ticketPlans, summaries, runId);
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

  private async runGoalReview(epic: EpicRecord, ticketPlans: GoalTicketPlan[], summaries: string[], runId: string) {
    if (this.gateway.runGoalReviewInWorkspace) {
      return this.gateway.runGoalReviewInWorkspace({
        cwd: this.config.repoRoot,
        prompt: goalReviewerToolingPrompt(epic, ticketPlans, summaries),
        runId,
        epicId: epic.id,
        onStream: (event) => this.recordAgentStream(event)
      });
    }
    this.recordAgentStream({ agentRole: "goalReviewer", source: "orchestrator", streamKind: "status", content: "Goal review started...", runId, epicId: epic.id, sequence: 0 });
    const review = await this.gateway.getGoalReview(goalReviewerPrompt(epic, ticketPlans, summaries));
    this.recordAgentStream({ agentRole: "goalReviewer", source: "orchestrator", streamKind: "assistant", content: `Verdict: ${review.verdict} — ${review.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
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

  static createEpic(db: AppDatabase, input: { id?: string; title: string; goalText: string }): EpicRecord {
    return db.createEpic({
      id: input.id ?? randomId("epic"),
      title: input.title,
      goalText: input.goalText,
      status: "planning"
    });
  }
}
