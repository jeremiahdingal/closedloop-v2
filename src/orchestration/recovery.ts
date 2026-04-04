import { AppDatabase } from "../db/database.ts";
import { TicketRunner } from "./ticket-runner.ts";
import { GoalRunner } from "./goal-runner.ts";
import { deterministicDoctor } from "../bridge/doctor.ts";
import { loadConfig } from "../config.ts";
import { nowIso } from "../utils.ts";
import type { AgentStreamPayload } from "../types.ts";

export class RecoveryService {
  readonly config = loadConfig();
  private readonly db: AppDatabase;
  private readonly ticketRunner: TicketRunner;
  private readonly goalRunner: GoalRunner;

  constructor(db: AppDatabase, ticketRunner: TicketRunner, goalRunner: GoalRunner) {
    this.db = db;
    this.ticketRunner = ticketRunner;
    this.goalRunner = goalRunner;
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

  recoverExpiredLeases(): void {
    for (const lease of this.db.listExpiredLeases()) {
      this.db.recordEvent({
        aggregateType: lease.resourceType,
        aggregateId: lease.resourceId,
        kind: "lease_expired",
        message: `Lease expired for ${lease.resourceType}:${lease.resourceId}`,
        payload: { owner: lease.owner }
      });
      this.db.deleteLease(lease.resourceType, lease.resourceId);
    }
  }

  healQueueState(): { recovered: number; failedDuplicates: number } {
    const jobs = this.db.listJobRecords();
    const groups = new Map<string, Array<{ id: string; kind: string; status: string; payload: any }>>();
    for (const job of jobs) {
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      const runId = String(payload.runId ?? "");
      if (!runId) continue;
      const key = `${job.kind}:${runId}`;
      const bucket = groups.get(key) ?? [];
      bucket.push({ id: job.id, kind: job.kind, status: job.status, payload });
      groups.set(key, bucket);
    }

    let recovered = 0;
    let failedDuplicates = 0;

    for (const bucket of groups.values()) {
      const runId = String(bucket[0].payload.runId);
      const run = this.db.getRun(runId);
      const active = bucket
        .filter((job) => job.status === "queued" || job.status === "running")
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!active.length) continue;

      // Terminal or missing run: fail all active jobs.
      if (!run || ["succeeded", "failed", "escalated", "cancelled"].includes(run.status)) {
        for (const job of active) {
          this.db.failJob(job.id, `Recovered orphan job for terminal run ${runId}.`, false);
          failedDuplicates += 1;
        }
        continue;
      }

      // If run is queued, ensure exactly one queued job and clear duplicates.
      if (run.status === "queued") {
        const primary = active[0];
        if (primary.status === "running") {
          this.db.failJob(primary.id, `Recovered stale running job for queued run ${runId}.`, true);
          recovered += 1;
        }
        for (const duplicate of active.slice(1)) {
          this.db.failJob(duplicate.id, `Dropped duplicate job for run ${runId}.`, false);
          failedDuplicates += 1;
        }
        continue;
      }

      // For running/waiting runs, keep one active job and fail extras.
      if (run.status === "running" || run.status === "waiting") {
        for (const duplicate of active.slice(1)) {
          this.db.failJob(duplicate.id, `Dropped duplicate concurrent job for run ${runId}.`, false);
          failedDuplicates += 1;
        }
      }
    }

    return { recovered, failedDuplicates };
  }

