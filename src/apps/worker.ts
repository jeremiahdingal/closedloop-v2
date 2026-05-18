import { bootstrap } from "./bootstrap.ts";
import { sleep } from "../utils.ts";

async function main() {
  const { config, db, bridge, recovery } = await bootstrap();
  const concurrency = config.workerConcurrency;
  console.log(`Worker started. dryRun=${config.dryRun} useLangGraph=${config.useLangGraph} concurrency=${concurrency}`);

  async function runJob(job: { id: string; kind: string; payload: unknown; attempts: number }) {
    try {
      await recovery.processJob(job);
      db.completeJob(job.id);
    } catch (error) {
      db.failJob(job.id, (error as Error).message, false);
      console.error(`Job ${job.id} failed:`, error);
    }
  }

  for (;;) {
    recovery.recoverExpiredLeases();
    recovery.healQueueState();
    await recovery.rerunStaleRuns(config.staleRunAfterMs, config.staleRunMaxRecoveries);
    await recovery.rescueQueuedTicketStalls();
    await bridge.cleanupArchivedWorkspaces();

    // Only pick up new jobs if we have capacity (count running jobs from DB)
    const runningJobs = (db as any).listJobRecords?.()?.filter?.((j: any) => j.status === 'running')?.length ?? 0;
    const capacity = Math.max(0, concurrency - runningJobs);
    let jobs = capacity > 0 ? db.nextQueuedJobs(capacity) : [];

    // If nothing to run, aggressively ensure queued tickets have jobs
    if (jobs.length === 0 && capacity > 0) {
      await ensureQueuedTicketsHaveJobs(db, recovery);
      await startDueScheduledEpics(db, recovery);
      // Re-check after ensuring
      jobs = db.nextQueuedJobs(capacity);
    }

    if (jobs.length === 0) {
      await sleep(config.workerPollMs);
      continue;
    }

    await Promise.all(jobs.map(runJob));
  }
}

async function ensureQueuedTicketsHaveJobs(db: any, recovery: any): Promise<void> {
  const tickets = db.listTickets();
  for (const ticket of tickets) {
    if (ticket.status !== "queued") continue;
    if (!ticket.epicId) continue;
    const epic = db.getEpic(ticket.epicId);
    if (!epic || epic.status === "cancelled") continue;

    // Gate: don't start tickets if the epic is scheduled for a future date
    if (epic.scheduledDate) {
      const today = new Date().toISOString().slice(0, 10);
      if (today < epic.scheduledDate) continue;
    }

    // Check dependencies
    const supersededIds = new Set(
      db.listTickets(ticket.epicId)
        .map((t: any) => t.metadata?.originalTicketId)
        .filter(Boolean)
    );
    const depsReady = ticket.dependencies.every((depId: string) => {
      const dep = db.getTicket(depId);
      return dep?.status === "approved" || supersededIds.has(depId);
    });
    if (!depsReady) continue;

    const runs = db.listRunsForTicket(ticket.id);

    // Find any active (non-terminal) run
    const activeRun = runs.find((r: any) =>
      r.status === "queued" || r.status === "running" || r.status === "waiting"
    );

    if (activeRun) {
      // Check if there's a job for it
      const hasJob = db.listJobRecords().some((j: any) => {
        if (j.kind !== "run_ticket") return false;
        if (j.status !== "queued" && j.status !== "running") return false;
        return String((j.payload ?? {}).runId ?? "") === activeRun.id;
      });

      if (!hasJob) {
        // Stale "running" run with no job — mark failed and start fresh
        if (activeRun.status === "running") {
          console.log(`[WORKER] Zombied run ${activeRun.id} for ${ticket.id} — failing and restarting`);
          db.updateRun({
            runId: activeRun.id,
            status: "failed",
            currentNode: "error",
            errorText: "Zombied run with no active job",
            lastMessage: "Worker detected zombie run."
          });
        } else {
          // Queued run with no job — create the missing job
          console.log(`[WORKER] Re-enqueueing missing job for queued run ${activeRun.id} (${ticket.id})`);
          db.enqueueJob("run_ticket", { ticketId: ticket.id, epicId: ticket.epicId, runId: activeRun.id });
          db.recordEvent({
            aggregateType: "ticket",
            aggregateId: ticket.id,
            runId: activeRun.id,
            ticketId: ticket.id,
            kind: "worker_auto_start",
            message: "Worker auto-started queued ticket with missing job."
          });
          continue;
        }
      } else {
        continue; // Has a job, will be picked up
      }
    }

    // No active run at all — start fresh
    console.log(`[WORKER] Auto-starting queued ticket ${ticket.id} (no active run)`);
    const ticketRunner = recovery.ticketRunner;
    if (!ticketRunner) continue;

    const runId = await ticketRunner.start(ticket.id, ticket.epicId);
    db.updateTicketRunState({
      ticketId: ticket.id,
      status: "queued",
      currentRunId: runId,
      currentNode: "queued",
      lastHeartbeatAt: new Date().toISOString(),
      lastMessage: "Worker auto-started queued ticket."
    });
    db.recordEvent({
      aggregateType: "ticket",
      aggregateId: ticket.id,
      runId,
      ticketId: ticket.id,
      kind: "worker_auto_start",
      message: "Worker auto-started queued ticket with fresh run."
    });
  }
}

async function startDueScheduledEpics(db: any, recovery: any): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const epics = db.listEpics();
  const goalRunner = recovery.goalRunner;
  if (!goalRunner) return;
  for (const epic of epics) {
    if (epic.status !== "planning") continue;
    if (!epic.scheduledDate) continue;
    if (today < epic.scheduledDate) continue;
    console.log(`[WORKER] Starting scheduled epic ${epic.id} (due ${epic.scheduledDate})`);
    try {
      await goalRunner.enqueueGoal(epic.id);
    } catch (err) {
      console.warn(`[WORKER] Failed to start scheduled epic ${epic.id}:`, (err as Error).message);
    }
  }
}

void main();
