import { AppDatabase } from "../db/database.ts";
import { TicketRunner } from "./ticket-runner.ts";
import { GoalRunner } from "./goal-runner.ts";
import { nowIso } from "../utils.ts";

export class RecoveryService {
  private readonly db: AppDatabase;
  private readonly ticketRunner: TicketRunner;
  private readonly goalRunner: GoalRunner;

  constructor(db: AppDatabase, ticketRunner: TicketRunner, goalRunner: GoalRunner) {
    this.db = db;
    this.ticketRunner = ticketRunner;
    this.goalRunner = goalRunner;
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

  async rerunStaleRuns(staleAfterMs = 120_000): Promise<string[]> {
    const threshold = Date.now() - staleAfterMs;
    const staleRunIds: string[] = [];
    for (const run of this.db.listRuns("running")) {
      const heartbeat = run.heartbeatAt ? new Date(run.heartbeatAt).getTime() : 0;
      if (heartbeat < threshold) {
        staleRunIds.push(run.id);
        this.db.updateRun({
          runId: run.id,
          status: "queued",
          heartbeatAt: nowIso(),
          currentNode: "recovery",
          lastMessage: "Recovered stale run and requeued."
        });
        if (run.ticketId) {
          this.db.enqueueJob("run_ticket", { ticketId: run.ticketId, epicId: run.epicId, runId: run.id });
        } else if (run.epicId) {
          this.db.enqueueJob("run_epic", { epicId: run.epicId, runId: run.id });
        }
      }
    }
    return staleRunIds;
  }

  async processJob(job: { kind: string; payload: any; id: string }): Promise<void> {
    if (job.kind === "run_ticket") {
      await this.ticketRunner.runExisting(String(job.payload.runId));
      return;
    }
    if (job.kind === "run_epic") {
      await this.goalRunner.runExisting(String(job.payload.runId));
      return;
    }
    throw new Error(`Unsupported job kind: ${job.kind}`);
  }
}
