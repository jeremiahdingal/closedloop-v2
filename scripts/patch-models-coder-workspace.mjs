import { readFileSync, writeFileSync } from "node:fs";

const file = "src/orchestration/models.ts";
let content = readFileSync(file, "utf-8");

// Find MediatedAgentHarnessGateway.runCoderDirect to insert runCoderInWorkspace before it
const marker = `  async runCoderDirect(input: {\n    prompt: string;\n    runId?: string | null;\n    ticketId?: string | null;\n    epicId?: string | null;\n    onStream?: StreamHook;\n  }): Promise<string> {`;

// We need the second occurrence (MediatedAgentHarnessGateway), after runBuilderInWorkspace
// First find the builder method to know we're past it
const builderIdx = content.indexOf("MediatedAgentHarnessGateway");
const firstCoderDirect = content.indexOf("async runCoderDirect", builderIdx);

if (firstCoderDirect < 0) {
  console.error("Could not find runCoderDirect in MediatedAgentHarnessGateway");
  process.exit(1);
}

// Find the line start
const lineStart = content.lastIndexOf("\n", firstCoderDirect) + 1;

const newMethod = `  async runCoderInWorkspace(input: {
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

content = content.substring(0, lineStart) + newMethod + content.substring(lineStart);

writeFileSync(file, content, "utf-8");
console.log("Done - added runCoderInWorkspace to MediatedAgentHarnessGateway");
