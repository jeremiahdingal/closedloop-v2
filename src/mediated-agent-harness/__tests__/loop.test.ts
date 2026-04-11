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

function makeSSE(data: object): string {
  return `data: ${JSON.stringify(data)}`;
}

function makeToolCallChunk(opts: {
  id: string;
  name: string;
  args: Record<string, unknown>;
}): string {
  return makeSSE({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: opts.id,
          type: "function",
          function: {
            name: opts.name,
            arguments: JSON.stringify(opts.args),
          },
        }],
      },
    }],
  });
}

function makeTextChunk(text: string): string {
  return makeSSE({ choices: [{ delta: { content: text } }] });
}

function createMockServer(sseLines: string[]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        // Drain the request body
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          let i = 0;
          const send = () => {
            if (i < sseLines.length) {
              res.write(sseLines[i] + "\n");
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

// ─── Tests ──────────────────────────────────────────────────────────────────

test("loop handles model that returns text directly (no tools)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));

  const sseLines = [
    makeTextChunk('{"summary":"done","tickets":[]}'),
    "data: [DONE]",
  ];
  const { server, port } = await createMockServer(sseLines);

  try {
    const events: any[] = [];
    const result = await runMediatedLoop({
      systemPrompt: "You are a test agent.",
      userPrompt: "Do something.",
      config: {
        baseURL: `http://localhost:${port}/v1`,
        apiKey: "test",
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

test("loop handles finish tool call and terminates", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));

  const sseLines = [
    makeToolCallChunk({
      id: "call_1",
      name: "finish",
      args: { summary: "analysis complete", result: '{"ok":true}' },
    }),
    "data: [DONE]",
  ];
  const { server, port } = await createMockServer(sseLines);

  try {
    const events: any[] = [];
    const result = await runMediatedLoop({
      systemPrompt: "Test",
      userPrompt: "Analyze.",
      config: {
        baseURL: `http://localhost:${port}/v1`,
        apiKey: "test",
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
  // We need to create a server that handles each request differently
  const server = await new Promise<{ server: Server; port: number }>((resolve) => {
    const srv = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          requestCount++;
          res.writeHead(200, { "Content-Type": "text/event-stream" });

          if (requestCount === 1) {
            // First request: model calls read_file
            res.write(makeToolCallChunk({
              id: "call_1",
              name: "read_file",
              args: { path: "hello.txt" },
            }) + "\n");
            res.write("data: [DONE]\n");
          } else {
            // Second request: model calls finish
            res.write(makeToolCallChunk({
              id: "call_2",
              name: "finish",
              args: { summary: "read file", result: '{"content":"found"}' },
            }) + "\n");
            res.write("data: [DONE]\n");
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
        baseURL: `http://localhost:${resolvedServer.port}/v1`,
        apiKey: "test",
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

test("loop executes strict JSON tool-call text fallback", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-loop-"));
  await writeFile(path.join(tmpDir, "hello.txt"), "Hello from json fallback", "utf-8");

  let requestCount = 0;
  const server = await new Promise<{ server: Server; port: number }>((resolve) => {
    const srv = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          requestCount++;
          res.writeHead(200, { "Content-Type": "text/event-stream" });

          if (requestCount === 1) {
            res.write(makeTextChunk('{"tool_name":"read_file","arguments":{"path":"hello.txt"}}') + "\n");
            res.write("data: [DONE]\n");
          } else {
            res.write(makeToolCallChunk({
              id: "call_2",
              name: "finish",
              args: { summary: "done", result: '{"ok":true}' },
            }) + "\n");
            res.write("data: [DONE]\n");
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
        baseURL: `http://localhost:${resolvedServer.port}/v1`,
        apiKey: "test",
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

  const sseLines = [
    makeTextChunk('{"tool_calls":[{"name":"list_dir","arguments":{"path":"."}},{"name":"finish","arguments":{"summary":"done","result":"{\\"ok\\":true}"}}]}'),
    "data: [DONE]",
  ];
  const { server, port } = await createMockServer(sseLines);

  try {
    const result = await runMediatedLoop({
      systemPrompt: "Test",
      userPrompt: "List the directory then finish.",
      config: {
        baseURL: `http://localhost:${port}/v1`,
        apiKey: "test",
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
            baseURL: "http://localhost:19999/v1",
            apiKey: "test",
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

  const sseLines = [
    makeTextChunk("I'm done! Here are my results."),
    "data: [DONE]",
  ];
  const { server, port } = await createMockServer(sseLines);

  try {
    // Non-JSON text should be fed back asking for finish
    // With maxIterations=1 it should fail since the text isn't valid JSON
    await assert.rejects(
      () =>
        runMediatedLoop({
          systemPrompt: "Test",
          userPrompt: "Do something.",
          config: {
            baseURL: `http://localhost:${port}/v1`,
            apiKey: "test",
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
