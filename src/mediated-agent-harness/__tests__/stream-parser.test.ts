import test from "node:test";
import assert from "node:assert/strict";
import { StreamParser, parseSSELines } from "../stream-parser.ts";

function makeToolCallSSE(opts: {
  index: number;
  id: string;
  name: string;
  args: Record<string, unknown>;
}): string {
  const obj = {
    choices: [{
      delta: {
        tool_calls: [{
          index: opts.index,
          id: opts.id,
          type: "function",
          function: {
            name: opts.name,
            arguments: JSON.stringify(opts.args),
          },
        }],
      },
    }],
  };
  return `data: ${JSON.stringify(obj)}`;
}

test("StreamParser accumulates text content", () => {
  const parser = new StreamParser();

  parser.feed('data: {"choices":[{"delta":{"content":"Hello "}}]}');
  parser.feed('data: {"choices":[{"delta":{"content":"world"}}]}');
  parser.feed("data: [DONE]");

  const state = parser.drain();
  assert.equal(state.content, "Hello world");
  assert.equal(state.done, true);
  assert.equal(state.toolCalls.length, 0);
});

test("StreamParser handles complete tool call in single chunk", () => {
  const parser = new StreamParser();

  parser.feed(makeToolCallSSE({
    index: 0,
    id: "call_1",
    name: "read_file",
    args: { path: "src/index.ts" },
  }));
  parser.feed("data: [DONE]");

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].id, "call_1");
  assert.equal(state.toolCalls[0].name, "read_file");
  const args = JSON.parse(state.toolCalls[0].arguments);
  assert.equal(args.path, "src/index.ts");
});

test("StreamParser handles multiple tool calls in one chunk", () => {
  const parser = new StreamParser();

  const chunk = {
    choices: [{
      delta: {
        tool_calls: [
          {
            index: 0, id: "call_1", type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
          },
          {
            index: 1, id: "call_2", type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "b.ts" }) },
          },
        ],
      },
    }],
  };
  parser.feed(`data: ${JSON.stringify(chunk)}`);
  parser.feed("data: [DONE]");

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 2);
  assert.equal(state.toolCalls[0].name, "read_file");
  assert.equal(state.toolCalls[1].name, "read_file");
  assert.equal(JSON.parse(state.toolCalls[0].arguments).path, "a.ts");
  assert.equal(JSON.parse(state.toolCalls[1].arguments).path, "b.ts");
});

test("StreamParser handles thinking tags", () => {
  const parser = new StreamParser();

  parser.feed('data: {"choices":[{"delta":{"content":"<think>Let me think..."}}]}');
  parser.feed('data: {"choices":[{"delta":{"content":" OK"}}]}');
  parser.feed('data: {"choices":[{"delta":{"content":"</think>Done"}}]}');
  parser.feed("data: [DONE]");

  const state = parser.drain();
  assert.equal(state.thinking, "Let me think... OK");
  assert.equal(state.content, "Done");
});

test("StreamParser handles [DONE] sentinel", () => {
  const parser = new StreamParser();
  assert.equal(parser.isDone(), false);

  parser.feed("data: [DONE]");
  assert.equal(parser.isDone(), true);
});

test("StreamParser handles arguments that are incomplete JSON", () => {
  const parser = new StreamParser();

  // Arguments that are incomplete (missing closing brace)
  const incompleteArgs = '{"path":"test.ts"';
  const sseJson = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_1",
          function: { name: "write_file", arguments: incompleteArgs },
        }],
      },
    }],
  });
  parser.feed(`data: ${sseJson}`);
  parser.feed("data: [DONE]");

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 1, "should have 1 tool call");
  // The repair should close the JSON
  const args = JSON.parse(state.toolCalls[0].arguments);
  assert.equal(args.path, "test.ts");
});

test("StreamParser captures usage", () => {
  const parser = new StreamParser();

  parser.feed(
    'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"promptTokens":10,"completionTokens":5,"totalTokens":15}}'
  );
  parser.feed("data: [DONE]");

  const state = parser.drain();
  assert.ok(state.usage);
  assert.equal(state.usage.promptTokens, 10);
  assert.equal(state.usage.completionTokens, 5);
});

test("StreamParser reset clears state", () => {
  const parser = new StreamParser();

  parser.feed('data: {"choices":[{"delta":{"content":"hello"}}]}');
  parser.reset();

  const state = parser.drain();
  assert.equal(state.content, "");
  assert.equal(state.toolCalls.length, 0);
  assert.equal(state.done, false);
});

test("StreamParser ignores non-data lines", () => {
  const parser = new StreamParser();

  parser.feed(": comment line");
  parser.feed("event: message");
  parser.feed('data: {"choices":[{"delta":{"content":"ok"}}]}');
  parser.feed("data: [DONE]");

  const state = parser.drain();
  assert.equal(state.content, "ok");
});

test("parseSSELines extracts data lines", () => {
  const lines = parseSSELines(`
data: {"choices":[{"delta":{"content":"hello"}}]}

data: [DONE]
  `);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("hello"));
  assert.equal(lines[1], "data: [DONE]");
});

test("StreamParser handles text-only response (no tool calls)", () => {
  const parser = new StreamParser();

  parser.feed('data: {"choices":[{"delta":{"content":"{\\"ok\\": true}"}}]}');
  parser.feed("data: [DONE]");

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 0);
  assert.ok(state.content.includes("ok"));
});

test("StreamParser handles finish tool call", () => {
  const parser = new StreamParser();

  parser.feed(makeToolCallSSE({
    index: 0,
    id: "call_finish",
    name: "finish",
    args: { summary: "All done", result: '{"tickets":[]}' },
  }));
  parser.feed("data: [DONE]");

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].name, "finish");
  const args = JSON.parse(state.toolCalls[0].arguments);
  assert.equal(args.summary, "All done");
});

test("StreamParser handles arguments streamed in two parts", () => {
  const parser = new StreamParser();

  // Part 1: announce tool call with first half of arguments
  const part1 = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":' },
        }],
      },
    }],
  };
  parser.feed(`data: ${JSON.stringify(part1)}`);

  // Part 2: second half of arguments
  const part2 = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: '"src/index.ts"}' },
        }],
      },
    }],
  };
  parser.feed(`data: ${JSON.stringify(part2)}`);
  parser.feed("data: [DONE]");

  const state = parser.drain();
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].name, "read_file");
  const args = JSON.parse(state.toolCalls[0].arguments);
  assert.equal(args.path, "src/index.ts");
});
