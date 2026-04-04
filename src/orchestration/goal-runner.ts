import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AppDatabase } from "../db/database.ts";
import { randomId, nowIso } from "../utils.ts";
import { epicDecoderPrompt, epicDecoderToolingPrompt, epicReviewerPrompt, epicReviewerToolingPrompt, epicReviewerCodexPrompt } from "./prompts.ts";
import type { ModelGateway } from "./models.ts";
import type { AgentStreamPayload, EpicRecord, GoalDecomposition, GoalTicketPlan, TicketRecord } from "../types.ts";
import { TicketRunner } from "./ticket-runner.ts";
import { loadConfig } from "../config.ts";
import { loadLangGraphRuntime, type LangGraphRuntime } from "./langgraph-loader.ts";
import { formatOpenCodeFailure } from "./opencode.ts";
import { formatCodexFailure } from "./codex.ts";
import { formatQwenFailure } from "./qwen.ts";
import { LifecycleService } from "./lifecycle.ts";
import { WorkspaceBridge } from "../bridge/workspace-bridge.ts";
import { buildContextForQuery } from "../rag/context-builder.ts";
import { git } from "../bridge/git.ts";

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

function normalizeTicketTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export class GoalRunner {
  readonly config = loadConfig();
  private readonly heartbeatIntervalMs = 15_000;
  private readonly epicReviewTimeoutMs = Number(process.env.EPIC_REVIEW_TIMEOUT_MS || 300_000);
  private readonly reviewCompareBaseRef = this.normalizeCompareRef(process.env.PR_COMPARE_BASE || "origin/main");
  private readonly db: AppDatabase;
  private readonly ticketRunner: TicketRunner;
  private readonly gateway: ModelGateway;
  private readonly lifecycle: LifecycleService;
  private readonly bridge: WorkspaceBridge;

  constructor(db: AppDatabase, ticketRunner: TicketRunner, gateway: ModelGateway, lifecycle: LifecycleService, bridge?: WorkspaceBridge) {
    this.db = db;
    this.ticketRunner = ticketRunner;
    this.gateway = gateway;
    this.lifecycle = lifecycle;
    this.bridge = bridge ?? new WorkspaceBridge(db);
  }

  private materializeTickets(epicId: string, plans: GoalTicketPlan[]) {
    const existing = this.db.listTickets(epicId);
    const byId = new Map(existing.map((ticket) => [ticket.id, ticket] as const));
    const bySourceId = new Map<string, TicketRecord>(
      (existing.map((ticket) => [String((ticket.metadata as any)?.sourceTicketId || ""), ticket] as const) as [string, TicketRecord][]).filter(([key]) => Boolean(key))
    );
    const byTitle = new Map<string, TicketRecord[]>();
    for (const ticket of existing) {
      const key = normalizeTicketTitleKey(ticket.title);
      const bucket = byTitle.get(key) ?? [];
      bucket.push(ticket);
      byTitle.set(key, bucket);
    }

    const usedExistingIds = new Set<string>();
    const planIdToTicketId = new Map<string, string>();
    const createQueue: GoalTicketPlan[] = [];

    const pickExisting = (plan: GoalTicketPlan) => {
      const byExact = byId.get(plan.id);
      if (byExact && !usedExistingIds.has(byExact.id)) return byExact;
      const bySource = bySourceId.get(plan.id);
      if (bySource && !usedExistingIds.has(bySource.id)) return bySource;
      const titleCandidates = byTitle.get(normalizeTicketTitleKey(plan.title)) ?? [];
      return titleCandidates.find((item) => !usedExistingIds.has(item.id)) ?? null;
    };

    for (const plan of plans) {
      const existingMatch = pickExisting(plan);
      if (existingMatch) {
        usedExistingIds.add(existingMatch.id);
        planIdToTicketId.set(plan.id, existingMatch.id);
        continue;
      }
      planIdToTicketId.set(plan.id, plan.id);
      createQueue.push(plan);
    }

    const created = createQueue.map((ticket) => this.db.createTicket({
      id: planIdToTicketId.get(ticket.id) || ticket.id,
      epicId,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      dependencies: ticket.dependencies.map((dependencyId) => planIdToTicketId.get(dependencyId) || dependencyId),
      allowedPaths: ticket.allowedPaths,
      priority: ticket.priority,
      status: "queued",
      diffFiles: [],
      prUrl: null,
      metadata: { maxBuildAttempts: 3, sourceTicketId: ticket.id }
    }));

    const allIds = Array.from(new Set(plans.map((plan) => planIdToTicketId.get(plan.id) || plan.id)));
    const allTickets = allIds.map((ticketId) => this.db.getTicket(ticketId)).filter((t): t is TicketRecord => t !== null);

    return {
      tickets: allTickets,
      ticketIds: allIds,
      reusedCount: allIds.length - created.length,
      createdCount: created.length
    };
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

  async enqueueManualReview(epicId: string): Promise<string> {
    const runId = randomId("run");
    this.db.createRun({
      id: runId,
      kind: "epic",
      epicId,
      ticketId: null,
      status: "queued",
      currentNode: "manual_goal_review",
      attempt: 0,
      heartbeatAt: null,
      lastMessage: "Queued manual epic review.",
      errorText: null
    });
    this.db.enqueueJob("run_epic_review", { epicId, runId });
    this.db.recordEvent({
      aggregateType: "epic",
      aggregateId: epicId,
      runId,
      kind: "epic_manual_review_queued",
      message: "Manual epic review queued."
    });
    return runId;
  }

  async runExisting(runId: string): Promise<void> {
    if (!this.config.useLangGraph) return this.runExistingLegacy(runId);
    const runtime = await loadLangGraphRuntime();
    if (!runtime) return this.runExistingLegacy(runId);
    return this.runExistingWithLangGraph(runId, runtime);
  }

  async runManualReviewExisting(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run || !run.epicId) throw new Error(`Epic run not found: ${runId}`);
    const epic = this.db.getEpic(run.epicId);
    if (!epic) throw new Error(`Epic not found: ${run.epicId}`);
    this.assertNotCancelled(epic.id);

    this.db.updateRun({
      runId,
      status: "running",
      currentNode: "goal_review",
      heartbeatAt: nowIso(),
      lastMessage: "Running manual epic review."
    });
    this.recordAgentStream({
      agentRole: "system",
      source: "orchestrator",
      streamKind: "status",
      content: `Manual epic review requested for ${epic.id}.`,
      runId,
      epicId: epic.id,
      sequence: 0
    });

    const tickets = this.db.listTickets(epic.id);
    const incomplete = tickets.filter((ticket) => ticket.status !== "approved");
    if (incomplete.length) {
      const summary = `Manual epic review blocked: ${incomplete.map((ticket) => `${ticket.id}:${ticket.status}`).join(", ")}`;
      this.recordAgentStream({
        agentRole: "epicReviewer",
        source: "orchestrator",
        streamKind: "assistant",
        content: summary,
        runId,
        epicId: epic.id,
        sequence: 1,
        done: true
      });
      this.db.updateRun({
        runId,
        status: "failed",
        currentNode: "complete",
        heartbeatAt: nowIso(),
        lastMessage: summary,
        errorText: summary
      });
      return;
    }

    const integrityIssues: string[] = [];
    for (const ticket of tickets) {
      if (!ticket.currentRunId) {
        integrityIssues.push(`${ticket.id}:missing currentRunId`);
        continue;
      }
      const ticketRun = this.db.getRun(ticket.currentRunId);
      if (!ticketRun || ticketRun.status !== "succeeded") {
        integrityIssues.push(`${ticket.id}:run ${ticket.currentRunId} not succeeded`);
      }
    }
    if (integrityIssues.length) {
      const summary = `Manual epic review checks failed: ${integrityIssues.join(", ")}`;
      this.recordAgentStream({
        agentRole: "epicReviewer",
        source: "orchestrator",
        streamKind: "assistant",
        content: summary,
        runId,
        epicId: epic.id,
        sequence: 1,
        done: true
      });
      this.db.updateRun({
        runId,
        status: "failed",
        currentNode: "complete",
        heartbeatAt: nowIso(),
        lastMessage: summary,
        errorText: summary
      });
      return;
    }

    const review = await this.withEpicHeartbeat(runId, epic.id, "goal_review", "Reviewing epic.", () =>
      this.runEpicReview(epic, tickets, runId)
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
      kind: "epic_manual_reviewed",
      message: review.summary,
      payload: review as any
    });
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
      const materialized = this.db.transaction(() => this.materializeTickets(epic.id, normalizedPlans));
      if (materialized.reusedCount > 0) {
        this.recordAgentStream({
          agentRole: "system",
          source: "orchestrator",
          streamKind: "status",
          content: `Reused ${materialized.reusedCount} existing ticket(s); created ${materialized.createdCount} new ticket(s).`,
          runId,
          epicId: epic.id,
          sequence: 1
        });
      }
      return {
        ticketIds: materialized.ticketIds,
        decompositionSummary: plan.summary,
        status: "executing"
      } satisfies Partial<GoalGraphState>;
    };

    const executeTickets = async (state: GoalGraphState) => {
      this.assertNotCancelled(epic.id);
      this.db.updateRun({ runId, status: "running", currentNode: "execute_tickets", heartbeatAt: nowIso(), lastMessage: "Executing tickets." });
      this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Found ${state.ticketIds.length} tickets to execute`, runId, epicId: epic.id, sequence: 0 });
      const createdTickets = state.ticketIds.map((ticketId) => this.db.getTicket(ticketId)).filter((t): t is TicketRecord => t !== null);
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
      const review = await this.withEpicHeartbeat(runId, epic.id, "goal_review", "Reviewing epic.", () =>
        this.runEpicReview(epic, tickets, runId)
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
    const materialized = this.db.transaction(() => this.materializeTickets(epic.id, normalizedPlans));
    const createdTickets = materialized.tickets;
    if (materialized.reusedCount > 0) {
      this.recordAgentStream({
        agentRole: "system",
        source: "orchestrator",
        streamKind: "status",
        content: `Reused ${materialized.reusedCount} existing ticket(s); created ${materialized.createdCount} new ticket(s).`,
        runId,
        epicId: epic.id,
        sequence: 1
      });
    }

    for (const ticket of createdTickets.filter((item): item is TicketRecord => item.dependencies.length === 0)) {
      this.assertNotCancelled(epic.id);
      await this.ticketRunner.start(ticket.id, epic.id);
    }

    for (const ticket of createdTickets) {
      this.assertNotCancelled(epic.id);
      let current = this.db.getTicket(ticket.id);
      while (current && (current.status === "queued" || current.status === "building" || current.status === "reviewing" || current.status === "testing")) {
        const queuedRun = this.db.listRuns().find((record) => record.ticketId === ticket.id && (record.status === "queued" || record.status === "running"));
        if (!queuedRun) break;
        if (queuedRun.status === "queued") {
          try {
            await this.ticketRunner.runExisting(queuedRun.id);
          } catch {
            break;
          }
        }
        current = this.db.getTicket(ticket.id);
      }
      for (const dependent of createdTickets.filter((candidate): candidate is TicketRecord => candidate.dependencies.includes(ticket.id))) {
        const depCurrent = this.db.getTicket(dependent.id);
        const depsReady = dependent.dependencies.every((dependencyId) => {
          const depTicket = this.db.getTicket(dependencyId);
          return depTicket?.status === "approved";
        });
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
        payload: { verdict: "failed" }
      });
      return;
    }
    // Note: summaries and ticketPlans are no longer needed as they're generated in runEpicReview
    const review = await this.withEpicHeartbeat(runId, epic.id, "goal_review", "Reviewing epic.", () =>
      this.runEpicReview(epic, tickets, runId)
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
    const ragCtx = await this.buildRagContext(epic.targetDir, `${epic.title} ${epic.goalText}`);

    if (this.gateway.runEpicDecoderInWorkspace && (this.gateway.models.epicDecoder === "codex-cli" || this.gateway.models.epicDecoder === "qwen-cli")) {
      try {
        const via = this.gateway.models.epicDecoder === "qwen-cli" ? "Qwen CLI" : "Codex";
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "status", content: `Decomposing via ${via}...`, runId, epicId: epic.id, sequence: 0 });
        const result = await this.gateway.runEpicDecoderInWorkspace({
          cwd: epic.targetDir,
          prompt: epicDecoderToolingPrompt(epic, ragCtx),
          runId,
          epicId: epic.id,
          onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
        });
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "assistant", content: `Decomposed into ${result.tickets.length} tickets.\nSummary: ${result.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
        return result;
      } catch (err) {
        const details = this.gateway.models.epicDecoder === "qwen-cli" ? formatQwenFailure(err) : formatCodexFailure(err);
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "stderr", content: `${details}. Falling back to Ollama.`, runId, epicId: epic.id, sequence: 0 });
      }
    }
    if (this.gateway.runEpicDecoderOpenCode && this.gateway.models.epicDecoder.startsWith("opencode:")) {
      try {
        this.recordAgentStream({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "status", content: "Decomposing via OpenCode...", runId, epicId: epic.id, sequence: 0 });
        const result = await this.gateway.runEpicDecoderOpenCode({
          cwd: epic.targetDir,
          prompt: epicDecoderToolingPrompt(epic, ragCtx),
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
          prompt: epicDecoderToolingPrompt(epic, ragCtx),
          runId,
          epicId: epic.id,
          ragIndexId: ragCtx?.indexId ?? undefined,
          db: this.db,
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

  private async runEpicReview(epic: EpicRecord, tickets: TicketRecord[], runId: string) {
    const reviewWorkspace = await this.bridge.createWorkspace({
      ticketId: `${epic.id}__EPIC_REVIEW`,
      runId,
      owner: runId,
      targetDir: epic.targetDir
    });
    await this.bridge.acquireWorkspaceLease(reviewWorkspace.id, runId);
    const reviewEpic: EpicRecord = { ...epic, targetDir: reviewWorkspace.worktreePath };
    const ragCtx = await this.buildRagContext(epic.targetDir, `${epic.title} ${epic.goalText}`);
    let cleaned = false;
    const cleanupWorkspace = async () => {
      if (cleaned) return;
      cleaned = true;
      await this.bridge.archiveWorkspace(reviewWorkspace.id);
      this.bridge.releaseLease("workspace", reviewWorkspace.id);
    };
    const finalizeReview = async (review: { verdict: "approved" | "needs_followups" | "failed"; summary: string; followupTickets: GoalTicketPlan[] }) => {
      // Apply reviewer fixes to each ticket's PR branch
      const appliedTickets = await this.applyReviewFixesToTicketBranches(reviewWorkspace.id, tickets);

      if (appliedTickets.size > 0) {
        const ticketList = Array.from(appliedTickets.entries())
          .map(([id, sha]) => `${id}:${sha.slice(0, 7)}`)
          .join(", ");
        this.recordAgentStream({
          agentRole: "epicReviewer",
          source: "orchestrator",
          streamKind: "assistant",
          content: `Epic reviewer applied fixes to ${appliedTickets.size} ticket(s): ${ticketList}`,
          runId,
          epicId: epic.id,
          done: true
        });
        review = { ...review, summary: `${review.summary}\nApplied fixes to ticket PRs: ${ticketList}` };
      }
      await cleanupWorkspace();
      return review;
    };

    try {
    if (this.gateway.models.epicReviewer === "qwen-cli" && this.gateway.runEpicReviewerCodex) {
      try {
        this.recordAgentStream({
          agentRole: "epicReviewer",
          source: "orchestrator",
          streamKind: "status",
          content: "Goal review started via Qwen CLI (forced)...",
          runId,
          epicId: epic.id,
          sequence: 0
        });
        const review = await this.withTimeout(
          this.gateway.runEpicReviewerCodex({
            cwd: reviewEpic.targetDir,
            prompt: epicReviewerCodexPrompt(reviewEpic, tickets, ragCtx),
            runId,
            epicId: epic.id,
            onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
          }),
          this.epicReviewTimeoutMs,
          `Epic reviewer timed out after ${this.epicReviewTimeoutMs}ms`
        );
        this.recordAgentStream({
          agentRole: "epicReviewer",
          source: "orchestrator",
          streamKind: "assistant",
          content: `Verdict: ${review.verdict} - ${review.summary}`,
          runId,
          epicId: epic.id,
          sequence: 1,
          done: true
        });
        return await finalizeReview(review);
      } catch (err) {
        const details = formatQwenFailure(err);
        this.recordAgentStream({
          agentRole: "epicReviewer",
          source: "orchestrator",
          streamKind: "stderr",
          content: `${details}. Retrying with codex path.`,
          runId,
          epicId: epic.id,
          sequence: 0
        });
      }
    }

    if (this.gateway.runEpicReviewerCodex && (this.gateway.models.epicReviewer === "codex-cli" || this.gateway.models.epicReviewer === "qwen-cli")) {
      try {
        const via = this.gateway.models.epicReviewer === "qwen-cli" ? "Qwen CLI" : "Codex";
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "status", content: `Goal review started via ${via}...`, runId, epicId: epic.id, sequence: 0 });
        const review = await this.withTimeout(
          this.gateway.runEpicReviewerCodex({
            cwd: reviewEpic.targetDir,
            prompt: epicReviewerCodexPrompt(reviewEpic, tickets, ragCtx),
            runId,
            epicId: epic.id,
            onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
          }),
          this.epicReviewTimeoutMs,
          `Epic reviewer timed out after ${this.epicReviewTimeoutMs}ms`
        );
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: `Verdict: ${review.verdict} - ${review.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
        return await finalizeReview(review);
      } catch (err) {
        const details = this.gateway.models.epicReviewer === "qwen-cli" ? formatQwenFailure(err) : formatCodexFailure(err);
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "stderr", content: `${details}. Falling back to OpenCode.`, runId, epicId: epic.id, sequence: 0 });
      }
    }
    if (this.gateway.runGoalReviewInWorkspace && !this.gateway.models.epicReviewer.startsWith("mediated:")) {
      try {
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "status", content: "Goal review started via OpenCode...", runId, epicId: epic.id, sequence: 0 });
        const review = await this.withTimeout(
          this.gateway.runGoalReviewInWorkspace({
            cwd: reviewEpic.targetDir,
            prompt: epicReviewerToolingPrompt(reviewEpic, tickets, ragCtx),
            runId,
            epicId: epic.id,
            onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
          }),
          this.epicReviewTimeoutMs,
          `Epic reviewer timed out after ${this.epicReviewTimeoutMs}ms`
        );
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: `Verdict: ${review.verdict} - ${review.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
        return await finalizeReview(review);
      } catch (err) {
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "stderr", content: `${formatOpenCodeFailure(err)}. Falling back to Ollama.`, runId, epicId: epic.id, sequence: 0 });
      }
    }
    if (this.gateway.runGoalReviewInWorkspace && this.gateway.models.epicReviewer.startsWith("mediated:")) {
      try {
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "status", content: "Goal review started via mediated agent harness...", runId, epicId: epic.id, sequence: 0 });
        const review = await this.withTimeout(
          this.gateway.runGoalReviewInWorkspace({
            cwd: reviewEpic.targetDir,
            prompt: epicReviewerToolingPrompt(reviewEpic, tickets, ragCtx),
            runId,
            epicId: epic.id,
            ragIndexId: ragCtx?.indexId ?? undefined,
            db: this.db,
            onStream: (event: AgentStreamPayload) => this.recordAgentStream(event)
          }),
          this.epicReviewTimeoutMs,
          `Epic reviewer timed out after ${this.epicReviewTimeoutMs}ms`
        );
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: `Verdict: ${review.verdict} - ${review.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
        return await finalizeReview(review);
      } catch (err) {
        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "stderr", content: `Mediated harness failed: ${err instanceof Error ? err.message : String(err)}. Falling back to Ollama.`, runId, epicId: epic.id, sequence: 0 });
      }
    }
    this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "status", content: "Goal review started via Ollama...", runId, epicId: epic.id, sequence: 0 });
    const review = await this.withTimeout(
      this.gateway.getGoalReview(epicReviewerPrompt(reviewEpic, tickets)),
      this.epicReviewTimeoutMs,
      `Epic reviewer timed out after ${this.epicReviewTimeoutMs}ms`
    );
    this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: `Verdict: ${review.verdict} - ${review.summary}`, runId, epicId: epic.id, sequence: 1, done: true });
    return await finalizeReview(review);
    } catch (error) {
      await cleanupWorkspace();
      throw error;
    }
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

  static createEpic(db: AppDatabase, input: { id?: string; title: string; goalText: string; targetDir: string; targetBranch?: string }): EpicRecord {
    return db.createEpic({
      id: input.id ?? randomId("epic"),
      title: input.title,
      goalText: input.goalText,
      targetDir: input.targetDir,
      targetBranch: input.targetBranch ?? null,
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

  private async buildRagContext(
    repoPath: string,
    query: string
  ): Promise<{ codeContext: string; docContext: string; indexId: number | null } | null> {
    try {
      const headResult = await git(repoPath, ["rev-parse", "HEAD"]);
      const commitHash = headResult.stdout.trim();
      const ctx = await buildContextForQuery({
        query: query.slice(0, 1000),
        db: this.db,
        repoRoot: repoPath,
        commitHash,
      });
      return { codeContext: ctx.codeContext, docContext: ctx.docContext, indexId: ctx.indexId };
    } catch (err) {
      console.warn(`[RAG] buildRagContext failed: ${err}`);
      return null;
    }
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

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private normalizeCompareRef(remoteBranch: string): string {
    return remoteBranch.replace(/^[^/]+\//, "");
  }

  private async applyReviewFixesToTicketBranches(reviewWorkspaceId: string, tickets: TicketRecord[]): Promise<Map<string, string>> {
    const stagedDiff = await this.bridge.gitDiff(reviewWorkspaceId);
    if (!stagedDiff.trim()) {
      return new Map();
    }

    const reviewWorkspace = this.db.getWorkspace(reviewWorkspaceId);
    if (!reviewWorkspace) {
      throw new Error(`Review workspace not found: ${reviewWorkspaceId}`);
    }

    // Parse diff into per-file changes
    const fileChanges = splitDiffByFile(stagedDiff);
    const ticketChanges = new Map<string, string[]>(); // ticketId -> changed files

    // Map files to tickets based on allowedPaths
    for (const filePath of fileChanges.keys()) {
      for (const ticket of tickets) {
        const matches = ticket.allowedPaths.some(pattern =>
          filePath.startsWith(pattern.replace(/\*$/, ""))
        );
        if (matches) {
          if (!ticketChanges.has(ticket.id)) {
            ticketChanges.set(ticket.id, []);
          }
          ticketChanges.get(ticket.id)!.push(filePath);
        }
      }
    }

    // Apply fixes to each ticket's branch
    const appliedTickets = new Map<string, string>(); // ticketId -> commit SHA

    for (const [ticketId, changedFiles] of ticketChanges.entries()) {
      const ticket = tickets.find(t => t.id === ticketId);
      if (!ticket) continue;

      this.recordAgentStream({
        agentRole: "epicReviewer",
        source: "orchestrator",
        streamKind: "assistant",
        content: `Applying ${changedFiles.length} file(s) to ticket ${ticketId}: ${changedFiles.join(", ")}`,
        epicId: ticket.epicId,
        ticketId: ticketId,
        done: false
      });

      try {
        // Find the ticket's workspace to get the branch name
        const ticketWorkspaces = this.db.listWorkspacesForTicket(ticketId);
        if (ticketWorkspaces.length === 0) {
          this.recordAgentStream({
            agentRole: "epicReviewer",
            source: "orchestrator",
            streamKind: "stderr",
            content: `No workspace found for ticket ${ticketId}, skipping fixes`,
            epicId: ticket.epicId,
            ticketId: ticketId,
            done: false
          });
          continue;
        }

        const ticketWorkspace = ticketWorkspaces[0]; // Get most recent
        const branchName = ticketWorkspace.branchName;

        // Create a temporary worktree for the ticket's branch
        const tempWorktreePath = await this.bridge.createTempWorktreeFromBranch(reviewWorkspace.repoRoot, branchName);
        try {
          // Copy changed files from review workspace to temp worktree
          for (const filePath of changedFiles) {
            const sourceContent = await this.bridge.readFile(reviewWorkspaceId, filePath);
            const targetPath = `${tempWorktreePath}/${filePath}`;

            // Ensure directory exists
            const targetDir = dirname(targetPath);
            await mkdir(targetDir, { recursive: true });

            // Write the file
            await writeFile(targetPath, sourceContent, "utf8");
          }

          // Commit and push changes to the ticket's branch
          const commitSha = await this.bridge.commitAndPushFromPath(tempWorktreePath, branchName, `[epic-review] reviewer fixes for ${ticketId}`);
          appliedTickets.set(ticketId, commitSha);

          this.recordAgentStream({
            agentRole: "epicReviewer",
            source: "orchestrator",
            streamKind: "assistant",
            content: `✓ Pushed fixes to ${ticketId}: ${commitSha.slice(0, 7)}`,
            epicId: ticket.epicId,
            ticketId: ticketId,
            done: false
          });
        } finally {
          // Clean up temporary worktree
          await this.bridge.removeTempWorktree(tempWorktreePath);
        }
      } catch (error) {
        this.recordAgentStream({
          agentRole: "epicReviewer",
          source: "orchestrator",
          streamKind: "stderr",
          content: `Error applying fixes to ${ticketId}: ${error instanceof Error ? error.message : String(error)}`,
          epicId: ticket.epicId,
          ticketId: ticketId,
          done: false
        });
      }
    }

    return appliedTickets;
  }
}

/**
 * Splits a unified diff into per-file patches.
 * Parses `diff --git a/path b/path` boundaries and returns a map of filepath -> patch content.
 */
function splitDiffByFile(diff: string): Map<string, string> {
  const filePatches = new Map<string, string>();
  const lines = diff.split("\n");

  let currentFile = "";
  let currentPatch: string[] = [];

  for (const line of lines) {
    const gitMatch = line.match(/^diff --git a\/(.*) b\//);
    if (gitMatch) {
      // Save previous file's patch
      if (currentFile && currentPatch.length > 0) {
        filePatches.set(currentFile, currentPatch.join("\n"));
      }
      // Start new file
      currentFile = gitMatch[1];
      currentPatch = [line];
    } else if (currentFile) {
      currentPatch.push(line);
    }
  }

  // Save last file's patch
  if (currentFile && currentPatch.length > 0) {
    filePatches.set(currentFile, currentPatch.join("\n"));
  }

  return filePatches;
}

class EpicCancelledError extends Error {}
