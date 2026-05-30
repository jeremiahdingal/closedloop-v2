import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { resolveRuntimeProfile, resolveAgentModelInfo, REMOTE_OVERRIDE_DECODER_MODEL, REMOTE_OVERRIDE_MEDIATED_MODEL } from "../src/runtime-profile.ts";
import { ZaiRunner } from "../src/orchestration/zai.ts";
import { makeTempDir } from "./helpers.ts";

const baseModels = {
  epicDecoder: "codex-cli",
  builder: "codex-cli",
  explorer: "mediated:qwen3.5:9b",
  coder: "qwen3.5:27b",
  reviewer: "qwen3.5:14b",
  tester: "skip",
  epicReviewer: "qwen3.5:14b",
  playWriter: "zai:glm-5.1",
  playTester: "mediated:qwen3:4b",
  doctor: "qwen3:14b",
  system: "qwen3:8b",
} as const;

test("remote override resolves to the expected runtime profile", () => {
  const profile = resolveRuntimeProfile(baseModels as any, { remoteOverrideEnabled: true });

  assert.equal(profile.remoteOverrideEnabled, true);
  assert.equal(profile.skipExplorer, true);
  assert.equal(profile.skipEpicReview, true);
  assert.equal(profile.autoPlayLoopEnabled, false);
  assert.equal(profile.effectiveModels.epicDecoder, REMOTE_OVERRIDE_DECODER_MODEL);
  assert.equal(profile.effectiveModels.coder, REMOTE_OVERRIDE_MEDIATED_MODEL);
  assert.equal(profile.effectiveModels.reviewer, REMOTE_OVERRIDE_MEDIATED_MODEL);
  assert.equal(profile.roleOverrides.explorer?.effectiveModel, "skipped");
  assert.equal(profile.roleOverrides.epicReviewer?.effectiveModel, "skipped");
});

test("agent model info exposes configured and effective models", () => {
  const info = resolveAgentModelInfo("coder", baseModels as any, { remoteOverrideEnabled: true });

  assert.equal(info.configuredModel, "qwen3.5:27b");
  assert.equal(info.currentModel, "qwen3.5:27b");
  assert.equal(info.effectiveModel, REMOTE_OVERRIDE_MEDIATED_MODEL);
  assert.equal(info.overriddenByProfile, true);
  assert.match(info.overrideReason ?? "", /Remote Override/i);
});

test("zai runner honors explicit modelOverride for remote override decoder routing", async () => {
  const repoRoot = await makeTempDir("zai-override-");
  const launched: string[][] = [];
  const runner = new ZaiRunner({
    apiKey: "test-key",
    spawnImpl: ((command: string, args: string[]) => {
      launched.push([command, ...args]);
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.write('<FINAL_JSON>{"summary":"ok","tickets":[]}</FINAL_JSON>\n');
        child.stdout.end();
        child.emit("close", 0);
      });
      return child as any;
    }) as any,
  });

  const result = await runner.runEpicDecoder({
    role: "epicDecoder",
    cwd: repoRoot,
    prompt: "Decode this epic",
    modelOverride: "zai:glm-5.1",
  });

  assert.equal(result.summary, "ok");
  assert.equal(result.tickets.length, 0);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].includes("glm-5.1"), true);
});
