import { MediatedAgentHarness, executeToolCall } from "../mediated-agent-harness/index.ts";
import type { ToolExecutionContext } from "../mediated-agent-harness/types.ts";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MODEL = process.argv[2] || "gemma4:26b";
const TASK = process.argv[3] || "Create hello.json in the workspace root by copying the exact contents of package.json. You must use write_file, then call finish with a JSON string result that includes filesChanged.";

function color(code: number, value: string): string {
  return `\x1b[${code}m${value}\x1b[0m`;
}

async function buildTempWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "gemma-harness-"));
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "gemma-harness-smoke",
    private: true,
    version: "1.0.0",
    description: "Temporary mediated harness workspace"
  }, null, 2) + "\n", "utf8");
  await mkdir(path.join(workspace, ".orchestrator"), { recursive: true });
  await writeFile(path.join(workspace, ".orchestrator", "context.json"), JSON.stringify({
    epicId: "epic_gemma_smoke",
    ticketId: "ticket_gemma_smoke",
    runId: "run_gemma_smoke",
    title: "Create hello.json from package.json",
    description: "Write hello.json by copying package.json exactly.",
    acceptanceCriteria: [
      "hello.json exists",
      "hello.json exactly matches package.json"
    ],
    allowedPaths: ["package.json", "hello.json"],
    attempt: 1
  }, null, 2) + "\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Gemma Smoke"], { cwd: workspace });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: workspace });
  return workspace;
}

async function main(): Promise<void> {
  const workspace = await buildTempWorkspace();
  const toolContext: ToolExecutionContext = {
    cwd: workspace,
    workspaceId: "gemma-smoke",
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

  console.log(color(36, "=== Gemma Mediated Harness Smoke ==="));
  console.log(`model: ${MODEL}`);
  console.log(`workspace: ${workspace}`);
  console.log(`task: ${TASK}`);
  console.log("");

  const runSmoke = async (toolMode: "native" | "xml") => {
    const start = Date.now();
    const result = await harness.runWithPrompt(
      toolMode === "xml"
        ? [
            "You are a code-writing agent.",
            "You must use XML tool calls instead of native tool calling.",
            "Format every tool call exactly like this:",
            "<function=read_file><parameter=path>package.json</parameter=path></function=read_file>",
            "After reading package.json, write hello.json with the exact same content.",
            "When finished, call finish using XML with summary and result parameters.",
            "Do not emit prose before or after the tool call."
          ].join(" ")
        : [
            "You are a code-writing agent.",
            "You must use the workspace tools to create or update files.",
            "For this task, you must read package.json, write hello.json, then call finish.",
            "Do not describe code without writing it.",
            "The finish tool result must be a JSON string with keys: filesChanged, success, notes."
          ].join(" "),
      TASK,
      {
        toolMode,
        maxIterations: 12,
        timeoutMs: 300_000,
        temperature: 1.0,
        topP: 0.95,
        topK: 64,
        onEvent: (event) => {
          if (event.kind === "thinking") console.log(color(36, `[thinking] ${event.text.slice(0, 200)}`));
          if (event.kind === "text") console.log(color(33, `[text] ${event.text.slice(0, 300)}`));
          if (event.kind === "tool_call") console.log(color(32, `[tool] ${event.call.name} ${JSON.stringify(event.call.args).slice(0, 180)}`));
          if (event.kind === "tool_result") console.log(color(32, `[tool-result] ${event.result.output.slice(0, 200)}`));
          if (event.kind === "tool_error") console.log(color(31, `[tool-error] ${event.error}`));
          if (event.kind === "complete") console.log(color(35, `[complete] iterations=${event.iterations}`));
          if (event.kind === "error") console.log(color(31, `[error] ${event.error}`));
        }
      }
    );
    return { result, elapsed: Date.now() - start };
  };

  let finalRun: { result: { text: string; iterations: number; toolCalls: Array<string | { name: string }>; }; elapsed: number; mode: "native" | "xml" | "xml-compat" };
  try {
    const native = await runSmoke("native");
    finalRun = { result: native.result, elapsed: native.elapsed, mode: "native" };
  } catch (error) {
    console.log("");
    console.log(color(31, `native mode failed: ${error instanceof Error ? error.message : String(error)}`));
    console.log(color(36, "retrying with xml tool mode..."));
    try {
      const xml = await runSmoke("xml");
      finalRun = { result: xml.result, elapsed: xml.elapsed, mode: "xml" };
    } catch (xmlError) {
      console.log(color(31, `xml mode failed: ${xmlError instanceof Error ? xmlError.message : String(xmlError)}`));
      console.log(color(36, "retrying with xml compatibility loop..."));
      const compat = await runXmlCompatLoop(toolContext);
      finalRun = {
        result: {
          text: compat.result,
          iterations: compat.iterations,
          toolCalls: compat.toolCalls
        },
        elapsed: compat.elapsed,
        mode: "xml-compat"
      };
    }
  }

  const helloPath = path.join(workspace, "hello.json");
  const packageContent = await readFile(path.join(workspace, "package.json"), "utf8");
  let helloContent = "";
  try {
    helloContent = await readFile(helloPath, "utf8");
  } catch {}

  console.log("");
  console.log(color(36, "=== Smoke Result ==="));
  console.log(`mode: ${finalRun.mode}`);
  console.log(`elapsedMs: ${finalRun.elapsed}`);
  console.log(`iterations: ${finalRun.result.iterations}`);
  console.log(`toolCalls: ${finalRun.result.toolCalls.map((tool) => typeof tool === "string" ? tool : tool.name).join(", ")}`);
  console.log(`helloExists: ${helloContent.length > 0}`);
  console.log(`helloMatchesPackage: ${helloContent === packageContent}`);
  console.log("");
  console.log(color(36, "--- final text ---"));
  console.log(finalRun.result.text);
  console.log("");
  console.log(color(36, "--- hello.json ---"));
  console.log(helloContent || "<missing>");
}

function extractXmlCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const fnMatch = /<function=([^>]+)>([\s\S]*?)<\/function(?:=[^>]+)?>/.exec(text);
  if (!fnMatch) return null;
  const [, name, body] = fnMatch;
  const args: Record<string, unknown> = {};
  const paramRegex = /<parameter(?:=([^>]+)|\s+name="([^"]+)")>([\s\S]*?)<\/parameter(?:=[^>]+)?>/g;
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
  return { name, args };
}

