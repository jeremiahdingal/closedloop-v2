import { executeToolCall, WORKSPACE_TOOLS } from "../mediated-agent-harness/index.ts";
import type { ToolExecutionContext } from "../mediated-agent-harness/types.ts";
import { appendFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MODEL = process.env.MODEL || "glm-4.7-flash:q4_K_M";
const OUTPUT_DIR = path.join(process.cwd(), "data", "artifacts", "glm-tool-smoke");
const BATCH = parseInt(process.env.BATCH || "0");
const BATCH_SIZE = 4;

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
  return "\x1b[" + code + "m" + value + "\x1b[0m";
}

function toPreview(text: string, max = 220): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function extractXmlCall(text: string): { name: string; args: Record<string, unknown> } | null {
  // First decode XML entities
  const decoded = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
  
  const patterns = [
    // Standard XML formats
    /<function=([^>]+)>([\s\S]*?)<\/function(?:=[^>]+)?>/i,
    /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/i,
    /<call name="([^"]+)">([\s\S]*?)<\/call>/i,
    /<name>([^<]+)<\/name>[\s\S]*?<arguments>([\s\S]*?)<\/arguments>/i,
    // GLM-style self-closing: <tool_name arg1="val" arg2="val" />
    /<(\w+)\s+([^>]+)\/>/i,
    // GLM-style with content: <tool_name>content</tool_name>
    /<(\w+)>([\s\S]*?)<\/\1>/i,
    // Self-closing with no body: <tool_name/>
    /<(\w+)\/>/i
  ];
  
  for (const pattern of patterns) {
    const match = pattern.exec(decoded);
    if (match) {
      const name = match[1];
      const body = match[2] || "";
      const args: Record<string, unknown> = {};
      
      // Try to extract parameters - various formats
      const paramPatterns = [
        /<parameter(?:=([^>]+)|\s+name="([^"]+)")>([\s\S]*?)<\/parameter(?:=[^>]+)?>/gi,
        /"([^"]+)":\s*("[^"]*"|\d+|true|false|null)/g,
        /(\w+)=("[^"]*"|\S+)/g
      ];
      
      for (const paramRegex of paramPatterns) {
        let paramMatch = paramRegex.exec(body);
        while (paramMatch) {
          const paramName = paramMatch[1] || paramMatch[2];
          const rawValue = paramMatch[3] || paramMatch[2];
          if (paramName && rawValue) {
            try {
              args[paramName] = JSON.parse(rawValue);
            } catch {
              args[paramName] = rawValue.replace(/^["']|["']$/g, "");
            }
          }
          paramMatch = paramRegex.exec(body);
        }
      }
      
      return { name: name.trim(), args };
    }
  }
  return null;
}

