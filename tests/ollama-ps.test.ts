import test from "node:test";
import assert from "node:assert/strict";
import { parseOllamaPsOutput } from "../src/apps/ollama-ps.ts";

test("parseOllamaPsOutput parses running ollama models", () => {
  const models = parseOllamaPsOutput(`NAME                      ID              SIZE     PROCESSOR          CONTEXT    UNTIL
batiai/qwen3.6-27b:iq4    cee2e6461ff3    19 GB    22%/78% CPU/GPU    6144       4 minutes from now
qwen3.5:9b                123456789abc    6 GB     100% CPU           4096       2 minutes from now`);

  assert.deepEqual(models, [
    {
      name: "batiai/qwen3.6-27b:iq4",
      id: "cee2e6461ff3",
      size: "19 GB",
      processor: "22%/78% CPU/GPU",
      context: "6144",
      until: "4 minutes from now",
    },
    {
      name: "qwen3.5:9b",
      id: "123456789abc",
      size: "6 GB",
      processor: "100% CPU",
      context: "4096",
      until: "2 minutes from now",
    },
  ]);
});

test("parseOllamaPsOutput returns no models for header-only output", () => {
  const models = parseOllamaPsOutput(`NAME                      ID              SIZE     PROCESSOR          CONTEXT    UNTIL`);
  assert.deepEqual(models, []);
});
