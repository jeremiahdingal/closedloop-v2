import { MediatedAgentHarness } from "../mediated-agent-harness/index.ts";
import type { ToolExecutionContext } from "../mediated-agent-harness/types.ts";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MODEL = process.argv[2] || "qwen3.6:27b";

function color(code: number, value: string): string {
  return `\x1b[${code}m${value}\x1b[0m`;
}

async function buildCoderWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "coder-smoke-"));

  // package.json
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "coder-smoke-test",
    private: true,
    version: "1.0.0",
    description: "Coder smoke test workspace",
    scripts: { test: "echo ok", status: "echo status-ok" }
  }, null, 2) + "\n", "utf8");

  // src/greet.ts
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "greet.ts"), [
    'export function greet(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '',
    'export function farewell(name: string): string {',
    '  return `Goodbye, ${name}!`;',
    '}',
    '',
  ].join("\n"), "utf8");

  // src/math.ts
  await writeFile(path.join(workspace, "src", "math.ts"), [
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'export function multiply(a: number, b: number): number {',
    '  return a * b;',
    '}',
    '',
    'export const VERSION = "1.0.0";',
    '',
  ].join("\n"), "utf8");

  // src/utils.ts
  await mkdir(path.join(workspace, "src", "helpers"), { recursive: true });
  await writeFile(path.join(workspace, "src", "helpers", "utils.ts"), [
    'export function capitalize(s: string): string {',
    '  return s.charAt(0).toUpperCase() + s.slice(1);',
    '}',
    '',
  ].join("\n"), "utf8");

  // .orchestrator context
  await mkdir(path.join(workspace, ".orchestrator"), { recursive: true });
  await writeFile(path.join(workspace, ".orchestrator", "context.json"), JSON.stringify({
    epicId: "epic_coder_smoke",
    ticketId: "ticket_coder_smoke",
    runId: "run_coder_smoke",
    title: "Coder smoke test: exercise all tools",
    description: "A smoke test that exercises every coder tool.",
    acceptanceCriteria: [
      "src/greet.ts updated with farewell changed to say 'See you later'",
      "src/math.ts unchanged",
      "src/helpers/utils.ts unchanged",
      "src/summary.ts created with exported summary()",
      "src/constants.ts and src/helpers/types.ts created via write_files",
      "hello.json created as a copy of package.json"
    ],
    allowedPaths: ["src/**", "hello.json"],
    attempt: 1
  }, null, 2) + "\n", "utf8");

  // git init
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Coder Smoke"], { cwd: workspace });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: workspace });

  return workspace;
}

const TASK = [
  "Complete ALL of the following steps IN ORDER. You must use a different tool for each step.",
  "",
  "Step 1: Use list_dir to see the workspace root.",
  "Step 2: Use glob_files with pattern 'src/**/*.ts' to find all TypeScript files.",
  "Step 3: Use grep_files with pattern 'farewell' to find where the farewell function is.",
  "Step 4: Use read_file to read src/greet.ts.",
  "Step 5: Use read_files to read ['src/math.ts', 'src/helpers/utils.ts'] in one call.",
  "Step 6: Use search_replace on src/greet.ts to change 'Goodbye' to 'See you later'.",
  "Step 7: Use write_file to create src/summary.ts with a function: export function summary(): string { return 'smoke test done'; }",
  "Step 8: Use write_files to create TWO files at once: src/constants.ts with content 'export const APP_NAME = \"coder-smoke\";\n' and src/helpers/types.ts with content 'export type Result = { ok: boolean; };\n'.",
  "Step 9: Use write_file to create hello.json with the exact content of package.json (which you already read).",
  "Step 10: Call finish with a JSON result containing filesChanged listing all files you created or modified.",
  "",
  "CRITICAL: You must use EACH of these tools at least once: list_dir, glob_files, grep_files, read_file, read_files, search_replace, write_file, write_files, finish.",
].join("\n");

