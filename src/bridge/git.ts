import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}
