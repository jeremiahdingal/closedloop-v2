import { bootstrap } from "./bootstrap.ts";

async function main() {
  const epicId = "epic_3f06ca7862494f7d";
  const { db, goalRunner } = await bootstrap();
  
  console.log(`Invoking manual review for epic: ${epicId}`);
  
  const epic = db.getEpic(epicId);
  if (!epic) {
    console.error("Epic not found");
    process.exit(1);
  }

  // Update status so it's not "failed" while we review
  db.updateEpicStatus(epicId, "executing");
  
  const runId = await goalRunner.enqueueManualReview(epicId);
  console.log(`Review job enqueued. Run ID: ${runId}`);
  
  db.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
