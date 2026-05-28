import test from "node:test";
import assert from "node:assert";
import { StreamParser } from "../stream-parser.ts";

test("StreamParser OpenRouter/OpenAI support", async (t) => {
  await t.test("should parse content from OpenAI chunks", () => {
    let streamingText = "";
    const parser = new StreamParser((text, isThinking) => {
      if (!isThinking) streamingText += text;
    });

    parser.feedOpenAI({
      id: "1",
      object: "chat.completion.chunk",
      created: 123,
      model: "test",
      choices: [{
        index: 0,
        delta: { content: "Hello" },
        finish_reason: null
      }]
    } as any);

    assert.strictEqual(streamingText, "Hello");
    
    parser.feedOpenAI({
      id: "1",
      object: "chat.completion.chunk",
      created: 123,
      model: "test",
      choices: [{
        index: 0,
        delta: { content: " world" },
        finish_reason: "stop"
      }]
    } as any);

    assert.strictEqual(streamingText, "Hello world");
    assert.strictEqual(parser.drain().content, "Hello world");
  });

  await t.test("should parse tool calls from OpenAI chunks", () => {
    const parser = new StreamParser();

    parser.feedOpenAI({
      id: "1",
      object: "chat.completion.chunk",
      created: 123,
      model: "test",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "test_tool", arguments: "" }
          }]
        },
        finish_reason: null
      }]
    } as any);

    parser.feedOpenAI({
      id: "1",
      object: "chat.completion.chunk",
      created: 123,
      model: "test",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: '{"foo":' }
          }]
        },
        finish_reason: null
      }]
    } as any);

    parser.feedOpenAI({
      id: "1",
      object: "chat.completion.chunk",
      created: 123,
      model: "test",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: '"bar"}' }
          }]
        },
        finish_reason: "tool_calls"
      }]
    } as any);

    const result = parser.drain();
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].name, "test_tool");
    assert.deepStrictEqual(JSON.parse(result.toolCalls[0].arguments), { foo: "bar" });
  });

  await t.test("should parse reasoning/thinking from OpenAI chunks", () => {
    let thinkingText = "";
    const parser = new StreamParser((text, isThinking) => {
      if (isThinking) thinkingText += text;
    });

    parser.feedOpenAI({
      id: "1",
      object: "chat.completion.chunk",
      created: 123,
      model: "test",
      choices: [{
        index: 0,
        delta: { reasoning_content: "I am thinking..." } as any,
        finish_reason: null
      }]
    } as any);

    assert.strictEqual(thinkingText, "I am thinking...");
  });
});
