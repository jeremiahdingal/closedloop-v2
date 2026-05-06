import test from "node:test";
import assert from "node:assert/strict";
import { StreamParser, parseNDJSONLines } from "../stream-parser.ts";

function makeToolCallNDJSON(opts: {
  index: number;
  name: string;
  args: Record<string, unknown>;
}): string {
  const toolCalls: { function: { name: string; arguments: Record<string, unknown> } }[] = [];
  toolCalls[opts.index] = { function: { name: opts.name, arguments: opts.args } };
  return JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "",
      tool_calls: toolCalls.filter(Boolean),
    },
    done: false,
  });
}

function makeTextNDJSON(text: string): string {
  return JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: text,
    },
    done: false,
  });
}

function makeDoneNDJSON(opts?: { promptEvalCount?: number; evalCount?: number }): string {
  return JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content: "" },
    done: true,
    total_duration: 1_000_000_000,
    prompt_eval_count: opts?.promptEvalCount,
    eval_count: opts?.evalCount,
  });
}

test("StreamParser accumulates text content", () => {
  const parser = new StreamParser();

  parser.feed(makeTextNDJSON("Hello "));
  parser.feed(makeTextNDJSON("world"));
  parser.feed(makeDoneNDJSON());

  const state = parser.drain();
  assert.equal(state.content, "Hello world");
  assert.equal(state.done, true);
  assert.equal(state.toolCalls.length, 0);
});

test("StreamParser handles complete tool call in single chunk", () => {
  const parser = new StreamParser();

  parser.feed(makeToolCallNDJSON({
    index: 0,
    name: "read_file",
    args: { path: "src/index.ts" },
  }));
  parser.feed(makeDoneNDJSON());

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].id, "call_0");
  assert.equal(state.toolCalls[0].name, "read_file");
  const args = JSON.parse(state.toolCalls[0].arguments);
  assert.equal(args.path, "src/index.ts");
});

test("StreamParser handles multiple tool calls in one chunk", () => {
  const parser = new StreamParser();

  const chunk = JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        { function: { name: "read_file", arguments: { path: "a.ts" } } },
        { function: { name: "read_file", arguments: { path: "b.ts" } } },
      ],
    },
    done: false,
  });
  parser.feed(chunk);
  parser.feed(makeDoneNDJSON());

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 2);
  assert.equal(state.toolCalls[0].name, "read_file");
  assert.equal(state.toolCalls[1].name, "read_file");
  assert.equal(JSON.parse(state.toolCalls[0].arguments).path, "a.ts");
  assert.equal(JSON.parse(state.toolCalls[1].arguments).path, "b.ts");
});

test("StreamParser handles thinking tags", () => {
  const parser = new StreamParser();

  parser.feed(makeTextNDJSON("<thinkLet me think..."));
  parser.feed(makeTextNDJSON(" OK"));
  parser.feed(makeTextNDJSON("</thinkDone"));
  parser.feed(makeDoneNDJSON());

  const state = parser.drain();
  assert.equal(state.thinking, "Let me think... OK");
  assert.equal(state.content, "Done");
});

test("StreamParser handles native thinking field", () => {
  const parser = new StreamParser();

  parser.feed(JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "The answer is 42",
      thinking: "I need to calculate...",
    },
    done: false,
  }));
  parser.feed(JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "",
      thinking: " then verify.",
    },
    done: false,
  }));
  parser.feed(makeDoneNDJSON());

  const state = parser.drain();
  assert.equal(state.thinking, "I need to calculate... then verify.");
  assert.equal(state.content, "The answer is 42");
});

test("StreamParser handles done flag", () => {
  const parser = new StreamParser();
  assert.equal(parser.isDone(), false);

  parser.feed(makeDoneNDJSON());
  assert.equal(parser.isDone(), true);
});

test("StreamParser handles arguments that are incomplete JSON", () => {
  const parser = new StreamParser();

  // Arguments that are incomplete (missing closing brace)
  const incompleteArgs = '{"path":"test.ts"';
  const ndjson = JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        function: { name: "write_file", arguments: incompleteArgs },
      }],
    },
    done: false,
  });
  parser.feed(ndjson);
  parser.feed(makeDoneNDJSON());

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 1, "should have 1 tool call");
  // The repair should close the JSON
  const args = JSON.parse(state.toolCalls[0].arguments);
  assert.equal(args.path, "test.ts");
});

test("StreamParser captures usage from done line", () => {
  const parser = new StreamParser();

  parser.feed(makeTextNDJSON("hi"));
  parser.feed(makeDoneNDJSON({ promptEvalCount: 10, evalCount: 5 }));

  const state = parser.drain();
  assert.ok(state.usage);
  assert.equal(state.usage!.promptTokens, 10);
  assert.equal(state.usage!.completionTokens, 5);
  assert.equal(state.usage!.totalTokens, 15);
});

test("StreamParser reset clears state", () => {
  const parser = new StreamParser();

  parser.feed(makeTextNDJSON("hello"));
  parser.reset();

  const state = parser.drain();
  assert.equal(state.content, "");
  assert.equal(state.toolCalls.length, 0);
  assert.equal(state.done, false);
});

test("parseNDJSONLines extracts non-empty lines", () => {
  const lines = parseNDJSONLines(`{"message":{"content":"hello"}}
{"message":{"content":"world"}}

`);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("hello"));
  assert.ok(lines[1].includes("world"));
});

test("StreamParser handles text-only response (no tool calls)", () => {
  const parser = new StreamParser();

  parser.feed(makeTextNDJSON('{"ok": true}'));
  parser.feed(makeDoneNDJSON());

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 0);
  assert.ok(state.content.includes("ok"));
});

test("StreamParser handles finish tool call", () => {
  const parser = new StreamParser();

  parser.feed(makeToolCallNDJSON({
    index: 0,
    name: "finish",
    args: { summary: "All done", result: '{"tickets":[]}' },
  }));
  parser.feed(makeDoneNDJSON());

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].name, "finish");
  const args = JSON.parse(state.toolCalls[0].arguments);
  assert.equal(args.summary, "All done");
});

test("StreamParser handles tool calls with split arguments", () => {
  const parser = new StreamParser();

  // Part 1: tool call with partial args
  parser.feed(JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        function: { name: "read_file", arguments: { path: "src/" } },
      }],
    },
    done: false,
  }));

  // Part 2: same tool call with more args (appended)
  parser.feed(JSON.stringify({
    model: "test",
    created_at: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        function: { name: "read_file", arguments: { path: "src/index.ts" } },
      }],
    },
    done: false,
  }));
  parser.feed(makeDoneNDJSON());

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].name, "read_file");
});
