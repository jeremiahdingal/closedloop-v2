import { bootstrap } from "./bootstrap.ts";
import { GoalRunner } from "../orchestration/goal-runner.ts";

async function main() {
  const { db, goalRunner } = await bootstrap({ dryRun: true });
  const epic = GoalRunner.createEpic(db, {
    title: "Demo epic",
    goalText: "Demonstrate production-ready orchestration backend."
  });
  const runId = await goalRunner.enqueueGoal(epic.id);
  console.log(JSON.stringify({ epicId: epic.id, runId }, null, 2));
  db.close();
  process.exit(0);
}

void main();
