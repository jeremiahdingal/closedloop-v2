import test from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runMediatedLoop } from "../loop.ts";
import type { MediatedHarnessConfig, ToolExecutionContext } from "../types.ts";

function createMockContext(cwd: string): ToolExecutionContext {
  return {
    cwd,
    workspaceId: "test-ws",
    allowedPaths: ["*"],
    readFiles: async (paths) => {
      const result: Record<string, string> = {};
      for (const p of paths) {
        try {
          const { readFile } = await import("node:fs/promises");
          result[p] = await readFile(path.join(cwd, p), "utf-8");
        } catch {}
      }
      return result;
    },
    writeFiles: async (files) => {
      const { writeFile: wf, mkdir: md } = await import("node:fs/promises");
      for (const f of files) {
        const fp = path.join(cwd, f.path);
        await md(path.dirname(fp), { recursive: true });
        await wf(fp, f.content, "utf-8");
      }
    },
    gitDiff: async () => "",
    gitStatus: async () => "",
    runNamedCommand: async (name) => ({
      stdout: `output of ${name}`,
      stderr: "",
      exitCode: 0,
    }),
    saveArtifact: async (opts) => {
      const { mkdir: md, writeFile: wf } = await import("node:fs/promises");
      const dir = path.join(cwd, ".artifacts");
      await md(dir, { recursive: true });
      const fp = path.join(dir, `${opts.name}.txt`);
      await wf(fp, opts.content, "utf-8");
      return fp;
    },
  };
}

function makeToolCallChunk(opts: {
  id: string;
  name: string;
  args: Record<string, unknown>;
}): string {
  return JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        function: { name: opts.name, arguments: opts.args },
      }],
    },
    done: false,
  });
}

function makeTextChunk(text: string): string {
  return JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content: text },
    done: false,
  });
}

const DONE_LINE = JSON.stringify({
  model: "test",
  created_at: "2026-01-01T00:00:00Z",
  message: { role: "assistant", content: "" },
  done: true,
  prompt_eval_count: 10,
  eval_count: 5,
});

