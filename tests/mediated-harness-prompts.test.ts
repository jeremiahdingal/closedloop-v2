import test from "node:test";
import assert from "node:assert/strict";
import { getPromptForRole } from "../src/mediated-agent-harness/prompts.ts";

test("native role prompts do not instruct XML tool calling", () => {
  const prompt = getPromptForRole("builder", "/tmp/workspace", "native");

  assert.ok(prompt.includes("Use the native tool-calling interface provided by the runtime."));
  assert.ok(!prompt.includes("Every response MUST contain exactly one XML tool call"));
  assert.ok(!prompt.includes("<function=tool_name>"));
});

test("xml role prompts still instruct XML tool calling", () => {
  const prompt = getPromptForRole("builder", "/tmp/workspace", "xml");

  assert.ok(prompt.includes("Every response MUST contain exactly one XML tool call"));
  assert.ok(prompt.includes("<function=tool_name>"));
});
