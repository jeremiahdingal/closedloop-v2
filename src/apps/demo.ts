
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bootstrap } from "./bootstrap.ts";
import { GoalRunner } from "../orchestration/goal-runner.ts";

const execFileAsync = promisify(execFile);

async function ensureDemoRepo(repoRoot: string): Promise<void> {
  try {
    await stat(path.join(repoRoot, ".git"));
    return;
  } catch {
    const tempRepo = await mkdtemp(path.join(os.tmpdir(), "workflow-demo-"));
    process.env.REPO_ROOT = tempRepo;
    await execFileAsync("git", ["init"], { cwd: tempRepo });
    await execFileAsync("git", ["config", "user.email", "demo@example.com"], { cwd: tempRepo });
    await execFileAsync("git", ["config", "user.name", "Demo User"], { cwd: tempRepo });
    await writeFile(path.join(tempRepo, "README.md"), "# Demo Repo\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: tempRepo });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: tempRepo });
  }
}

async function main() {
  await ensureDemoRepo(process.env.REPO_ROOT || process.cwd());
  process.env.TEST_COMMAND ||= "node --eval \"process.exit(0)\"";
  process.env.LINT_COMMAND ||= "node --eval \"process.exit(0)\"";
  process.env.TYPECHECK_COMMAND ||= "node --eval \"process.exit(0)\"";

  const { db, goalRunner } = await bootstrap({ dryRun: true });
  const epic = GoalRunner.createEpic(db, {
    title: "Demo epic",
    goalText: "Create a dry-run decomposition and queue the work."
  });
  const runId = await goalRunner.enqueueGoal(epic.id);

  console.log(JSON.stringify({
    message: "Demo epic queued. Start the worker to execute it.",
    epicId: epic.id,
    runId,
    epics: db.listEpics(),
    jobs: db.listJobs()
  }, null, 2));

  db.close();
  process.exit(0);
}

void main();