  async rerunStaleRuns(
    staleAfterMs = this.config.staleRunAfterMs,
    maxRecoveries = this.config.staleRunMaxRecoveries
  ): Promise<string[]> {
    const threshold = Date.now() - staleAfterMs;
    const staleRunIds: string[] = [];
    for (const run of this.db.listRuns("running")) {
      if (run.epicId && (run.currentNode === "goal_review" || run.currentNode === "manual_goal_review")) {
        continue;
      }
      if (run.epicId && run.currentNode === "execute_tickets") {
        const tickets = this.db.listTickets(run.epicId);
        const allDone = tickets.every(t => t.status === "approved" || t.status === "failed" || t.status === "escalated");
        if (allDone) continue;
      }
      const heartbeat = run.heartbeatAt ? new Date(run.heartbeatAt).getTime() : 0;
      if (heartbeat < threshold) {
        staleRunIds.push(run.id);
        const recentEvents = this.db.listEventsForRun(run.id, 50);
        const streamTexts = recentEvents
          .filter((event) => event.kind === "agent_stream")
          .map((event) => {
            const payload = event.payload as { content?: string } | null;
            return String(payload?.content ?? event.message ?? "");
          });

        const noDiff = streamTexts.some((text) => text.toLowerCase().includes("builder produced no diff"));
        const infraFailure = streamTexts.some((text) => {
          const lower = text.toLowerCase();
          return lower.includes("no tool results in the last 3 calls")
            || lower.includes("reviewer/ollama unavailable")
            || lower.includes("socket hang up")
            || lower.includes("econnrefused")
            || lower.includes("network");
        });

        const repeatedBlockers = streamTexts.some((text) => text.toLowerCase().includes("blocker"));
        const repeatedTestFailure = streamTexts.some((text) => text.toLowerCase().includes("tests failed"));
        const doctor = deterministicDoctor({ repeatedBlockers, repeatedTestFailure, noDiff, infraFailure });

        const ticketLabel = run.ticketId ? `ticket ${run.ticketId}` : `run ${run.id}`;
        if (run.attempt >= maxRecoveries || doctor.decision === "escalate" || doctor.decision === "blocked") {
          const message = run.attempt >= maxRecoveries
            ? `Doctor: ${ticketLabel} stalled at ${run.currentNode ?? "unknown node"} and exceeded recovery budget (${maxRecoveries}).`
            : `Doctor: ${ticketLabel} stalled at ${run.currentNode ?? "unknown node"}; decision: ${doctor.decision}.`;
          this.recordAgentStream({
            agentRole: "doctor",
            source: "orchestrator",
            streamKind: "assistant",
            content: message,
            runId: run.id,
            ticketId: run.ticketId,
            epicId: run.epicId,
            done: true
          });
          this.db.updateRun({
            runId: run.id,
            status: "failed",
            heartbeatAt: nowIso(),
            currentNode: "error",
            lastMessage: message,
            errorText: message
          });
          if (run.ticketId && this.db.getTicket(run.ticketId)) {
            this.db.updateTicketRunState({
              ticketId: run.ticketId,
              status: "failed",
              currentNode: "error",
              lastHeartbeatAt: nowIso(),
              lastMessage: message
            });
          }
          this.db.recordEvent({
            aggregateType: run.ticketId ? "ticket" : "epic",
            aggregateId: run.ticketId ?? run.epicId ?? run.id,
            runId: run.id,
            ticketId: run.ticketId,
            kind: "recovery_exhausted",
            message,
            payload: { node: run.currentNode, attempt: run.attempt, maxRecoveries, doctor }
          });
          continue;
        }

        const requeueMessage = `Doctor rescued ${ticketLabel} at ${run.currentNode ?? "unknown node"} (${doctor.decision}: ${doctor.reason}).`;
        this.recordAgentStream({
          agentRole: "doctor",
          source: "orchestrator",
          streamKind: "assistant",
          content: requeueMessage,
          runId: run.id,
          ticketId: run.ticketId,
          epicId: run.epicId,
          done: true
        });
        this.db.updateRun({
          runId: run.id,
          status: "queued",
          heartbeatAt: nowIso(),
          currentNode: "recovery",
          lastMessage: requeueMessage,
          attempt: run.attempt + 1
        });
        if (run.ticketId) {
          if (this.db.getTicket(run.ticketId)) {
            this.db.updateTicketRunState({
              ticketId: run.ticketId,
              currentNode: "recovery",
              lastHeartbeatAt: nowIso(),
              lastMessage: requeueMessage
            });
          }
          this.db.enqueueJob("run_ticket", { ticketId: run.ticketId, epicId: run.epicId, runId: run.id });
        } else if (run.epicId) {
          this.db.enqueueJob("run_epic", { epicId: run.epicId, runId: run.id });
        }

        this.db.recordEvent({
          aggregateType: run.ticketId ? "ticket" : "epic",
          aggregateId: run.ticketId ?? run.epicId ?? run.id,
          runId: run.id,
          ticketId: run.ticketId,
          kind: "recovery_requeued",
          message: requeueMessage,
          payload: { node: run.currentNode, attempt: run.attempt + 1, maxRecoveries, doctor }
        });
      }
    }
    return staleRunIds;
  }

  async processJob(job: { kind: string; payload: any; id: string }): Promise<void> {
    if (job.kind === "run_ticket") {
      const run = this.db.getRun(String(job.payload.runId));
      if (!run || run.status !== "queued") return;
      await this.ticketRunner.runExisting(run.id);
      return;
    }
    if (job.kind === "run_epic") {
      const run = this.db.getRun(String(job.payload.runId));
      if (!run || run.status !== "queued") return;
      await this.goalRunner.runExisting(run.id);
      return;
    }
    if (job.kind === "run_epic_review") {
      const run = this.db.getRun(String(job.payload.runId));
      if (!run || run.status !== "queued") return;
      await this.goalRunner.runManualReviewExisting(run.id);
      return;
    }
    throw new Error(`Unsupported job kind: ${job.kind}`);
  }
}
