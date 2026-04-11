import test from "node:test";
import assert from "node:assert/strict";
import { runMediatedLoop } from "../src/mediated-agent-harness/loop.ts";
import type { MediatedHarnessEvent, ToolExecutionContext } from "../src/mediated-agent-harness/types.ts";

function createStreamingResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function createChunk(content: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test",
    choices: [
      {
        index: 0,
        delta: content ? { content } : {},
        finish_reason: finishReason,
      },
    ],
  })}`;
}

test("runMediatedLoop executes XML tool calls without emitting raw XML as assistant text", async () => {
  const originalFetch = globalThis.fetch;
  const events: MediatedHarnessEvent[] = [];

  globalThis.fetch = async () =>
    createStreamingResponse([
      createChunk('<function=finish><parameter name="summary">done</parameter><parameter name="result">{"ok":true}</parameter></function>'),
      createChunk("", "stop"),
      "data: [DONE]",
    ]);

  const toolContext: ToolExecutionContext = {
    cwd: process.cwd(),
    workspaceId: "test-workspace",
    allowedPaths: ["*"],
    readFiles: async () => ({}),
    writeFiles: async () => {},
    gitDiff: async () => "",
    gitStatus: async () => "",
    runNamedCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    saveArtifact: async () => "",
  };

  try {
    const result = await runMediatedLoop({
      systemPrompt: "Use XML tool calls.",
      userPrompt: "Finish immediately.",
      config: {
        model: "test-model",
        cwd: process.cwd(),
        toolMode: "xml",
        onEvent: (event) => events.push(event),
        maxIterations: 2,
      },
      toolContext,
    });

    assert.equal(result.text, '{"ok":true}');
    assert.ok(events.some((event) => event.kind === "tool_call" && event.call.name === "finish"));
    assert.ok(!events.some((event) => event.kind === "text" && event.text.includes("<function=")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
