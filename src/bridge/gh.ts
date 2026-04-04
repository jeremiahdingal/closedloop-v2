import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gh(cwd: string, args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("gh", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}