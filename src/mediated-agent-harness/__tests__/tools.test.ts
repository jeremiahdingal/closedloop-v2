import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WORKSPACE_TOOLS, TOOL_ALIASES, executeToolCall } from "../tools.ts";
import type { ToolExecutionContext } from "../types.ts";

function createMockContext(cwd: string): ToolExecutionContext {
  return {
    cwd,
    workspaceId: "test-ws",
    allowedPaths: ["*"],
    readFiles: async (paths: string[]) => {
      const result: Record<string, string> = {};
      for (const p of paths) {
        try {
          result[p] = await readFile(path.join(cwd, p), "utf-8");
        } catch {
          // file not found
        }
      }
      return result;
    },
    writeFiles: async (files) => {
      for (const f of files) {
        const fullPath = path.join(cwd, f.path);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, f.content, "utf-8");
      }
    },
    gitDiff: async () => "",
    gitStatus: async () => "",
    runNamedCommand: async (name: string) => ({
      stdout: `output of ${name}`,
      stderr: "",
      exitCode: 0,
    }),
    saveArtifact: async (opts) => {
      const artifactDir = path.join(cwd, ".artifacts");
      await mkdir(artifactDir, { recursive: true });
      const artifactPath = path.join(artifactDir, `${opts.name}.txt`);
      await writeFile(artifactPath, opts.content, "utf-8");
      return artifactPath;
    },
    readArtifact: async (opts) => {
      const artifactDir = path.join(cwd, ".artifacts");
      const name = opts.name ?? "default";
      try {
        return await readFile(path.join(artifactDir, `${name}.txt`), "utf-8");
      } catch {
        return null;
      }
    },
    getAvailableCommands: () => ["test", "lint", "typecheck"],
  };
}

// ─── Tool definitions ───────────────────────────────────────────────────────

test("WORKSPACE_TOOLS has 20 tools including finish and web_search", () => {
  assert.equal(WORKSPACE_TOOLS.length, 20);
  const names = WORKSPACE_TOOLS.map(t => t.function.name);
  assert.ok(names.includes("finish"));
  assert.ok(names.includes("glob_files"));
  assert.ok(names.includes("list_dir"));
  assert.ok(names.includes("read_artifact"));
  assert.ok(names.includes("git_diff"));
  assert.ok(names.includes("git_diff_staged"));
  assert.ok(names.includes("web_search"));
});

test("All tool definitions have valid OpenAI format", () => {
  for (const tool of WORKSPACE_TOOLS) {
    assert.equal(tool.type, "function");
    assert.ok(tool.function.name);
    assert.ok(tool.function.description);
    assert.equal(tool.function.parameters.type, "object");
    assert.ok(tool.function.parameters.properties);
    assert.equal(tool.function.parameters.additionalProperties, false);
  }
});

// ─── Alias tests ────────────────────────────────────────────────────────────

test("TOOL_ALIASES maps correctly", () => {
  assert.equal(TOOL_ALIASES.ls, "glob_files");
  assert.equal(TOOL_ALIASES.find, "glob_files");
  assert.equal(TOOL_ALIASES.cat, "read_file");
  assert.equal(TOOL_ALIASES.head, "read_file");
  assert.equal(TOOL_ALIASES.tail, "read_file");
  assert.equal(TOOL_ALIASES.bash, "run_command");
  assert.equal(TOOL_ALIASES.sh, "run_command");
  assert.equal(TOOL_ALIASES.touch, "write_file");
});

// ─── Tool execution tests ───────────────────────────────────────────────────