function createMockServer(ndjsonLines: string[], requestBodies?: any[]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/api/chat")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          if (requestBodies) {
            requestBodies.push(JSON.parse(body));
          }
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          let i = 0;
          const send = () => {
            if (i < ndjsonLines.length) {
              res.write(ndjsonLines[i] + "\n");
              i++;
              setTimeout(send, 1);
            } else {
              res.end();
            }
          };
          send();
        });
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, () => {
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

function createSequencedMockServer(
  responses: string[][],
  requestBodies?: any[],
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    let requestIndex = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/api/chat")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          if (requestBodies) {
            requestBodies.push(JSON.parse(body));
          }
          const ndjsonLines = responses[Math.min(requestIndex, responses.length - 1)] ?? [];
          requestIndex++;
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          let i = 0;
          const send = () => {
            if (i < ndjsonLines.length) {
              res.write(ndjsonLines[i] + "\n");
              i++;
              setTimeout(send, 1);
            } else {
              res.end();
            }
          };
          send();
        });
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, () => {
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

function createAnthropicMockServer(
  responders: Array<(body: any) => string>,
  requestBodies: any[],
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/v1/messages")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          requestBodies.push(parsed);
          const responseBody = responders[Math.min(requestCount, responders.length - 1)](parsed);
          requestCount++;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(responseBody);
        });
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, () => {
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

function makeAnthropicToolUseSse(opts: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  prefaceText?: string;
}): string {
  const events: string[] = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "test-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n`,
  ];

  if (opts.prefaceText) {
    events.push(
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: opts.prefaceText } })}\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n`,
    );
  }

  const toolIndex = opts.prefaceText ? 1 : 0;
  events.push(
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: toolIndex, content_block: { type: "tool_use", id: opts.id, name: opts.name, input: {} } })}\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: toolIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(opts.input) } })}\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: toolIndex })}\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 5 } })}\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
  );

  return `${events.join("\n")}\n`;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("loop handles model that returns text directly (no tools)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));

  const ndjsonLines = [
    makeTextChunk('{"summary":"done","tickets":[]}'),
    DONE_LINE,
  ];
  const { server, port } = await createMockServer(ndjsonLines);

  try {
    const events: any[] = [];
    const result = await runMediatedLoop({
      systemPrompt: "You are a test agent.",
      userPrompt: "Do something.",
      config: {
        baseURL: `http://localhost:${port}`,
        apiKey: "",
        model: "test-model",
        cwd: tmpDir,
        temperature: 0,
        maxIterations: 3,
        onEvent: (e) => events.push(e),
      },
      toolContext: createMockContext(tmpDir),
    });

    assert.ok(result.text.includes("done"));
    assert.equal(result.iterations, 1);
    const textEvents = events.filter(e => e.kind === "text");
    assert.ok(textEvents.length > 0);
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop injects a visible continue nudge after a no-tool-call stall", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));
  const requestBodies: any[] = [];

  const responses = [
    [
      makeTextChunk("I will keep thinking about it."),
      DONE_LINE,
    ],
    [
      makeToolCallChunk({
        id: "call_1",
        name: "finish",
        args: { summary: "done", result: '{"ok":true}' },
      }),
      DONE_LINE,
    ],
  ];
  const { server, port } = await createSequencedMockServer(responses, requestBodies);

  try {
    const events: any[] = [];
    const result = await runMediatedLoop({
      systemPrompt: "Test",
      userPrompt: "Analyze.",
      config: {
        baseURL: `http://localhost:${port}`,
        apiKey: "",
        model: "test-model",
        cwd: tmpDir,
        role: "builder",
        temperature: 0,
        maxIterations: 4,
        onEvent: (e) => events.push(e),
      },
      toolContext: createMockContext(tmpDir),
    });

    assert.equal(result.iterations, 2);
    assert.ok(requestBodies.length >= 2);
    const secondMessages = requestBodies[1]?.messages ?? [];
    assert.ok(
      secondMessages.some(
        (msg: any) => msg.role === "user" && typeof msg.content === "string" && msg.content.startsWith("continue"),
      ),
      "expected second model call to include a continue nudge",
    );
    assert.ok(
      events.some(
        (event) => event.kind === "status" && typeof event.text === "string" && event.text.includes("continue"),
      ),
      "expected emitted status event to show injected continue nudge",
    );
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop handles finish tool call and terminates", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));

  const ndjsonLines = [
    makeToolCallChunk({
      id: "call_1",
      name: "finish",
      args: { summary: "analysis complete", result: '{"ok":true}' },
    }),
    DONE_LINE,
  ];
  const { server, port } = await createMockServer(ndjsonLines);

  try {
    const events: any[] = [];
    const result = await runMediatedLoop({
      systemPrompt: "Test",
      userPrompt: "Analyze.",
      config: {
        baseURL: `http://localhost:${port}`,
        apiKey: "",
        model: "test-model",
        cwd: tmpDir,
        temperature: 0,
        maxIterations: 3,
        onEvent: (e) => events.push(e),
      },
      toolContext: createMockContext(tmpDir),
    });

    assert.equal(result.iterations, 1);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "finish");

    const completeEvents = events.filter(e => e.kind === "complete");
    assert.ok(completeEvents.length > 0);
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop executes tools and feeds results back in multi-step flow", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));
  await writeFile(path.join(tmpDir, "hello.txt"), "Hello from file", "utf-8");

  let requestCount = 0;
  const server = await new Promise<{ server: Server; port: number }>((resolve) => {
    const srv = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/api/chat")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          requestCount++;
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });

          if (requestCount === 1) {
            res.write(makeToolCallChunk({
              id: "call_1",
              name: "read_file",
              args: { path: "hello.txt" },
            }) + "\n");
            res.write(DONE_LINE + "\n");
          } else {
            res.write(makeToolCallChunk({
              id: "call_2",
              name: "finish",
              args: { summary: "read file", result: '{"content":"found"}' },
            }) + "\n");
            res.write(DONE_LINE + "\n");
          }
          res.end();
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    srv.listen(0, () => resolve({ server: srv, port: (srv.address() as any).port }));
  });

  const resolvedServer = await server;
  try {
    const events: any[] = [];
    const result = await runMediatedLoop({
      systemPrompt: "Test",
      userPrompt: "Read hello.txt and report.",
      config: {
        baseURL: `http://localhost:${resolvedServer.port}`,
        apiKey: "",
        model: "test-model",
        cwd: tmpDir,
        temperature: 0,
        maxIterations: 5,
        onEvent: (e) => events.push(e),
      },
      toolContext: createMockContext(tmpDir),
    });

    assert.equal(requestCount, 2);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, "read_file");
    assert.equal(result.toolCalls[1].name, "finish");

    const toolResults = events.filter(e => e.kind === "tool_result");
    assert.ok(toolResults.length > 0);
    assert.ok(toolResults[0].result.output.includes("Hello from file"));
  } finally {
    resolvedServer.server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop requires builder role to finish through the tool interface", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));

  let requestCount = 0;
  const server = await new Promise<{ server: Server; port: number }>((resolve) => {
    const srv = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/api/chat")) {
        req.on("data", () => {});
        req.on("end", () => {
          requestCount++;
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });

          if (requestCount === 1) {
            res.write(makeTextChunk('{"summary":"done","filesChanged":["src/app.ts"]}') + "\n");
          } else {
            res.write(makeToolCallChunk({
              id: "call_finish",
              name: "finish",
              args: { summary: "done", result: '{"summary":"done","filesChanged":["src/app.ts"]}' },
            }) + "\n");
          }

          res.write(DONE_LINE + "\n");
          res.end();
        });
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    srv.listen(0, () => {
      resolve({ server: srv, port: (srv.address() as any).port });
    });
  });

  try {
    const result = await runMediatedLoop({
      systemPrompt: "You are a builder.",
      userPrompt: "Make a change.",
      config: {
        baseURL: `http://localhost:${server.port}`,
        apiKey: "",
        model: "test-model",
        cwd: tmpDir,
        role: "builder",
        temperature: 0,
        maxIterations: 3,
      },
      toolContext: createMockContext(tmpDir),
    });

    assert.equal(requestCount, 2);
    assert.equal(result.iterations, 2);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "finish");
  } finally {
    server.server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop supports direct-chat style builder history with tool completion", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));
  await writeFile(path.join(tmpDir, "package.json"), '{"name":"direct-chat-check"}', "utf-8");

  let requestCount = 0;
  const server = await new Promise<{ server: Server; port: number }>((resolve) => {
    const srv = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/api/chat")) {
        req.on("data", () => {});
        req.on("end", () => {
          requestCount++;
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });

          if (requestCount === 1) {
            res.write(makeToolCallChunk({
              id: "call_1",
              name: "read_file",
              args: { path: "package.json" },
            }) + "\n");
          } else {
            res.write(makeToolCallChunk({
              id: "call_2",
              name: "finish",
              args: { summary: "read package", result: '{"ok":true,"mode":"direct-chat"}' },
            }) + "\n");
          }

          res.write(DONE_LINE + "\n");
          res.end();
        });
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    srv.listen(0, () => {
      resolve({ server: srv, port: (srv.address() as any).port });
    });
  });

  try {
    const result = await runMediatedLoop({
      systemPrompt: "You are the Local Builder.",
      userPrompt: "",
      messages: [
        { role: "system", content: "You are the Local Builder. Help the user with their coding task in the current repository. Use the tools available to inspect and modify code." },
        { role: "user", content: "Please inspect package.json and tell me what you found." },
      ],
      config: {
        baseURL: `http://localhost:${server.port}`,
        apiKey: "",
        model: "test-model",
        cwd: tmpDir,
        role: "builder",
        temperature: 0,
        maxIterations: 3,
      },
      toolContext: createMockContext(tmpDir),
    });

    assert.equal(requestCount, 2);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, "read_file");
    assert.equal(result.toolCalls[1].name, "finish");
    assert.match(result.text, /"mode":"direct-chat"/);
  } finally {
    server.server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop preserves Anthropic tool_use/tool_result transcript across mediated iterations", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-anthropic-loop-"));
  const requestBodies: any[] = [];
  const { server, port } = await createAnthropicMockServer([
    () => makeAnthropicToolUseSse({
      id: "tool_remote_1",
      name: "write_file",
      input: { path: "hello.txt", content: "Hello from Anthropic" },
      prefaceText: "Writing the file now.",
    }),
    (body) => {
      const messages = body.messages as any[];
      assert.equal(messages.length >= 3, true);

      const assistantToolMessage = messages.find((msg) =>
        msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some((block: any) => block.type === "tool_use" && block.name === "write_file"),
      );
      assert.ok(assistantToolMessage);

      const toolUseBlock = assistantToolMessage.content.find((block: any) => block.type === "tool_use");
      assert.deepEqual(toolUseBlock.input, { path: "hello.txt", content: "Hello from Anthropic" });

      const toolResultMessage = messages.find((msg) =>
        msg.role === "user" && Array.isArray(msg.content) && msg.content.some((block: any) => block.type === "tool_result"),
      );
      assert.ok(toolResultMessage);

      const toolResultBlock = toolResultMessage.content.find((block: any) => block.type === "tool_result");
      assert.equal(toolResultBlock.tool_use_id, toolUseBlock.id);
      assert.match(toolResultBlock.content, /Wrote file|hello\.txt/i);

      return makeAnthropicToolUseSse({
        id: "tool_remote_2",
        name: "finish",
        input: { summary: "done", result: "{\"ok\":true}" },
      });
    },
  ], requestBodies);

  try {
    const result = await runMediatedLoop({
      systemPrompt: "You are a coder.",
      userPrompt: "Write hello.txt and finish.",
      config: {
        baseURL: `http://localhost:${port}`,
        apiKey: "test-key",
        apiBackend: "anthropic",
        model: "glm-5.1",
        cwd: tmpDir,
        role: "coder",
        temperature: 0,
        maxIterations: 4,
      },
      toolContext: createMockContext(tmpDir),
    });

    assert.equal(result.iterations, 2);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, "write_file");
    assert.equal(result.toolCalls[1].name, "finish");
    assert.equal(await (await import("node:fs/promises")).readFile(path.join(tmpDir, "hello.txt"), "utf8"), "Hello from Anthropic");
    assert.equal(requestBodies.length, 2);
    assert.equal(requestBodies[0].model, "glm-5.1");
    assert.ok(Array.isArray(requestBodies[0].tools));
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop executes strict JSON tool-call text fallback", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));
  await writeFile(path.join(tmpDir, "hello.txt"), "Hello from json fallback", "utf-8");

  let requestCount = 0;
  const server = await new Promise<{ server: Server; port: number }>((resolve) => {
    const srv = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/api/chat")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          requestCount++;
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });

          if (requestCount === 1) {
            res.write(makeTextChunk('{"tool_name":"read_file","arguments":{"path":"hello.txt"}}') + "\n");
            res.write(DONE_LINE + "\n");
          } else {
            res.write(makeToolCallChunk({
              id: "call_2",
              name: "finish",
              args: { summary: "done", result: '{"ok":true}' },
            }) + "\n");
            res.write(DONE_LINE + "\n");
          }
          res.end();
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    srv.listen(0, () => resolve({ server: srv, port: (srv.address() as any).port }));
  });

  const resolvedServer = await server;
  try {
    const result = await runMediatedLoop({
      systemPrompt: "Test",
      userPrompt: "Read hello.txt and report.",
      config: {
        baseURL: `http://localhost:${resolvedServer.port}`,
        apiKey: "",
        model: "test-model",
        cwd: tmpDir,
        temperature: 0,
        maxIterations: 5,
      },
      toolContext: createMockContext(tmpDir),
    });

    assert.equal(requestCount, 2);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, "read_file");
    assert.equal(result.toolCalls[1].name, "finish");
  } finally {
    resolvedServer.server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop executes batched JSON tool-call payloads", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));

  const ndjsonLines = [
    makeTextChunk('{"tool_calls":[{"name":"list_dir","arguments":{"path":"."}},{"name":"finish","arguments":{"summary":"done","result":"{\\"ok\\":true}"}}]}'),
    DONE_LINE,
  ];
  const { server, port } = await createMockServer(ndjsonLines);

  try {
    const result = await runMediatedLoop({
      systemPrompt: "Test",
      userPrompt: "List the directory then finish.",
      config: {
        baseURL: `http://localhost:${port}`,
        apiKey: "",
        model: "test-model",
        cwd: tmpDir,
        temperature: 0,
        maxIterations: 3,
      },
      toolContext: createMockContext(tmpDir),
    });

    assert.equal(result.iterations, 1);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, "list_dir");
    assert.equal(result.toolCalls[1].name, "finish");
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop handles model connection error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));

  try {
    await assert.rejects(
      () =>
        runMediatedLoop({
          systemPrompt: "Test",
          userPrompt: "Test.",
          config: {
            baseURL: "http://localhost:19999",
            apiKey: "",
            model: "test-model",
            cwd: tmpDir,
            temperature: 0,
            maxIterations: 3,
          },
          toolContext: createMockContext(tmpDir),
        }),
      (err: any) => err.name === "ModelConnectionError"
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop rejects non-JSON text response", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));

  const ndjsonLines = [
    makeTextChunk("I'm done! Here are my results."),
    DONE_LINE,
  ];
  const { server, port } = await createMockServer(ndjsonLines);

  try {
    // Non-JSON text should be fed back asking for finish
    // With maxIterations=1 it should fail since the text isn't valid JSON
    await assert.rejects(
      () =>
        runMediatedLoop({
          systemPrompt: "Test",
          userPrompt: "Do something.",
          config: {
            baseURL: `http://localhost:${port}`,
            apiKey: "",
            model: "test-model",
            cwd: tmpDir,
            temperature: 0,
            maxIterations: 1,
          },
          toolContext: createMockContext(tmpDir),
        }),
      (err: any) => err.name === "StagnationError"
    );
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loop aborts repeated assistant text spirals", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));
  const repeated =
    "The diff has a critical syntax error in AppQueryClientWithListener.tsx:\n\n" +
    "-  return (\n+  return (n (\n\n" +
    "The line return (n ( is invalid JSX/TypeScript syntax. It will cause a compilation error. This must be return (.";

  const ndjsonLines = [
    makeTextChunk(`${repeated}\n\n`),
    makeTextChunk(`${repeated}\n\n`),
    makeTextChunk(`${repeated}\n\n`),
    makeTextChunk(`${repeated}\n\n`),
    DONE_LINE,
  ];
  const { server, port } = await createMockServer(ndjsonLines);

  try {
    await assert.rejects(
      () =>
        runMediatedLoop({
          systemPrompt: "Test",
          userPrompt: "Review this diff.",
          config: {
            baseURL: `http://localhost:${port}`,
            apiKey: "",
            model: "test-model",
            cwd: tmpDir,
            temperature: 0,
            maxIterations: 5,
            role: "reviewer",
          },
          toolContext: createMockContext(tmpDir),
        }),
      (err: any) => err.name === "StagnationError" && /Repeated assistant text/.test(err.message)
    );
  } finally {
    server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});
