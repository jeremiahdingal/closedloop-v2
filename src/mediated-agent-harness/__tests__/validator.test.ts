import test from "node:test";
import assert from "node:assert/strict";
import { CallHistory, validateAndRepair } from "../validator.ts";
import { WORKSPACE_TOOLS } from "../tools.ts";
import { ToolValidationError, StagnationError } from "../errors.ts";

const toolSchemaMap = new Map(WORKSPACE_TOOLS.map(t => [t.function.name, t]));

// ─── Alias remapping tests ──────────────────────────────────────────────────

test("validateAndRepair remaps ls to glob_files", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "ls", arguments: '{"pattern":"src/**/*.ts"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok(!("kind" in result));
  assert.equal(result.name, "glob_files");
});

test("validateAndRepair remaps cat to read_file", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "cat", arguments: '{"path":"src/index.ts"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok(!("kind" in result));
  assert.equal(result.name, "read_file");
});

test("validateAndRepair remaps find to glob_files", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "find", arguments: '{"pattern":"*.json"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok(!("kind" in result));
  assert.equal(result.name, "glob_files");
});

test("validateAndRepair remaps bash to run_command", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "bash", arguments: '{"name":"test"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok(!("kind" in result));
  assert.equal(result.name, "run_command");
});

// ─── Unknown tool tests ─────────────────────────────────────────────────────

test("validateAndRepair rejects unknown tools", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "nonexistent", arguments: '{}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof ToolValidationError);
  assert.ok(result.message.includes("Unknown tool"));
});

// ─── Argument validation tests ──────────────────────────────────────────────

test("validateAndRepair parses valid JSON arguments", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "read_file", arguments: '{"path":"src/index.ts"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok(!("kind" in result));
  assert.deepEqual(result.args, { path: "src/index.ts" });
});

test("validateAndRepair repairs malformed JSON with trailing comma", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "read_file", arguments: '{"path":"src/index.ts",}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok(!("kind" in result));
  assert.equal(result.args.path, "src/index.ts");
});

test("validateAndRepair rejects missing required parameters", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "read_file", arguments: '{}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof ToolValidationError);
  assert.ok(result.message.includes("Missing required parameter"));
});

// ─── Path policy tests ──────────────────────────────────────────────────────

test("validateAndRepair rejects absolute paths", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "read_file", arguments: '{"path":"/etc/passwd"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof ToolValidationError);
  assert.ok(result.message.includes("Absolute paths"));
});

test("validateAndRepair rejects parent traversal", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "read_file", arguments: '{"path":"../../etc/passwd"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof ToolValidationError);
  assert.ok(result.message.includes("Parent traversal"));
});

test("validateAndRepair rejects writes to .git/", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "write_file", arguments: '{"path":".git/config","content":"x"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof ToolValidationError);
  assert.ok(result.message.includes(".git/"));
});

test("validateAndRepair rejects writes to node_modules/", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "write_file", arguments: '{"path":"node_modules/foo","content":"x"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof ToolValidationError);
  assert.ok(result.message.includes("node_modules/"));
});

test("validateAndRepair enforces allowed paths", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "read_file", arguments: '{"path":"other/file.ts"}' },
    toolSchemaMap,
    history,
    ["src/", "tests/"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof ToolValidationError);
  assert.ok(result.message.includes("not allowed"));
});

test("validateAndRepair allows paths within configured prefixes", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "read_file", arguments: '{"path":"src/index.ts"}' },
    toolSchemaMap,
    history,
    ["src/", "tests/"]
  );
  assert.ok(!("kind" in result));
});

// ─── Stagnation detection tests ─────────────────────────────────────────────

test("StagnationError on repeated identical calls", () => {
  const history = new CallHistory();

  // Record 3 identical calls
  for (let i = 0; i < 3; i++) {
    history.record("read_file", { path: "test.ts" }, false);
  }

  const result = validateAndRepair(
    { name: "read_file", arguments: '{"path":"test.ts"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof StagnationError);
  assert.equal(result.reason, "repeated_call");
});

test("StagnationError on 5 consecutive errors", () => {
  const history = new CallHistory();

  for (let i = 0; i < 5; i++) {
    history.record("read_file", { path: `test${i}.ts` }, true);
  }

  const result = validateAndRepair(
    { name: "read_file", arguments: '{"path":"another.ts"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof StagnationError);
  assert.equal(result.reason, "consecutive_errors");
});

test("CallHistory resets consecutive errors on success", () => {
  const history = new CallHistory();

  history.record("read_file", { path: "a.ts" }, true);
  history.record("read_file", { path: "b.ts" }, true);
  history.record("read_file", { path: "c.ts" }, true);
  history.record("read_file", { path: "d.ts" }, false); // success resets
  history.record("read_file", { path: "e.ts" }, true);

  assert.equal(history.getConsecutiveErrors(), 1);
});

test("Distinct calls are not treated as repeated", () => {
  const history = new CallHistory();

  for (let i = 0; i < 10; i++) {
    history.record("read_file", { path: `test${i}.ts` }, false);
  }

  // Should not trigger stagnation
  const result = validateAndRepair(
    { name: "read_file", arguments: '{"path":"new.ts"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok(!("kind" in result));
});

// ─── Type validation tests ──────────────────────────────────────────────────

test("validateAndRepair rejects wrong argument types", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "read_file", arguments: '{"path": 123}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof ToolValidationError);
  assert.ok(result.message.includes("must be a string"));
});

test("validateAndRepair rejects empty tool name", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "", arguments: '{}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok("kind" in result);
  assert.ok(result instanceof ToolValidationError);
  assert.ok(result.message.includes("no name"));
});

test("validateAndRepair trims whitespace from tool name", () => {
  const history = new CallHistory();
  const result = validateAndRepair(
    { name: "  read_file  ", arguments: '{"path":"test.ts"}' },
    toolSchemaMap,
    history,
    ["*"]
  );
  assert.ok(!("kind" in result));
  assert.equal(result.name, "read_file");
});

test("validateAndRepair remaps additional aliases", () => {
  const history = new CallHistory();

  const aliases = [
    { alias: "shell", expected: "run_command" },
    { alias: "exec", expected: "run_command" },
    { alias: "rm", expected: "run_command" },
    { alias: "grep", expected: "grep_files" },
    { alias: "search", expected: "grep_files" },
    { alias: "tree", expected: "list_dir" },
    { alias: "dir", expected: "list_dir" },
    { alias: "search_web", expected: "web_search" },
    { alias: "google", expected: "web_search" },
    { alias: "websearch", expected: "web_search" },
  ];

  for (const { alias, expected } of aliases) {
    const h = new CallHistory();
    const args = expected === "run_command"
      ? '{"name":"test"}'
      : expected === "read_file" ? '{"path":"test.ts"}'
      : expected === "glob_files" ? '{"pattern":"*.ts"}'
      : expected === "grep_files" ? '{"pattern":"foo"}'
      : expected === "list_dir" ? '{}'
      : expected === "web_search" ? '{"query":"test"}'
      : '{}';

    const result = validateAndRepair(
      { name: alias, arguments: args },
      toolSchemaMap,
      h,
      ["*"]
    );
    assert.ok(!("kind" in result), `${alias} should map to ${expected}`);
    assert.equal(result.name, expected, `${alias} -> ${expected}`);
  }
});
