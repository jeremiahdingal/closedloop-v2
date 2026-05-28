import { readFileSync, writeFileSync } from "node:fs";

const file = "src/orchestration/models.ts";
let content = readFileSync(file, "utf-8");

// === 1. Replace OllamaGateway's wrong runCoderInWorkspace with a stub ===

// Find the wrong method block in OllamaGateway
const ollamaWrongStart = content.indexOf("  async runCoderInWorkspace(input: {\n    cwd: string;\n    prompt: string;\n    runId");
if (ollamaWrongStart < 0) {
  console.error("Could not find wrong runCoderInWorkspace in OllamaGateway");
  process.exit(1);
}

// It ends right before "  async runCoderDirect(input: { prompt: string; onStream"
const ollamaDirectAfter = content.indexOf("  async runCoderDirect(input: { prompt: string; onStream", ollamaWrongStart);
if (ollamaDirectAfter < 0) {
  console.error("Could not find OllamaGateway runCoderDirect after wrong method");
  process.exit(1);
}

const stub = `  runCoderInWorkspace(_input: { cwd: string; prompt: string }): Promise<string> {
    throw new Error("Coder requires mediated harness (MediatedAgentHarnessGateway)");
  }

`;

content = content.substring(0, ollamaWrongStart) + stub + content.substring(ollamaDirectAfter);
console.log("Step 1: Replaced OllamaGateway wrong method with stub");

// === 2. Insert full runCoderInWorkspace into MediatedAgentHarnessGateway, before its runCoderDirect ===
// After step 1, line numbers shifted. Find MediatedAgentHarnessGateway's runCoderDirect by looking for it
// after the class declaration.

const mediatedClassIdx = content.indexOf("class MediatedAgentHarnessGateway");
if (mediatedClassIdx < 0) {
  console.error("Could not find MediatedAgentHarnessGateway class");
  process.exit(1);
}

// Find the LAST runCoderDirect — that's the one in MediatedAgentHarnessGateway
// Actually, let's find it after the class start
let searchFrom = mediatedClassIdx;
let mediatedCoderDirectIdx = -1;
while (true) {
  const idx = content.indexOf("  async runCoderDirect(input: {", searchFrom);
  if (idx < 0) break;
  mediatedCoderDirectIdx = idx;
  searchFrom = idx + 1;
}

if (mediatedCoderDirectIdx < 0) {
  console.error("Could not find MediatedAgentHarnessGateway runCoderDirect");
  process.exit(1);
}

// Find the line start
const lineStart = content.lastIndexOf("\n", mediatedCoderDirectIdx) + 1;

const fullMethod = `  async runCoderInWorkspace(input: {
    cwd: string;
    prompt: string;
    runId?: string | null;
    ticketId?: string | null;
    epicId?: string | null;
    onStream?: StreamHook;
  }): Promise<string> {
    const model = this.resolveHarnessModel("coder");
    const allowInstallCommand = promptExplicitlyRequestsDependencyInstall(input.prompt);
    input.onStream?.({
      agentRole: "coder",
      source: "orchestrator",
      streamKind: "status",
      content: "Coding via mediated agent harness...",
      runId: input.runId,
      ticketId: input.ticketId,
      epicId: input.epicId,
      sequence: 0,
    });

    const toolContext = this.buildToolContext(input.cwd, input.ticketId || "unknown", undefined, allowInstallCommand ? ["install"] : []);
    const harness = new MediatedAgentHarness({
      baseURL: \`\${this.ollamaBaseURL}/v1\`,
      apiKey: "ollama",
      model,
      braveApiKey: this.braveApiKey,
      toolContext,
    });

    await ensureModelLoaded(model);
    const result = await harness.run("coder", input.prompt, {
      maxIterations: 15,
      timeoutMs: 600_000,
      onEvent: (event) => {
        if (event.kind === "text" || event.kind === "thinking") {
          input.onStream?.({
            agentRole: "coder",
            source: "mediated-harness",
            streamKind: event.kind === "thinking" ? "thinking" : "assistant",
            content: event.text,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
        if (event.kind === "tool_call") {
          const argsPreview = JSON.stringify(event.call.args ?? {}).slice(0, 300);
          input.onStream?.({
            agentRole: "coder",
            source: "mediated-harness",
            streamKind: "tool_call",
            content: \`\${event.call.name}(\${argsPreview})\`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.call.name, toolArgs: event.call.args as import("../types.ts").Json },
          });
        }
        if (event.kind === "tool_result") {
          input.onStream?.({
            agentRole: "coder",
            source: "mediated-harness",
            streamKind: "tool_result",
            content: event.result.output,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.result.name, toolResult: event.result.output, isError: Boolean(event.result.isError) },
          });
        }
        if (event.kind === "tool_error") {
          input.onStream?.({
            agentRole: "coder",
            source: "mediated-harness",
            streamKind: "error",
            content: \`Tool error: \${event.error}\`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model, toolName: event.call.name, error: event.error },
          });
        }
        if (event.kind === "complete") {
          input.onStream?.({
            agentRole: "coder",
            source: "mediated-harness",
            streamKind: "status",
            content: \`Completed in \${event.iterations} iterations\`,
            runId: input.runId,
            ticketId: input.ticketId,
            epicId: input.epicId,
            sequence: 0,
            metadata: { model },
          });
        }
      },
    });
    markModelLoaded(model);

    return result.text;
  }

`;

content = content.substring(0, lineStart) + fullMethod + content.substring(lineStart);
console.log("Step 2: Inserted full runCoderInWorkspace into MediatedAgentHarnessGateway");

writeFileSync(file, content, "utf-8");
console.log("Done!");
