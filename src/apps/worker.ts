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

    const jobs = db.nextQueuedJobs(concurrency);
    if (jobs.length === 0) {
      await sleep(config.workerPollMs);
      continue;
    }

    await Promise.all(jobs.map(runJob));
  }
}

void main();
