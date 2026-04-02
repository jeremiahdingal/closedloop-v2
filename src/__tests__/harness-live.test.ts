import { MediatedAgentHarness } from "../mediated-agent-harness/index.ts";
import type { ToolExecutionContext } from "../mediated-agent-harness/types.ts";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CWD = process.cwd();
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MODEL = process.argv[2] || "qwen2.5-coder:14b";
const TASK = process.argv[3] || "List the top-level files and directories in this project, then read package.json and summarize what this project does. Call finish with your summary.";

const toolContext: ToolExecutionContext = {
  cwd: CWD,
  workspaceId: "test-run",
  allowedPaths: ["*"],
  braveApiKey: process.env.BRAVE_API_KEY,
  readFiles: async (paths) => {
    const result: Record<string, string> = {};
    for (const p of paths) {
      try {
        result[p] = await readFile(path.join(CWD, p), "utf-8");
      } catch {}
    }
    return result;
  },
  writeFiles: async (files) => {
    for (const f of files) {
      const fullPath = path.join(CWD, f.path);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, f.content, "utf-8");
    }
  },
  gitDiff: async () => {
    try {
      const { stdout } = await execFileAsync("git", ["diff"], { cwd: CWD, timeout: 10000 });
      return stdout;
    } catch { return ""; }
  },
  gitStatus: async () => {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: CWD, timeout: 10000 });
      return stdout;
    } catch { return ""; }
  },
  runNamedCommand: async (name) => {
    const commands: Record<string, string> = {
      status: "git status --short",
      test: "npm test -- --runInBand",
      lint: "npm run lint",
      typecheck: "npx tsc --noEmit",
    };
    const command = commands[name];
    if (!command) return { stdout: "", stderr: `Unknown command: ${name}`, exitCode: 1 };
    try {
      const { stdout, stderr } = await execFileAsync(command, [], { cwd: CWD, shell: true, timeout: 120_000 });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: any) {
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(err), exitCode: err.code ?? 1 };
    }
  },
  saveArtifact: async (opts) => {
    const dir = path.join(CWD, "data", "artifacts", "test-run");
    await mkdir(dir, { recursive: true });
    const artifactPath = path.join(dir, `${opts.name}.txt`);
    await writeFile(artifactPath, opts.content, "utf-8");
    return artifactPath;
  },
};

console.log(`\n=== Mediated Agent Harness Test ===`);
console.log(`Model: ${MODEL}`);
console.log(`CWD: ${CWD}`);
console.log(`Task: ${TASK.slice(0, 80)}...`);
console.log(`Ollama: ${OLLAMA_BASE}\n`);

const harness = new MediatedAgentHarness({
  baseURL: `${OLLAMA_BASE}/v1`,
  apiKey: "ollama",
  model: MODEL,
  braveApiKey: process.env.BRAVE_API_KEY,
  toolContext,
});

const startTime = Date.now();

try {
  const result = await harness.runWithPrompt(
    "You are a code analysis agent. Explore the codebase using tools and answer the user's question precisely. Always call the finish tool with your answer.",
    TASK,
    {
    maxIterations: 15,
    timeoutMs: 300_000,
    onEvent: (event) => {
      switch (event.kind) {
        case "thinking":
          process.stdout.write(`\x1b[36m[thinking] ${event.text.slice(0, 200)}\x1b[0m\n`);
          break;
        case "text":
          process.stdout.write(`\x1b[33m[text] ${event.text.slice(0, 300)}\x1b[0m\n`);
          break;
        case "tool_call":
          process.stdout.write(`\x1b[32m[tool] ${event.call.name}(${JSON.stringify(event.call.args).slice(0, 100)})\x1b[0m\n`);
          break;
        case "tool_result":
          process.stdout.write(`\x1b[32m  -> ${event.result.output.slice(0, 150)}\x1b[0m\n`);
          break;
        case "tool_error":
          process.stdout.write(`\x1b[31m  ERROR: ${event.error}\x1b[0m\n`);
          break;
        case "complete":
          process.stdout.write(`\x1b[35m[done] ${event.iterations} iterations\x1b[0m\n`);
          break;
        case "error":
          process.stdout.write(`\x1b[31m[error] ${event.error}\x1b[0m\n`);
          break;
      }
    },
  });

  const elapsed = Date.now() - startTime;
  console.log(`\n=== Result (${elapsed}ms, ${result.iterations} iterations) ===`);
  console.log(`Tool calls: ${result.toolCalls.map(t => t.name).join(", ")}`);
  console.log(`\n--- Final Output ---`);
  console.log(result.text);
} catch (err: any) {
  const elapsed = Date.now() - startTime;
  console.error(`\n=== Failed (${elapsed}ms) ===`);
  console.error(`${err.name}: ${err.message}`);
  process.exit(1);
}