async function main(): Promise<void> {
  const workspace = await buildCoderWorkspace();
  const toolContext: ToolExecutionContext = {
    cwd: workspace,
    workspaceId: "coder-smoke",
    allowedPaths: ["*"],
    braveApiKey: process.env.BRAVE_API_KEY,
    readFiles: async (paths) => {
      const result: Record<string, string> = {};
      for (const file of paths) {
        try {
          result[file] = await readFile(path.join(workspace, file), "utf8");
        } catch {}
      }
      return result;
    },
    writeFiles: async (files) => {
      for (const file of files) {
        const fullPath = path.join(workspace, file.path);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, file.content, "utf8");
      }
    },
    gitDiff: async () => {
      try {
        const { stdout } = await execFileAsync("git", ["diff"], { cwd: workspace, timeout: 10000 });
        return stdout;
      } catch {
        return "";
      }
    },
    gitStatus: async () => {
      try {
        const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: workspace, timeout: 10000 });
        return stdout;
      } catch {
        return "";
      }
    },
    runNamedCommand: async (name) => {
      if (name !== "status") return { stdout: "", stderr: `Unknown command: ${name}`, exitCode: 1 };
      try {
        const { stdout, stderr } = await execFileAsync("git", ["status", "--short"], { cwd: workspace, timeout: 10000 });
        return { stdout, stderr, exitCode: 0 };
      } catch (error: any) {
        return { stdout: error.stdout ?? "", stderr: error.stderr ?? String(error), exitCode: error.code ?? 1 };
      }
    },
    saveArtifact: async (opts) => {
      const dir = path.join(workspace, "artifacts");
      await mkdir(dir, { recursive: true });
      const artifactPath = path.join(dir, `${opts.name}.txt`);
      await writeFile(artifactPath, opts.content, "utf8");
      return artifactPath;
    },
    readArtifact: async (opts) => {
      const dir = path.join(workspace, "artifacts");
      const fileName = opts.name ? `${opts.name}.txt` : undefined;
      if (!fileName) return null;
      try {
        return await readFile(path.join(dir, fileName), "utf8");
      } catch {
        return null;
      }
    },
    getAvailableCommands: () => ["status"]
  };

  const harness = new MediatedAgentHarness({
    baseURL: `${OLLAMA_BASE}/v1`,
    apiKey: "ollama",
    model: MODEL,
    braveApiKey: process.env.BRAVE_API_KEY,
    toolContext
  });

  console.log(color(36, "=== Coder Smoke Test (all tools) ==="));
  console.log(`model: ${MODEL}`);
  console.log(`workspace: ${workspace}`);
  console.log("");

  const toolCallsSeen: string[] = [];
  const start = Date.now();

  const result = await harness.run("coder", TASK, {
    maxIterations: 18,
    timeoutMs: 600_000,
    temperature: 1.0,
    topP: 0.95,
    topK: 64,
    onEvent: (event) => {
      if (event.kind === "thinking") console.log(color(36, `[thinking] ${event.text.slice(0, 200)}`));
      if (event.kind === "text") console.log(color(33, `[text] ${event.text.slice(0, 300)}`));
      if (event.kind === "tool_call") {
        toolCallsSeen.push(event.call.name);
        console.log(color(32, `[tool] ${event.call.name} ${JSON.stringify(event.call.args).slice(0, 200)}`));
      }
      if (event.kind === "tool_result") console.log(color(32, `[tool-result] ${event.result.output.slice(0, 200)}`));
      if (event.kind === "tool_error") console.log(color(31, `[tool-error] ${event.error}`));
      if (event.kind === "complete") console.log(color(35, `[complete] iterations=${event.iterations}`));
      if (event.kind === "error") console.log(color(31, `[error] ${event.error}`));
    }
  });

  const elapsed = Date.now() - start;

  // ── Verify results ──────────────────────────────────────────────────────────
  console.log("");
  console.log(color(36, "=== Verification ==="));

  const checks: { name: string; pass: boolean; detail: string }[] = [];

  // Tool coverage
  const requiredTools = ["list_dir", "glob_files", "grep_files", "read_file", "read_files", "search_replace", "write_file", "write_files", "finish"];
  for (const t of requiredTools) {
    const used = toolCallsSeen.includes(t);
    checks.push({ name: `tool:${t}`, pass: used, detail: used ? "used" : "MISSING" });
  }

  // search_replace: greet.ts should say "See you later"
  try {
    const greet = await readFile(path.join(workspace, "src", "greet.ts"), "utf8");
    const hasLater = greet.includes("See you later");
    checks.push({ name: "search_replace:greet.ts", pass: hasLater, detail: hasLater ? "contains 'See you later'" : greet.slice(0, 200) });
  } catch {
    checks.push({ name: "search_replace:greet.ts", pass: false, detail: "file not found" });
  }

  // write_file: summary.ts should exist
  try {
    const summary = await readFile(path.join(workspace, "src", "summary.ts"), "utf8");
    const hasFn = summary.includes("summary") && summary.includes("return");
    checks.push({ name: "write_file:summary.ts", pass: hasFn, detail: hasFn ? "exists with summary function" : summary.slice(0, 200) });
  } catch {
    checks.push({ name: "write_file:summary.ts", pass: false, detail: "file not found" });
  }

  // write_files: constants.ts and types.ts
  try {
    const constants = await readFile(path.join(workspace, "src", "constants.ts"), "utf8");
    checks.push({ name: "write_files:constants.ts", pass: constants.includes("APP_NAME"), detail: constants.slice(0, 100) });
  } catch {
    checks.push({ name: "write_files:constants.ts", pass: false, detail: "file not found" });
  }
  try {
    const types = await readFile(path.join(workspace, "src", "helpers", "types.ts"), "utf8");
    checks.push({ name: "write_files:types.ts", pass: types.includes("Result"), detail: types.slice(0, 100) });
  } catch {
    checks.push({ name: "write_files:types.ts", pass: false, detail: "file not found" });
  }

  // hello.json = package.json
  try {
    const pkg = await readFile(path.join(workspace, "package.json"), "utf8");
    const hello = await readFile(path.join(workspace, "hello.json"), "utf8");
    const match = hello === pkg;
    checks.push({ name: "hello.json", pass: match, detail: match ? "matches package.json" : `content differs (len ${hello.length} vs ${pkg.length})` });
  } catch {
    checks.push({ name: "hello.json", pass: false, detail: "file not found" });
  }

  // Summary
  const passed = checks.filter(c => c.pass).length;
  const total = checks.length;

  for (const c of checks) {
    const icon = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${icon} ${c.name}: ${c.detail}`);
  }

  console.log("");
  console.log(color(36, "=== Summary ==="));
  console.log(`model: ${MODEL}`);
  console.log(`elapsed: ${elapsed}ms`);
  console.log(`iterations: ${result.iterations}`);
  console.log(`toolCalls: ${toolCallsSeen.join(", ")}`);
  console.log(`checks: ${passed}/${total} passed`);
  console.log(`result: ${total === passed ? color(32, "ALL PASSED") : color(31, `${total - passed} FAILED`)}`);

  if (total !== passed) {
    process.exit(1);
  }
}

await main();
