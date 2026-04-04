import { executeToolCall, WORKSPACE_TOOLS } from "../mediated-agent-harness/index.ts";
import type { ToolExecutionContext } from "../mediated-agent-harness/types.ts";
import { appendFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MODEL = process.argv[2] || "gemma4:26b";
const OUTPUT_DIR = path.join(process.cwd(), "data", "artifacts", "gemma-tool-smoke");

type ToolScenario = {
  name: string;
  expectedArgs: Record<string, unknown>;
  instruction: string;
  expectedError?: boolean;
  before?: (ctx: ToolExecutionContext) => Promise<void>;
};

type DictionaryEntry = {
  tool: string;
  instruction: string;
  expectedArgs: Record<string, unknown>;
  modelText: string;
  parsedCall: { name: string; args: Record<string, unknown> } | null;
  callNameMatched: boolean;
  execution: {
    executed: boolean;
    isError: boolean;
    outputPreview: string;
  };
  success: boolean;
  expectedError: boolean;
};

function color(code: number, value: string): string {
  return `\x1b[${code}m${value}\x1b[0m`;
}

function toPreview(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function extractXmlCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const fnMatch = /<function=([^>]+)>([\s\S]*?)<\/function(?:=[^>]+)?>/i.exec(text);
  if (!fnMatch) return null;
  const [, name, body] = fnMatch;
  const args: Record<string, unknown> = {};
  const paramRegex = /<parameter(?:=([^>]+)|\s+name="([^"]+)")>([\s\S]*?)<\/parameter(?:=[^>]+)?>/gi;
  let paramMatch: RegExpExecArray | null;
  while ((paramMatch = paramRegex.exec(body)) !== null) {
    const paramName = paramMatch[1] || paramMatch[2];
    const rawValue = paramMatch[3];
    if (!paramName) continue;
    try {
      args[paramName] = JSON.parse(rawValue);
    } catch {
      args[paramName] = rawValue;
    }
  }
  return { name: name.trim(), args };
}

async function queryGemmaForToolCall(toolName: string, expectedArgs: Record<string, unknown>, instruction: string): Promise<string> {
  const system = [
    "You are a strict tool-calling assistant.",
    "Respond with exactly one XML function call and nothing else.",
    "No prose, no markdown.",
    "Use this format:",
    "<function=TOOL_NAME><parameter=argName>value</parameter></function=TOOL_NAME>"
  ].join(" ");
  const user = [
    `Call tool '${toolName}' now.`,
    `Instruction: ${instruction}`,
    `Use these exact args JSON: ${JSON.stringify(expectedArgs)}`,
    "If no args are needed, emit the function call with no parameter tags."
  ].join("\n");

  const response = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer ollama"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      stream: false,
      temperature: 1.0,
      top_p: 0.95,
      top_k: 64
    })
  });

  const payload = await response.json() as any;
  return String(payload?.choices?.[0]?.message?.content || "");
}

async function queryGemmaForToolCallWithRetry(toolName: string, expectedArgs: Record<string, unknown>, instruction: string): Promise<string> {
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const text = await queryGemmaForToolCall(toolName, expectedArgs, instruction);
    last = text;
    if (extractXmlCall(text)) return text;
  }
  return last;
}

