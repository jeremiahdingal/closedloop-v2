import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeProfile, resolveAgentModelInfo, REMOTE_OVERRIDE_DECODER_MODEL, REMOTE_OVERRIDE_MEDIATED_MODEL } from "../src/runtime-profile.ts";

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
