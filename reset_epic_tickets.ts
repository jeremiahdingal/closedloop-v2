import { bootstrap } from "./src/apps/bootstrap.ts";

async function main() {
  const { db, goalRunner } = await bootstrap();

  const epicId = "epic_e2b9949987982049";
  
  console.log("Cleaning up existing jobs for this epic...");
  const jobs = db.listJobRecords();
  for (const job of jobs) {
    const payload = (job.payload ?? {}) as any;
    if (payload.epicId === epicId && (job.status === "running" || job.status === "queued")) {
      console.log(`Deleting job ${job.id} (${job.kind})`);
      db.deleteJob(job.id);
    }
  }

  const tickets = db.listTickets(epicId);
  console.log(`Resetting ${tickets.length} tickets for epic ${epicId}...`);

  for (const ticket of tickets) {
    if (ticket.status !== "approved") {
      console.log(`Resetting ticket ${ticket.id} (${ticket.title})`);
      
      // Reset ticket state to queued
      db.updateTicketRunState({
        ticketId: ticket.id,
        status: "queued",
        currentRunId: null,
        currentNode: null,
        lastHeartbeatAt: null,
        lastMessage: "Manual reset for retry."
      });
    }
  }

  // Also reset the epic itself status
  console.log(`Resetting epic ${epicId} status to 'executing'...`);
  db.updateEpicStatus(epicId, "executing");

  // Enqueue fresh epic run
  const runId = await goalRunner.enqueueGoal(epicId);
  console.log(`Enqueued epic run ${runId}`);

  console.log("Done. Please start the worker now.");
  db.close();
  process.exit(0);
}

void main();