async function buildWorkspace(): Promise<{ root: string; ctx: ToolExecutionContext }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gemma-tools-"));
  await writeFile(path.join(root, "README.md"), "# Gemma Tool Smoke\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "gemma-tool-smoke",
    version: "1.0.0",
    private: true
  }, null, 2) + "\n", "utf8");
  await writeFile(path.join(root, "context.json"), JSON.stringify({
    ticketId: "ticket_tool_smoke",
    allowedPaths: ["*"],
    attempt: 1
  }, null, 2) + "\n", "utf8");

  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Gemma Tool Smoke"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  await appendFile(path.join(root, "README.md"), "\nsmoke change\n", "utf8");

  const ctx: ToolExecutionContext = {
    cwd: root,
    workspaceId: "gemma-tool-smoke",
    allowedPaths: ["*"],
    braveApiKey: process.env.BRAVE_API_KEY,
    readFiles: async (paths) => {
      const out: Record<string, string> = {};
      for (const p of paths) {
        try {
          out[p] = await readFile(path.join(root, p), "utf8");
        } catch {}
      }
      return out;
    },
    writeFiles: async (files) => {
      for (const file of files) {
        const full = path.join(root, file.path);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, file.content, "utf8");
      }
    },
    gitDiff: async () => {
      try {
        const { stdout } = await execFileAsync("git", ["diff"], { cwd: root, timeout: 10000 });
        return stdout;
      } catch {
        return "";
      }
    },
    gitDiffStaged: async () => {
      try {
        const { stdout } = await execFileAsync("git", ["diff", "--staged"], { cwd: root, timeout: 10000 });
        return stdout;
      } catch {
        return "";
      }
    },
    gitStatus: async () => {
      try {
        const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: root, timeout: 10000 });
        return stdout;
      } catch {
        return "";
      }
    },
    runNamedCommand: async (name) => {
      if (name !== "status") return { stdout: "", stderr: `Unknown command: ${name}`, exitCode: 1 };
      try {
        const { stdout, stderr } = await execFileAsync("git", ["status", "--short"], { cwd: root, timeout: 10000 });
        return { stdout, stderr, exitCode: 0 };
      } catch (err: any) {
        return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(err), exitCode: err.code ?? 1 };
      }
    },
    saveArtifact: async (opts) => {
      const artifactDir = path.join(root, "artifacts");
      await mkdir(artifactDir, { recursive: true });
      const p = path.join(artifactDir, `${opts.name}.txt`);
      await writeFile(p, opts.content, "utf8");
      return p;
    },
    readArtifact: async (opts) => {
      const artifactDir = path.join(root, "artifacts");
      if (!opts.name) return null;
      const p = path.join(artifactDir, `${opts.name}.txt`);
      try {
        return await readFile(p, "utf8");
      } catch {
        return null;
      }
    },
    getAvailableCommands: () => ["status"]
  };
  return { root, ctx };
}

function buildScenarios(allTools: string[]): ToolScenario[] {
  const scenarios: Record<string, ToolScenario> = {
    glob_files: {
      name: "glob_files",
      expectedArgs: { pattern: "*.json" },
      instruction: "Find top-level json files."
    },
    grep_files: {
      name: "grep_files",
      expectedArgs: { pattern: "Gemma" },
      instruction: "Search for Gemma text."
    },
    list_dir: {
      name: "list_dir",
      expectedArgs: { path: "." },
      instruction: "List root directory."
    },
    read_file: {
      name: "read_file",
      expectedArgs: { path: "package.json" },
      instruction: "Read package.json."
    },
    read_files: {
      name: "read_files",
      expectedArgs: { paths: ["package.json", "README.md"] },
      instruction: "Read two files."
    },
    write_file: {
      name: "write_file",
      expectedArgs: { path: "hello.json", content: "{\n  \"hello\": \"world\"\n}\n" },
      instruction: "Write hello.json content."
    },
    write_files: {
      name: "write_files",
      expectedArgs: { files: [{ path: "a.txt", content: "A" }, { path: "b.txt", content: "B" }] },
      instruction: "Write two small files."
    },
    git_diff: {
      name: "git_diff",
      expectedArgs: {},
      instruction: "Show unstaged diff."
    },
    git_diff_staged: {
      name: "git_diff_staged",
      expectedArgs: {},
      instruction: "Show staged diff.",
      before: async (ctx) => {
        await execFileAsync("git", ["add", "README.md"], { cwd: ctx.cwd });
      }
    },
    git_status: {
      name: "git_status",
      expectedArgs: {},
      instruction: "Show git status."
    },
    list_changed_files: {
      name: "list_changed_files",
      expectedArgs: {},
      instruction: "List changed files."
    },
    run_command: {
      name: "run_command",
      expectedArgs: { name: "status" },
      instruction: "Run whitelisted status command."
    },
    read_context_packet: {
      name: "read_context_packet",
      expectedArgs: {},
      instruction: "Read context packet."
    },
    save_artifact: {
      name: "save_artifact",
      expectedArgs: { name: "tool-smoke", content: "artifact content", kind: "report" },
      instruction: "Save artifact."
    },
    read_artifact: {
      name: "read_artifact",
      expectedArgs: { name: "tool-smoke" },
      instruction: "Read artifact saved earlier.",
      before: async (ctx) => {
        await executeToolCall({ id: "seed_artifact", name: "save_artifact", args: { name: "tool-smoke", content: "artifact content", kind: "report" } }, ctx);
      }
    },
    web_search: {
      name: "web_search",
      expectedArgs: { query: "OpenAI", count: 2 },
      instruction: "Search web briefly.",
      expectedError: !Boolean(process.env.BRAVE_API_KEY)
    },
    finish: {
      name: "finish",
      expectedArgs: { summary: "done", result: "{\"ok\":true}" },
      instruction: "Return finish payload."
    }
  };
  return allTools.map((name) => scenarios[name]).filter(Boolean);
}