async function queryModelForToolCall(toolName: string, expectedArgs: Record<string, unknown>, instruction: string): Promise<string> {
  const system = "You are a strict tool-calling assistant. Respond with exactly one XML function call and nothing else.";
  const user = "Call tool '" + toolName + "' now. Instruction: " + instruction + ". Use these exact args JSON: " + JSON.stringify(expectedArgs);

  const response = await fetch(OLLAMA_BASE + "/v1/chat/completions", {
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

async function queryModelForToolCallWithRetry(toolName: string, expectedArgs: Record<string, unknown>, instruction: string): Promise<string> {
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await queryModelForToolCall(toolName, expectedArgs, instruction);
    last = text;
    if (extractXmlCall(text)) return text;
  }
  return last;
}

async function buildWorkspace(): Promise<{ root: string; ctx: ToolExecutionContext }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "glm-tools-"));
  await writeFile(path.join(root, "README.md"), "# GLM Tool Smoke\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "glm-tool-smoke",
    version: "1.0.0",
    private: true
  }, null, 2) + "\n", "utf8");

  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "GLM Tool Smoke"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  await appendFile(path.join(root, "README.md"), "\nsmoke change\n", "utf8");

  const ctx: ToolExecutionContext = {
    cwd: root,
    workspaceId: "glm-tool-smoke",
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
      for (const f of files) {
        const fullPath = path.join(root, f.path);
        const dir = path.dirname(fullPath);
        await mkdir(dir, { recursive: true });
        await writeFile(fullPath, f.content, "utf8");
      }
    },
    gitDiff: async () => {
      const result = await execFileAsync("git", ["diff"], { cwd: root });
      return result.stdout;
    },
    gitStatus: async () => {
      const result = await execFileAsync("git", ["status"], { cwd: root });
      return result.stdout;
    },
    runNamedCommand: async (name) => {
      if (name !== "status") throw new Error("Command not allowed");
      try {
        const result = await execFileAsync("status", [], { shell: true });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch {
        return { stdout: "", stderr: "Command failed", exitCode: 1 };
      }
    },
    saveArtifact: async (opts) => {
      const artifactDir = path.join(process.cwd(), "data", "artifacts");
      await mkdir(artifactDir, { recursive: true });
      const p = path.join(artifactDir, opts.name + ".txt");
      await writeFile(p, opts.content, "utf8");
      return p;
    },
    readArtifact: async (opts) => {
      const artifactDir = path.join(process.cwd(), "data", "artifacts");
      const p = path.join(artifactDir, (opts.name || "") + ".txt");
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
      expectedArgs: { pattern: "GLM" },
      instruction: "Search for GLM text."
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
      expectedArgs: { path: "hello.json", content: '{\n  "hello": "world"\n}\n' },
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
      expectedArgs: { summary: "done", result: '{"ok":true}' },
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

  console.log(color(36, "GLM tool smoke model=" + MODEL));
  console.log(color(36, "workspace=" + root));
  console.log(color(36, "tools=" + toolNames.length));
  console.log(color(36, "batch=" + BATCH + " size=" + BATCH_SIZE));

  // Apply batch filtering
  const batchScenarios = BATCH >= 0 
    ? scenarios.slice(BATCH * BATCH_SIZE, (BATCH + 1) * BATCH_SIZE)
    : scenarios;
  
  console.log(color(36, "running " + batchScenarios.length + " scenarios"));

  for (const scenario of batchScenarios) {
    console.log(color(33, "\n[tool] " + scenario.name));
    if (scenario.before) await scenario.before(ctx);

    const modelText = await queryModelForToolCallWithRetry(scenario.name, scenario.expectedArgs, scenario.instruction);
    const parsed = extractXmlCall(modelText);
    const nameMatch = parsed ? parsed.name === scenario.name : false;

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
          id: "smoke_" + scenario.name,
          name: parsed.name,
          args: parsed.args
        }, ctx);
        executed = true;
        isError = Boolean(execResult.isError);
        outputPreview = toPreview(execResult.output);
      }
    } else {
      outputPreview = toPreview(modelText || "(empty)");
    }

    const success = nameMatch && executed && !isError;

    results.push({
      tool: scenario.name,
      instruction: scenario.instruction,
      expectedArgs: scenario.expectedArgs,
      modelText,
      parsedCall: parsed,
      callNameMatched: nameMatch,
      execution: { executed, isError, outputPreview },
      success,
      expectedError: scenario.expectedError || false
    });

    console.log(color(success ? 32 : 31, "  parsed: " + (parsed ? parsed.name + "(" + JSON.stringify(parsed.args) + ")" : "(none)")));
    console.log(color(executed ? 32 : 33, "  exec: " + (executed ? (isError ? "error" : "ok") : "skipped")));
    console.log(color(90, "  out: " + outputPreview));
  }

  const summary = results.filter((r) => !r.expectedError);
  const passed = summary.filter((r) => r.success).length;
  const total = summary.length;
  console.log(color(36, "\n=== " + passed + "/" + total + " tools passed ===\n"));

  const failingTools = summary.filter((r) => !r.success).map((r) => r.tool);
  console.log(color(31, "Failing: " + failingTools.join(", ")));

  const modelOutputs: Record<string, string> = {};
  for (const r of results) {
    modelOutputs[r.tool] = r.modelText;
  }
  console.log(color(90, "\n=== Model output samples ==="));
  for (const tool of Object.keys(modelOutputs)) {
    console.log(color(90, "\n--- " + tool + " ---"));
    console.log(color(90, modelOutputs[tool].slice(0, 500)));
  }
}

run().catch(console.error);