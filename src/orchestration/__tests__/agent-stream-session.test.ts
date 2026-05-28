import test from "node:test";
import assert from "node:assert/strict";
import { AgentStreamSessionRegistry } from "../agent-stream-session.ts";

test("new session invalidates older session for same run and role", () => {
  const registry = new AgentStreamSessionRegistry();

  const first = registry.begin("run_1", "explorer");
  assert.equal(registry.isActive("run_1", "explorer", first), true);

  const second = registry.begin("run_1", "explorer");
  assert.equal(registry.isActive("run_1", "explorer", first), false);
  assert.equal(registry.isActive("run_1", "explorer", second), true);
});

test("ending a session drops late events for that session only", () => {
  const registry = new AgentStreamSessionRegistry();

  const active = registry.begin("run_2", "coder");
  registry.end("run_2", "coder", active);

  assert.equal(registry.isActive("run_2", "coder", active), false);
});