test("read_file reads a file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  try {
    await writeFile(path.join(tmpDir, "hello.txt"), "Hello World", "utf-8");

    const result = await executeToolCall(
      { id: "call_1", name: "read_file", args: { path: "hello.txt" } },
      ctx
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.output, "Hello World");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("read_file returns error for missing file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  try {
    const result = await executeToolCall(
      { id: "call_1", name: "read_file", args: { path: "missing.txt" } },
      ctx
    );

    assert.equal(result.isError, true);
    assert.ok(result.output.includes("not found"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("write_file writes a file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  try {
    const result = await executeToolCall(
      { id: "call_1", name: "write_file", args: { path: "output.txt", content: "test" } },
      ctx
    );

    assert.equal(result.isError, undefined);
    const content = await readFile(path.join(tmpDir, "output.txt"), "utf-8");
    assert.equal(content, "test");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("write_file blocks .git writes", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  try {
    const result = await executeToolCall(
      { id: "call_1", name: "write_file", args: { path: ".git/config", content: "x" } },
      ctx
    );

    assert.equal(result.isError, true);
    assert.ok(result.output.includes("forbidden"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("list_dir lists directory contents", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  try {
    await writeFile(path.join(tmpDir, "a.txt"), "a", "utf-8");
    await writeFile(path.join(tmpDir, "b.txt"), "b", "utf-8");
    await mkdir(path.join(tmpDir, "subdir"));

    const result = await executeToolCall(
      { id: "call_1", name: "list_dir", args: {} },
      ctx
    );

    assert.equal(result.isError, undefined);
    assert.ok(result.output.includes("subdir/"));
    assert.ok(result.output.includes("a.txt"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("read_files reads multiple files", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  try {
    await writeFile(path.join(tmpDir, "a.txt"), "aaa", "utf-8");
    await writeFile(path.join(tmpDir, "b.txt"), "bbb", "utf-8");

    const result = await executeToolCall(
      { id: "call_1", name: "read_files", args: { paths: ["a.txt", "b.txt"] } },
      ctx
    );

    assert.equal(result.isError, undefined);
    assert.ok(result.output.includes("aaa"));
    assert.ok(result.output.includes("bbb"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("save_artifact saves an artifact", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  try {
    const result = await executeToolCall(
      { id: "call_1", name: "save_artifact", args: { name: "report", content: "# Report\nDone" } },
      ctx
    );

    assert.equal(result.isError, undefined);
    const content = await readFile(path.join(tmpDir, ".artifacts", "report.txt"), "utf-8");
    assert.equal(content, "# Report\nDone");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("finish tool returns args as JSON", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  const result = await executeToolCall(
    { id: "call_1", name: "finish", args: { summary: "done", result: '{"ok":true}' } },
    ctx
  );

  assert.equal(result.isError, false);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.summary, "done");

  await rm(tmpDir, { recursive: true, force: true });
});

test("unknown tool returns error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  const result = await executeToolCall(
    { id: "call_1", name: "nonexistent", args: {} },
    ctx
  );

  assert.equal(result.isError, true);
  assert.ok(result.output.includes("Unknown tool"));

  await rm(tmpDir, { recursive: true, force: true });
});

test("run_command executes whitelisted command", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  const result = await executeToolCall(
    { id: "call_1", name: "run_command", args: { name: "test" } },
    ctx
  );

  assert.equal(result.isError, false);
  assert.equal(result.output, "output of test");

  await rm(tmpDir, { recursive: true, force: true });
});

test("run_command rejects command names outside workspace availability", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  const result = await executeToolCall(
    { id: "call_1", name: "run_command", args: { name: "install" } },
    ctx
  );

  assert.equal(result.isError, true);
  assert.ok(result.output.includes("not available"));

  await rm(tmpDir, { recursive: true, force: true });
});

test("read_context_packet reads context.json", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  try {
    await writeFile(path.join(tmpDir, "context.json"), '{"ticket":"T-123"}', "utf-8");

    const result = await executeToolCall(
      { id: "call_1", name: "read_context_packet", args: {} },
      ctx
    );

    assert.equal(result.isError, undefined);
    assert.ok(result.output.includes("T-123"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("read_context_packet returns message when not found", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  const result = await executeToolCall(
    { id: "call_1", name: "read_context_packet", args: {} },
    ctx
  );

  assert.equal(result.isError, undefined);
  assert.ok(result.output.includes("no context.json"));

  await rm(tmpDir, { recursive: true, force: true });
});

test("web_search returns error when no API key", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);
  delete process.env.BRAVE_API_KEY;

  const result = await executeToolCall(
    { id: "call_1", name: "web_search", args: { query: "test" } },
    ctx
  );

  assert.equal(result.isError, true);
  assert.ok(result.output.includes("not configured"));

  await rm(tmpDir, { recursive: true, force: true });
});

test("web_search returns error with empty query", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediated-test-"));
  const ctx = createMockContext(tmpDir);

  const result = await executeToolCall(
    { id: "call_1", name: "web_search", args: { query: "" } },
    ctx
  );

  assert.equal(result.isError, true);
  assert.ok(result.output.includes("query is required"));

  await rm(tmpDir, { recursive: true, force: true });
});
