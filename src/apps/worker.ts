import { bootstrap } from "./bootstrap.ts";
import { sleep } from "../utils.ts";

async function main() {
  const { config, db, recovery } = await bootstrap();
  console.log(`Worker started. dryRun=${config.dryRun} useLangGraph=${config.useLangGraph}`);
  for (;;) {
    recovery.recoverExpiredLeases();
    await recovery.rerunStaleRuns();

    const job = db.nextQueuedJob();
    if (!job) {
      await sleep(config.workerPollMs);
      continue;
    }

    try {
      await recovery.processJob(job);
      db.completeJob(job.id);
    } catch (error) {
      db.failJob(job.id, (error as Error).message, false);
      console.error(`Job ${job.id} failed:`, error);
    }
  }
}

void main();
