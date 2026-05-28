import test from "node:test";
import assert from "node:assert/strict";
import { shouldCompact, resolveCompactionModel } from "../context-budget.ts";
import { resolveModelContextWindow } from "../loop.ts";

test("glm-4.7 uses a 200k context window", () => {
  assert.equal(resolveModelContextWindow("glm-4.7"), 200000);
  assert.equal(resolveModelContextWindow("glm-4.7-flash:q4_K_M"), 200000);
});

test("auto compaction starts at 75 percent usage", () => {
  assert.equal(
    shouldCompact({ windowTokens: 200000, usedTokens: 150000, usedFraction: 0.75 }),
    "summarize"
  );
  assert.equal(
    shouldCompact({ windowTokens: 200000, usedTokens: 149999, usedFraction: 0.749995 }),
    "none"
  );
});

test("glm-4.7 uses itself as the compaction model by default", () => {
  const originalCompactionModel = process.env.COMPACTION_MODEL;
  delete process.env.COMPACTION_MODEL;
  try {
    assert.equal(resolveCompactionModel("glm-4.7"), "glm-4.7");
    assert.equal(resolveCompactionModel("glm-4.7-flash:q4_K_M"), "glm-4.7-flash:q4_K_M");
    assert.equal(resolveCompactionModel("qwen3.5:27b"), "qwen3.5:2b");
  } finally {
    if (originalCompactionModel === undefined) {
      delete process.env.COMPACTION_MODEL;
    } else {
      process.env.COMPACTION_MODEL = originalCompactionModel;
    }
  }
});

test("explicit COMPACTION_MODEL still overrides the default selection", () => {
  const originalCompactionModel = process.env.COMPACTION_MODEL;
  process.env.COMPACTION_MODEL = "custom-compactor";
  try {
    assert.equal(resolveCompactionModel("glm-4.7"), "custom-compactor");
    assert.equal(resolveCompactionModel("qwen3.5:27b"), "custom-compactor");
  } finally {
    if (originalCompactionModel === undefined) {
      delete process.env.COMPACTION_MODEL;
    } else {
      process.env.COMPACTION_MODEL = originalCompactionModel;
    }
  }
});
