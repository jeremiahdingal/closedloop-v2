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
    console.log(`Created temp repo at: ${tempRepo}`);
  }
}

async function main() {
  await ensureDemoRepo(process.env.REPO_ROOT || process.cwd());
  process.env.TEST_COMMAND ||= "node --eval \"process.exit(0)\"";
  process.env.LINT_COMMAND ||= "node --eval \"process.exit(0)\"";
  process.env.TYPECHECK_COMMAND ||= "node --eval \"process.exit(0)\"";

  const { db, goalRunner } = await bootstrap({ dryRun: false });
  
  const epic = GoalRunner.createEpic(db, {
    title: "Hello JSON File Creation",
    goalText: "Create a simple hello.json file in the workspace root and write the contents of package.json into it. This is a straightforward file copy operation - read package.json and write its contents to hello.json.",
    targetDir: process.env.REPO_ROOT || process.cwd()
  });
  
  const runId = await goalRunner.enqueueGoal(epic.id);

  console.log("\n" + "=".repeat(60));
  console.log("TEST EPIC CREATED");
  console.log("=".repeat(60));
  console.log(JSON.stringify({
    epicId: epic.id,
    runId,
    title: epic.title,
    goalText: epic.goalText,
    targetDir: epic.targetDir
  }, null, 2));
  console.log("=".repeat(60));
  console.log("\nTo run the epic:");
  console.log(`  npm run worker`);
  console.log("\nMonitor progress:");
  console.log(`  Check data/ directory for artifacts and logs`);
  console.log("=".repeat(60) + "\n");

  db.close();
  process.exit(0);
}

void main();
