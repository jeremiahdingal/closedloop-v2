import { MediatedAgentHarness } from "../mediated-agent-harness/index.ts";
import type { ToolExecutionContext } from "../mediated-agent-harness/types.ts";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";

function loadEnv() {
  if (process.env.OPENROUTER_API_KEY) return;
  const envPath = path.resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === "OPENROUTER_API_KEY") {
        process.env.OPENROUTER_API_KEY = value;
      }
    }
  }
}

async function main() {
  loadEnv();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY not found");
    process.exit(1);
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "openrouter-harness-"));
  console.log(`Using temp dir: ${tempDir}`);

  const toolContext: ToolExecutionContext = {
    cwd: tempDir,
    workspaceId: "test-openrouter",
    availableCommands: ["ls", "cat"],
    allowedPaths: ["*"],
    readFiles: async (paths) => {
      const result: Record<string, string> = {};
      for (const p of paths) {
        try {
          result[p] = await readFile(path.join(tempDir, p), "utf-8");
        } catch {}
      }
      return result;
    },
    writeFiles: async (files) => {
      for (const f of files) {
        const fullPath = path.join(tempDir, f.path);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, f.content, "utf-8");
      }
    },
    gitDiff: async () => "",
    gitStatus: async () => "",
    runNamedCommand: async (name) => ({ stdout: "", stderr: `Mock command ${name}`, exitCode: 0 }),
    getAvailableCommands: () => ["ls", "cat"],
    saveArtifact: async (opts) => {
        const artifactPath = path.join(tempDir, `${opts.name}.txt`);
        await writeFile(artifactPath, opts.content, "utf-8");
        return artifactPath;
    },
  };

  const harness = new MediatedAgentHarness({
    baseURL: "http://localhost:11434",
    apiKey: "",
    apiBackend: "ollama",
    model: "batiai/qwen3.6-27b:iq4",
    toolContext,
  });

  console.log("Running harness with OpenRouter...");
  const result = await harness.run("coder", "Please create a file named 'hello.txt' with the content 'Hello from OpenRouter!' and then finish.", {
    maxIterations: 5,
    onEvent: (event) => {
      if (event.kind === "streaming_text") {
          process.stdout.write(event.text);
      } else if (event.kind === "streaming_thinking") {
          process.stdout.write(`[Thinking] ${event.text}`);
      } else if (event.kind !== "text" && event.kind !== "thinking") {
          console.log(`\n[Event] ${event.kind}:`, JSON.stringify(event));
      }
    }
  });

  console.log("\n--- Final Result ---");
  console.log(result.text);
  
  const helloContent = await readFile(path.join(tempDir, "hello.txt"), "utf-8").catch(() => "FILE NOT FOUND");
  console.log(`\nContent of hello.txt: ${helloContent}`);
}

main().catch(console.error);