async function runXmlCompatLoop(toolContext: ToolExecutionContext) {
  const messages: Array<{ role: string; content: string }> = [
      {
        role: "system",
        content: [
          "You are a code-writing agent using XML function calls.",
          "Every assistant turn must be exactly one XML function call and nothing else.",
          "Available functions: read_file(path), write_file(path, content), list_dir(path), finish(summary, result).",
          "Use this exact syntax:",
          "<function=write_file><parameter=path>hello.json</parameter><parameter=content>{}</parameter></function=write_file>",
          "After writing hello.json, call finish."
        ].join(" ")
      },
      { role: "user", content: TASK }
    ];
  const start = Date.now();
  const toolCalls: string[] = [];

  for (let iteration = 1; iteration <= 8; iteration += 1) {
    console.log(color(33, `[compat] iteration ${iteration}/8`));
    const response = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ollama"
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: false,
        temperature: 1.0,
        top_p: 0.95,
        top_k: 64
      })
    });
    const payload = await response.json() as any;
    const content = String(payload?.choices?.[0]?.message?.content || "");
    console.log(color(33, `[compat-text] ${content.slice(0, 300)}`));
    const call = extractXmlCall(content);
    if (!call) {
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: "Continue. Respond with exactly one XML function call next. Do not output prose." });
      continue;
    }
    toolCalls.push(call.name);
    if (call.name === "finish") {
      return {
        result: typeof call.args.result === "string"
          ? call.args.result
          : JSON.stringify(call.args.result ?? {}, null, 2),
        iterations: iteration,
        toolCalls,
        elapsed: Date.now() - start
      };
    }
    if (call.name === "write_file" && typeof call.args.content !== "string") {
      call.args.content = JSON.stringify(call.args.content, null, 2) + "\n";
    }
    const toolResult = await executeToolCall({
      id: `compat_${iteration}`,
      name: call.name,
      args: call.args
    }, toolContext);
    console.log(color(32, `[compat-tool] ${call.name} ${JSON.stringify(call.args).slice(0, 180)}`));
    console.log(color(32, `[compat-tool-result] ${toolResult.output.slice(0, 200)}`));
    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: `Tool result for ${call.name}:\n${toolResult.output}\nContinue with exactly one XML function call.` });
  }

  throw new Error("XML compatibility loop exhausted iterations");
}

await main();
