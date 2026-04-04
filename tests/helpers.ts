import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bootstrap } from "../src/apps/bootstrap.ts";
import { AppDatabase } from "../src/db/database.ts";

const execFileAsync = promisify(execFile);

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function initGitRepo(root: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# Test Repo\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
}

export async function bootstrapForTest(env: Record<string, string>, options?: { dryRun?: boolean }) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  const services = await bootstrap(options);
  return {
    ...services,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      services.db.close();
    }
  };
}

export function reopenDatabase(dbPath: string): AppDatabase {
  return new AppDatabase(dbPath);
}