async function run(): Promise<void> {
  const { root, ctx } = await buildWorkspace();
  await mkdir(OUTPUT_DIR, { recursive: true });
  const toolNames = WORKSPACE_TOOLS.map((tool) => tool.function.name);
  const scenarios = buildScenarios(toolNames);
  const results: DictionaryEntry[] = [];

  console.log(color(36, `Gemma tool smoke model=${MODEL}`));
  console.log(color(36, `workspace=${root}`));
  console.log(color(36, `tools=${toolNames.length}`));

  for (const scenario of scenarios) {
    console.log(color(33, `\n[tool] ${scenario.name}`));
    await scenario.before?.(ctx);

    const modelText = await queryGemmaForToolCallWithRetry(scenario.name, scenario.expectedArgs, scenario.instruction);
    const parsed = extractXmlCall(modelText);
    const nameMatch = parsed?.name === scenario.name;

    let executed = false;
    let isError = false;
    let outputPreview = "";

    if (nameMatch && parsed) {
      if (scenario.name === "finish") {
        executed = true;
        isError = false;
        outputPreview = JSON.stringify(parsed.args);
      } else {
        const execResult = await executeToolCall({
          id: `smoke_${scenario.name}`,
          name: parsed.name,
          args: parsed.args
        }, ctx);
        executed = true;
        isError = Boolean(execResult.isError);
        outputPreview = toPreview(execResult.output);
      }
    } else {
      outputPreview = toPreview(modelText || "(empty)");
      isError = true;
    }

    const expectedError = Boolean(scenario.expectedError);
    const success = nameMatch && executed && (expectedError ? isError : !isError);
    results.push({
      tool: scenario.name,
      instruction: scenario.instruction,
      expectedArgs: scenario.expectedArgs,
      modelText,
      parsedCall: parsed,
      callNameMatched: nameMatch,
      execution: { executed, isError, outputPreview },
      success,
      expectedError
    });

    const status = success ? color(32, "PASS") : color(31, "FAIL");
    console.log(`${status} nameMatch=${nameMatch} error=${isError} preview=${outputPreview}`);
  }

  const passCount = results.filter((r) => r.success).length;
  const outPath = path.join(OUTPUT_DIR, `tool-dictionary.${MODEL.replace(/[^\w.-]+/g, "_")}.json`);
  await writeFile(outPath, JSON.stringify({
    model: MODEL,
    createdAt: new Date().toISOString(),
    workspace: root,
    totalTools: results.length,
    passed: passCount,
    failed: results.length - passCount,
    results
  }, null, 2), "utf8");

  console.log(color(36, `\nDictionary written: ${outPath}`));
  console.log(color(36, `Pass rate: ${passCount}/${results.length}`));
}

await run();
