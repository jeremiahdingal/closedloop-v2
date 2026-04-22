import { execFileSync } from "node:child_process";
import { writeFile, readFile, mkdir, symlink, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { AppDatabase } from "../db/database.ts";
import { randomId, nowIso, sleep } from "../utils.ts";
import { epicDecoderPrompt, epicDecoderToolingPrompt, epicReviewerBuildFixPrompt, epicReviewerDirectCliPrompt } from "./prompts.ts";
import type { ModelGateway } from "./models.ts";
import type { AgentStreamPayload, EpicRecord, GoalDecomposition, GoalReview, GoalTicketPlan, TicketEpicReviewPacket, TicketRecord } from "../types.ts";
import { TicketRunner } from "./ticket-runner.ts";
import { loadConfig } from "../config.ts";
import { loadLangGraphRuntime, type LangGraphRuntime } from "./langgraph-loader.ts";
import { formatOpenCodeFailure } from "./opencode.ts";
import { formatCodexFailure } from "./codex.ts";
import { formatQwenFailure } from "./qwen.ts";
import { LifecycleService } from "./lifecycle.ts";
import { WorkspaceBridge } from "../bridge/workspace-bridge.ts";
import { buildContextForQuery, type BuiltContext } from "../rag/context-builder.ts";
import { git } from "../bridge/git.ts";
import { ensureProjectStructureFile } from "./project-structure.ts";
import { PlayLoopService } from "./play-loop.ts";

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

type EpicReviewerTicketGitContext = {
  ticketId: string;
  baseRef: string | null;
  headRef: string | null;
  allowedPaths: string[];
  branchName: string | null;
  hasWorkspaceChanges: boolean;
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

function plannerIdNeedsExecutionAlias(planId: string): boolean {
  return /^(ANA|ANALYSIS|PLAN|PLN)-\d+$/i.test(planId.trim());
}

function nextExecutionTicketId(epicId: string, existingIds: Iterable<string>): string {
  const used = new Set(existingIds);
  let index = 1;
  while (used.has(`${epicId}__T-${index.toString().padStart(3, "0")}`)) {
    index += 1;
  }
  return `${epicId}__T-${index.toString().padStart(3, "0")}`;
}

function normalizeGoalTicketPlans(epicId: string, tickets: GoalTicketPlan[]): GoalTicketPlan[] {
  const usedIds = new Set<string>();
  const normalized = tickets.map((ticket) => {
    const rawId = String(ticket.id || "").trim();
    const normalizedId = rawId.startsWith(`${epicId}__`)
      ? rawId
      : plannerIdNeedsExecutionAlias(rawId)
        ? nextExecutionTicketId(epicId, usedIds)
        : `${epicId}__${rawId}`;
    usedIds.add(normalizedId);
    return {
      ...ticket,
      id: normalizedId,
      sourceTicketId: rawId,
      allowedPaths: sanitizeAllowedPaths(ticket.allowedPaths)
    };
  });

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

function resolveEpicDiffBase(repoRoot: string, candidateBases: string[]): string | null {
  const uniqueBases = Array.from(new Set(candidateBases.filter(Boolean)));
  if (!uniqueBases.length) return null;
  if (uniqueBases.length === 1) return uniqueBases[0];
  try {
    const mergeBase = execFileSync("git", ["merge-base", "--octopus", ...uniqueBases], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    return mergeBase || null;
  } catch {
    return null;
  }
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
  private readonly playLoop: PlayLoopService;

  constructor(db: AppDatabase, ticketRunner: TicketRunner, gateway: ModelGateway, lifecycle: LifecycleService, bridge?: WorkspaceBridge) {
    this.db = db;
    this.ticketRunner = ticketRunner;
    this.gateway = gateway;
    this.lifecycle = lifecycle;
    this.bridge = bridge ?? new WorkspaceBridge(db);
    this.playLoop = new PlayLoopService(db, this.bridge, gateway, ticketRunner, lifecycle, {
      runEpicDecoder: this.runEpicDecoder.bind(this),
      executeTickets: this.executeTickets.bind(this),
      runEpicReview: this.runEpicReview.bind(this)
    }, this.epicReviewTimeoutMs, this.heartbeatIntervalMs);
  }

  private async executeTickets(epic: EpicRecord, tickets: TicketRecord[], runId: string): Promise<void> {
    this.assertNotCancelled(epic.id);
    this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Executing ${tickets.length} repair tickets`, runId, epicId: epic.id, sequence: 0 });

    const workQueue: TicketRecord[] = [...tickets];

    // Start root tickets (no deps)
    for (const ticket of workQueue.filter((item) => item.dependencies.length === 0)) {
      this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Starting repair ticket: ${ticket.id}`, runId, epicId: epic.id, ticketId: ticket.id, sequence: 1 });
      if (!ticket.currentRunId) await this.ticketRunner.start(ticket.id, epic.id);
    }

    // Execute each ticket
    for (let qi = 0; qi < workQueue.length; qi++) {
      const ticket = workQueue[qi];
      this.assertNotCancelled(epic.id);

      let current = this.db.getTicket(ticket.id);
      while (current && (current.status === "queued" || current.status === "building" || current.status === "reviewing" || current.status === "testing")) {
        const queuedRun = this.db.listRuns().find((record) => record.ticketId === ticket.id && (record.status === "queued" || record.status === "running" || record.status === "waiting"));
        if (!queuedRun) break;
        if (queuedRun.status === "queued") {
          try {
            await this.ticketRunner.runExisting(queuedRun.id);
          } catch {
            break;
          }
        } else {
          await sleep(5000);
        }
        current = this.db.getTicket(ticket.id);
      }

      // Start dependents whose deps are now all approved
      for (const dependent of workQueue.filter((candidate) => candidate.dependencies.includes(ticket.id))) {
        const depCurrent = this.db.getTicket(dependent.id);
        const depsReady = dependent.dependencies.every((dependencyId: string) => {
          const dep = this.db.getTicket(dependencyId);
          return dep?.status === "approved";
        });
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

    this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Repair tickets execution complete`, runId, epicId: epic.id, sequence: 0 });
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
      metadata: { maxBuildAttempts: 3, sourceTicketId: String((ticket as GoalTicketPlan & { sourceTicketId?: string }).sourceTicketId || ticket.id) }
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

    const { StateGraph, StateSchema, START, END, z } = runtime;
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
      console.log(`[LangGraph] Node: decompose_goal, epicId: ${epic.id}`);
      this.assertNotCancelled(epic.id);
      this.db.updateRun({ runId, status: "running", currentNode: "decompose_goal", heartbeatAt: nowIso(), lastMessage: "Decomposing goal." });
      this.db.updateEpicStatus(epic.id, "executing");

      const preApprovedTickets = this.db.listTickets(epic.id);
      if (preApprovedTickets.length > 0) {
        console.log(`[LangGraph] Node: decompose_goal - Using pre-approved plan with ${preApprovedTickets.length} tickets`);
        this.recordAgentStream({
          agentRole: "system",
          source: "orchestrator",
          streamKind: "status",
          content: `Using pre-approved plan: ${preApprovedTickets.length} ticket(s).`,
          runId,
          epicId: epic.id,
          sequence: 1
        });
        return {
          ticketIds: preApprovedTickets.map((t) => t.id),
          decompositionSummary: "Pre-approved plan from Plan Mode."
        } satisfies Partial<GoalGraphState>;
      }

      const plan = await this.withEpicHeartbeat(runId, epic.id, "decompose_goal", "Decomposing goal.", () => this.runEpicDecoder(epic, runId));
      const normalizedPlans = normalizeGoalTicketPlans(epic.id, plan.tickets);
      const materialized = this.db.transaction(() => this.materializeTickets(epic.id, normalizedPlans));
      console.log(`[LangGraph] Node: decompose_goal - Materialized ${materialized.ticketIds.length} tickets`);
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
        decompositionSummary: plan.summary
      } satisfies Partial<GoalGraphState>;
    };

    const executeTickets = async (state: GoalGraphState) => {
      console.log(`[LangGraph] Node: execute_tickets, epicId: ${epic.id}, ticketCount: ${state.ticketIds.length}`);
      this.assertNotCancelled(epic.id);
      this.db.updateRun({ runId, status: "running", currentNode: "execute_tickets", heartbeatAt: nowIso(), lastMessage: "Executing tickets." });
      this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Found ${state.ticketIds.length} tickets to execute`, runId, epicId: epic.id, sequence: 0 });

      return await this.withEpicHeartbeat(runId, epic.id, "execute_tickets", "Executing tickets.", async () => {
        const initialTickets = state.ticketIds.map((ticketId) => this.db.getTicket(ticketId)).filter((t): t is TicketRecord => t !== null);
        const workQueue: TicketRecord[] = [...initialTickets];
        const summaries: string[] = [];

        // Start tickets that are in 'todo' status or have no run yet
        for (const ticket of workQueue) {
          const isReady = ticket.dependencies.length === 0 || ticket.dependencies.every(depId => {
            const dep = this.db.getTicket(depId);
            return dep?.status === "approved";
          });

          if (isReady && (ticket.status === "queued" || !ticket.currentRunId)) {
            this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Starting ticket: ${ticket.id}`, runId, epicId: epic.id, ticketId: ticket.id, sequence: 1 });
            await this.ticketRunner.start(ticket.id, epic.id);
          }
        }

        for (let qi = 0; qi < workQueue.length; qi++) {
          const ticket = workQueue[qi];
          this.assertNotCancelled(epic.id);
          let current = this.db.getTicket(ticket.id);
          while (current && (current.status === "queued" || current.status === "building" || current.status === "reviewing" || current.status === "testing")) {
            const queuedRun = this.db.listRuns().find((record) => record.ticketId === ticket.id && (record.status === "queued" || record.status === "running" || record.status === "waiting"));
            if (!queuedRun) break;
            if (queuedRun.status === "queued") {
              try {
                await this.ticketRunner.runExisting(queuedRun.id);
              } catch {
                break;
              }
            } else {
              await sleep(5000);
            }
            current = this.db.getTicket(ticket.id);
          }

          summaries.push(`${ticket.id}:${current?.status ?? "unknown"}`);

          // Start dependents whose deps are now all approved.
          for (const dependent of workQueue.filter((candidate) => candidate.dependencies.includes(ticket.id))) {
            const depCurrent = this.db.getTicket(dependent.id);
            const depsReady = dependent.dependencies.every((dependencyId: string) => {
              const dep = this.db.getTicket(dependencyId);
              return dep?.status === "approved";
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
        return { ticketSummaries: summaries, status: "reviewing" } satisfies Partial<GoalGraphState>;
      });
    };

    const reviewGoal = async (state: GoalGraphState) => {
      console.log(`[LangGraph] Node: goal_review, epicId: ${epic.id}`);
      this.assertNotCancelled(epic.id);
      this.db.updateRun({ runId, status: "running", currentNode: "goal_review", heartbeatAt: nowIso(), lastMessage: "Reviewing epic." });
      this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Starting goal review with ${state.ticketIds.length} tickets`, runId, epicId: epic.id, sequence: 0 });
      await this.drainActiveTickets(epic.id);
      const tickets = this.db.listTickets(epic.id);
      const incompleteTickets = tickets.filter((ticket) => {
        const isTerminal = ["approved", "failed", "escalated"].includes(ticket.status);
        return !isTerminal;
      });
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
      return {
        reviewVerdict: review.verdict,
        reviewSummary: review.summary,
        status: review.verdict === "approved" ? "done" : "failed"
      } satisfies Partial<GoalGraphState>;
    };

    const finalizeGoal = async (state: GoalGraphState) => {
      const approved = state.reviewVerdict === "approved";
      const failForward = state.reviewVerdict === "needs_followups";
      this.db.updateEpicStatus(epic.id, (approved || failForward) ? "done" : "failed");
      this.db.updateRun({
        runId,
        status: (approved || failForward) ? "succeeded" : "failed",
        currentNode: "complete",
        heartbeatAt: nowIso(),
        lastMessage: state.reviewSummary,
        errorText: (approved || failForward) ? null : state.reviewSummary
      });
      this.db.recordEvent({
        aggregateType: "epic",
        aggregateId: epic.id,
        runId,
        kind: "epic_reviewed",
        message: state.reviewSummary,
        payload: { verdict: state.reviewVerdict, ticketSummaries: state.ticketSummaries }
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

    const graph = graphBuilder.compile();
    try {
      await graph.invoke({ runId, epicId: epic.id });
    } catch (error) {
      if (error instanceof EpicCancelledError) return;
      const msg = error instanceof Error ? error.message : String(error);
      this.db.updateEpicStatus(epic.id, "failed");
      this.db.updateRun({ runId, status: "failed", currentNode: "error", heartbeatAt: nowIso(), lastMessage: msg, errorText: msg });
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
    let legacyFinalized = false;
    try {
      const tickets = this.db.listTickets(epic.id);
      await this.withEpicHeartbeat(runId, epic.id, "execute_tickets", "Executing tickets.", async () => {
        for (const ticket of tickets.filter((item) => item.dependencies.length === 0)) {
          if (!ticket.currentRunId) await this.ticketRunner.start(ticket.id, epic.id);
        }
        for (let qi = 0; qi < tickets.length; qi++) {
          const ticket = tickets[qi];
          let current = this.db.getTicket(ticket.id);
          while (current && (current.status === "queued" || current.status === "building" || current.status === "reviewing" || current.status === "testing")) {
            const activeRun = this.db.listRuns().find(r => r.ticketId === ticket.id && (r.status === "queued" || r.status === "running" || r.status === "waiting"));
            if (!activeRun) break;
            if (activeRun.status === "queued") {
              try { await this.ticketRunner.runExisting(activeRun.id); } catch { break; }
            } else {
              await sleep(5000);
            }
            current = this.db.getTicket(ticket.id);
          }
        }
      });

      await this.drainActiveTickets(epic.id);
      const finalTickets = this.db.listTickets(epic.id);
      const incomplete = finalTickets.filter(t => !["approved", "failed", "escalated"].includes(t.status));
      if (incomplete.length) {
        const summary = `Epic review blocked: ${incomplete.map(t => `${t.id}:${t.status}`).join(", ")}`;
        this.db.updateRun({ runId, status: "failed", currentNode: "complete", heartbeatAt: nowIso(), lastMessage: summary, errorText: summary });
        return;
      }
      const review = await this.withEpicHeartbeat(runId, epic.id, "goal_review", "Reviewing epic.", () => this.runEpicReview(epic, finalTickets, runId));
      legacyFinalized = true;
      const approved = review.verdict === "approved";
      const failForward = review.verdict === "needs_followups";
      this.db.updateEpicStatus(epic.id, (approved || failForward) ? "done" : "failed");
      const runStatus = approved ? "succeeded" : failForward ? "succeeded" : "failed";
      this.db.updateRun({ runId, status: runStatus, currentNode: "complete", heartbeatAt: nowIso(), lastMessage: review.summary, errorText: (approved || failForward) ? null : review.summary });
      this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Epic review ${approved ? "approved" : failForward ? "approved with followups" : "rejected"}: ${review.summary}`, runId, epicId: epic.id, sequence: 3, done: true });
    } catch (error) {
      if (error instanceof EpicCancelledError) return;
      if (!legacyFinalized) {
        const msg = error instanceof Error ? error.message : String(error);
        this.db.updateEpicStatus(epic.id, "failed");
        this.db.updateRun({ runId, status: "failed", currentNode: "error", heartbeatAt: nowIso(), lastMessage: msg, errorText: msg });
      }
      throw error;
    }
  }

  private async drainActiveTickets(epicId: string): Promise<void> {
    const activeStates = new Set(["queued", "building", "reviewing", "testing"]);
    const tickets = this.db.listTickets(epicId);
    for (const ticket of tickets) {
      let current = this.db.getTicket(ticket.id);
      while (current && activeStates.has(current.status)) {
        this.assertNotCancelled(epicId);
        const activeRun = this.db.listRuns().find(r => r.ticketId === ticket.id && (r.status === "queued" || r.status === "running" || r.status === "waiting"));
        if (!activeRun) break;
        if (activeRun.status === "queued") {
          try { await this.ticketRunner.runExisting(activeRun.id); } catch { break; }
        } else {
          await sleep(5000);
        }
        current = this.db.getTicket(ticket.id);
      }
    }
  }

  private async runEpicDecoder(epic: EpicRecord, runId: string): Promise<GoalDecomposition> {
    const ragCtx = await this.buildRagContext(epic.targetDir, `${epic.title} ${epic.goalText}`);
    const projectStructure = await ensureProjectStructureFile(epic.targetDir).catch(() => null);
    if (this.gateway.runEpicDecoderInWorkspace && (this.gateway.models.epicDecoder === "codex-cli" || this.gateway.models.epicDecoder === "qwen-cli" || this.gateway.models.epicDecoder === "gemini-cli")) {
      try {
        const result = await this.gateway.runEpicDecoderInWorkspace({ cwd: epic.targetDir, prompt: epicDecoderToolingPrompt(epic, ragCtx, projectStructure), runId, epicId: epic.id, onStream: (e) => this.recordAgentStream(e) });
        return result;
      } catch (err) { console.warn(`Decoder failed: ${err}`); }
    }
    return this.gateway.getGoalDecomposition(epicDecoderPrompt(epic));
  }

  private async runEpicReview(epic: EpicRecord, tickets: TicketRecord[], runId: string): Promise<GoalReview> {
    this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Starting epic review with ${tickets.length} tickets`, runId, epicId: epic.id, sequence: 0 });

    // ── 1. Collect diffs from each ticket's workspaces (local, no remote fetch) ──
    const ticketGitContext: EpicReviewerTicketGitContext[] = [];
    const candidateBases: string[] = [];
    for (const ticket of tickets) {
      const workspaces = this.db.listWorkspacesForTicket(ticket.id);
      const changedWorkspace = workspaces.find(ws => ws.headCommit && ws.headCommit !== ws.baseCommit);
      const activeWorkspace = workspaces.find(ws => ws.status === "active");
      const fallbackWorkspace = changedWorkspace ?? activeWorkspace ?? workspaces[0] ?? null;

      if (changedWorkspace?.baseCommit) candidateBases.push(changedWorkspace.baseCommit);
      else if (fallbackWorkspace?.baseCommit) candidateBases.push(fallbackWorkspace.baseCommit);

      ticketGitContext.push({
        ticketId: ticket.id,
        baseRef: fallbackWorkspace?.baseCommit ?? null,
        headRef: changedWorkspace?.headCommit ?? null,
        allowedPaths: ticket.allowedPaths,
        branchName: fallbackWorkspace?.branchName ?? null,
        hasWorkspaceChanges: Boolean(activeWorkspace)
      });
    }

    // ── 2. Load review packets for all tickets (especially failing ones) ──
    const diffBase = resolveEpicDiffBase(epic.targetDir, candidateBases);
    const reviewPackets = new Map<string, TicketEpicReviewPacket>();
    for (const ticket of tickets) {
      const packet = await this.loadEpicReviewPacket(ticket.id);
      if (packet) {
        reviewPackets.set(ticket.id, packet);
      }
    }

    // ── 3. Build context ──
    const ragCtx = await this.buildRagContext(epic.targetDir, `${epic.title} ${epic.goalText}`, "epic-reviewer");
    const projectStructure = await ensureProjectStructureFile(epic.targetDir).catch(() => null);

    const useDirectCli = Boolean(this.gateway.runGoalReviewInWorkspace);

    this.recordAgentStream({
      agentRole: "epicReviewer", source: "orchestrator", streamKind: "status",
      content: `Reviewing epic: ${epic.title} (${tickets.length} tickets${diffBase ? `, diff base ${diffBase.slice(0, 10)}` : ""}) via ${useDirectCli ? "direct CLI" : "direct LLM"}`,
      runId, epicId: epic.id, sequence: 1,
    });

    // ── 4. Build the unified prompt with diffs and review packets ──
    const basePrompt = epicReviewerDirectCliPrompt({
      epic,
      tickets,
      ticketGitContext,
      reviewPackets,
      ragContext: ragCtx ?? undefined,
      projectStructure,
      targetBranch: epic.targetBranch,
      diffBase,
    });

    const MAX_RETRIES = 2;
    let lastReview: GoalReview | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const retryPrompt: string = (attempt > 0 && lastReview)
          ? basePrompt + "\n\nPREVIOUS REVIEW ATTEMPT:\n" +
            `Verdict: ${lastReview.verdict}\nSummary: ${lastReview.summary}\n` +
            (lastError ? `Error: ${lastError}\n` : "") +
            "You MUST fix the identified issues directly. If you cannot fix them, return verdict 'needs_followups' with followupTickets."
          : basePrompt;

        if (attempt > 0) {
          this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Review retry attempt ${attempt}/${MAX_RETRIES}. Previous verdict: ${lastReview?.verdict ?? "unknown"}`, runId, epicId: epic.id, sequence: 2 + attempt * 2 });
        }

        // ── 5. Call the reviewer ──
        const review: GoalReview = useDirectCli
          ? await this.gateway.runGoalReviewInWorkspace!({
              cwd: epic.targetDir,
              prompt: retryPrompt,
              runId,
              epicId: epic.id,
              onStream: (event) => this.recordAgentStream(event),
              ragIndexId: ragCtx?.indexId ?? undefined,
              db: this.db,
            })
          : await this.gateway.getGoalReview(retryPrompt);

        lastReview = review;

        if (review.verdict === "approved") {
          this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: review.summary, runId, epicId: epic.id, sequence: 3 + attempt * 2, done: true });
          return review;
        }

        if (attempt < MAX_RETRIES) {
          this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "status", content: `Review found issues (verdict: ${review.verdict}). Retrying with fixes...`, runId, epicId: epic.id, sequence: 4 + attempt * 2 });
          lastError = review.summary;
          continue;
        }

        // Final attempt — push whatever fixes were applied
        if (review.followupTickets && review.followupTickets.length > 0) {
          this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Creating ${review.followupTickets.length} followup tickets to address remaining issues.`, runId, epicId: epic.id, sequence: 3 + MAX_RETRIES * 2 });
          for (const ft of review.followupTickets) {
            this.db.createTicket({
              id: `${epic.id}__${ft.id}`,
              epicId: epic.id,
              title: ft.title,
              description: ft.description,
              acceptanceCriteria: ft.acceptanceCriteria,
              dependencies: ft.dependencies ?? [],
              allowedPaths: ft.allowedPaths ?? [],
              status: "queued",
              priority: ft.priority ?? "medium",
              metadata: {},
              prUrl: null,
            });
          }
        }

        this.recordAgentStream({ agentRole: "epicReviewer", source: "orchestrator", streamKind: "assistant", content: `Review completed after ${attempt + 1} attempts. Verdict: ${review.verdict}. ${review.summary}`, runId, epicId: epic.id, sequence: 4 + MAX_RETRIES * 2, done: true });
        return review;

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Review attempt ${attempt + 1} error: ${msg}`, runId, epicId: epic.id, sequence: 2 + attempt * 2 });
        if (attempt >= MAX_RETRIES) {
          throw err;
        }
      }
    }

    return lastReview ?? { verdict: "failed", summary: lastError ?? "Review failed after all attempts", followupTickets: [] };
  }




  private recordAgentStream(event: AgentStreamPayload): void {
    this.db.recordEvent({ aggregateType: event.ticketId ? "ticket" : "epic", aggregateId: event.ticketId ?? event.epicId ?? event.runId ?? "stream", runId: event.runId ?? null, ticketId: event.ticketId ?? null, kind: "agent_stream", message: `${event.agentRole}:${event.streamKind}`, payload: event as any });
  }

  static createEpic(db: AppDatabase, input: { id?: string; title: string; goalText: string; targetDir: string; targetBranch?: string }): EpicRecord {
    return db.createEpic({ id: input.id ?? randomId("epic"), title: input.title, goalText: input.goalText, targetDir: input.targetDir, targetBranch: input.targetBranch ?? null, status: "planning" });
  }

  private assertNotCancelled(epicId: string): void {
    if (this.lifecycle.isEpicCancelled(epicId)) throw new EpicCancelledError(`Epic ${epicId} cancelled by user.`);
  }

  private async buildRagContext(repoPath: string, query: string, role?: string): Promise<(BuiltContext & { indexId: number | null }) | null> {
    try {
      const headResult = await git(repoPath, ["rev-parse", "HEAD"]);
      const commitHash = headResult.stdout.trim();
      const ctx = await buildContextForQuery({ query: query.slice(0, 1000), db: this.db, repoRoot: repoPath, commitHash });
      return ctx;
    } catch (err) { console.warn(`[RAG] buildRagContext failed: ${err}`); return null; }
  }

  private async withEpicHeartbeat<T>(runId: string, epicId: string, node: string, message: string, task: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      this.db.updateRun({ runId, status: "running", currentNode: node, heartbeatAt: nowIso(), lastMessage: message });
    }, this.heartbeatIntervalMs);
    try { return await task(); } finally { clearInterval(timer); }
  }

  async enqueueManualReview(epicId: string): Promise<string> {
    const runId = randomId("run");
    this.db.createRun({
      id: runId,
      kind: "epic_review",
      epicId,
      ticketId: null,
      status: "queued",
      currentNode: "queued",
      attempt: 0,
      heartbeatAt: null,
      lastMessage: "Queued epic review.",
      errorText: null
    });
    this.db.enqueueJob("run_epic_review", { epicId, runId });
    this.db.recordEvent({
      aggregateType: "epic",
      aggregateId: epicId,
      runId,
      kind: "epic_review_queued",
      message: "Epic review run queued."
    });
    return runId;
  }

  async enqueueManualPlayLoop(epicId: string): Promise<string> {
    const runId = randomId("run");
    this.db.createRun({
      id: runId,
      kind: "epic_play_loop",
      epicId,
      ticketId: null,
      status: "queued",
      currentNode: "queued",
      attempt: 0,
      heartbeatAt: null,
      lastMessage: "Queued play loop.",
      errorText: null
    });
    this.db.enqueueJob("run_epic_play_loop", { epicId, runId });
    this.db.recordEvent({
      aggregateType: "epic",
      aggregateId: epicId,
      runId,
      kind: "play_loop_queued",
      message: "Play loop run queued."
    });
    return runId;
  }

  async runManualReviewExisting(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run || !run.epicId) throw new Error(`Review run not found: ${runId}`);
    const epic = this.db.getEpic(run.epicId);
    if (!epic) throw new Error(`Epic not found: ${run.epicId}`);
    this.assertNotCancelled(epic.id);

    this.db.updateRun({ runId, status: "running", currentNode: "goal_review", heartbeatAt: nowIso(), lastMessage: "Running epic review." });

    try {
      const tickets = this.db.listTickets(epic.id);
      const review = await this.withEpicHeartbeat(runId, epic.id, "goal_review", "Reviewing epic.", () =>
        this.runEpicReview(epic, tickets, runId)
      );
      const approved = review.verdict === "approved";
      const failForward = review.verdict === "needs_followups";
      this.db.updateEpicStatus(epic.id, (approved || failForward) ? "done" : "failed");
      const runStatus = approved ? "succeeded" : failForward ? "succeeded" : "failed";
      this.db.updateRun({ runId, status: runStatus, currentNode: "complete", heartbeatAt: nowIso(), lastMessage: review.summary, errorText: (approved || failForward) ? null : review.summary });
      this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Epic review ${approved ? "approved" : failForward ? "approved with followups" : "rejected"}: ${review.summary}`, runId, epicId: epic.id, sequence: 3, done: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.db.updateRun({ runId, status: "failed", currentNode: "error", heartbeatAt: nowIso(), lastMessage: msg, errorText: msg });
      throw error;
    }
  }

  async runManualPlayLoopExisting(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run || !run.epicId) throw new Error(`Play loop run not found: ${runId}`);
    const epic = this.db.getEpic(run.epicId);
    if (!epic) throw new Error(`Epic not found: ${run.epicId}`);
    this.assertNotCancelled(epic.id);

    this.db.updateRun({ runId, status: "running", currentNode: "play_loop", heartbeatAt: nowIso(), lastMessage: "Running play loop." });

    try {
      const tickets = this.db.listTickets(epic.id);
      const playSuccess = await this.playLoop.runPlayLoop(epic, tickets, runId);
      this.db.updateRun({ runId, status: playSuccess ? "succeeded" : "failed", currentNode: "complete", heartbeatAt: nowIso(), lastMessage: playSuccess ? "Play loop completed." : "Play loop had failures." });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.db.updateRun({ runId, status: "failed", currentNode: "error", heartbeatAt: nowIso(), lastMessage: msg, errorText: msg });
      throw error;
    }
  }

  async approveFromPlan(epicId: string, plan: GoalDecomposition): Promise<string> {
    const epic = this.db.getEpic(epicId);
    if (!epic) throw new Error(`Epic not found: ${epicId}`);

    // Materialize plan tickets and update epic status
    this.db.updateEpicStatus(epicId, "executing");
    const normalizedPlans = normalizeGoalTicketPlans(epicId, plan.tickets);
    this.db.transaction(() => this.materializeTickets(epicId, normalizedPlans));

    // Enqueue a normal epic run (which will find the pre-materialized tickets)
    return this.enqueueGoal(epicId);
  }

  private normalizeCompareRef(remoteBranch: string): string { return remoteBranch.replace(/^[^/]+\//, ""); }

  private async loadEpicReviewPacket(ticketId: string): Promise<TicketEpicReviewPacket | null> {
    try {
      const artifacts = this.db.listArtifacts(ticketId);
      const packetArtifact = artifacts.find(a => a.kind === "epic_review_packet");
      if (!packetArtifact) return null;
      const content = await readFile(packetArtifact.path as string, "utf8");
      return JSON.parse(content);
    } catch { return null; }
  }
}

class EpicCancelledError extends Error {}
