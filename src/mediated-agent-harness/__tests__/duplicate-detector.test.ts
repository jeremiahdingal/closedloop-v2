import test from "node:test";
import assert from "node:assert/strict";
import {
  clearDuplicateRecoveryState,
  createDuplicateRecoveryState,
  loadDuplicateRecoveryState,
  persistDuplicateRecoveryState,
} from "../duplicate-detector.ts";

test("duplicate recovery state persists across harness restarts for the same session", () => {
  const sessionKey = "coder:C:/tmp/worktree-123";
  clearDuplicateRecoveryState(sessionKey);

  const initial = createDuplicateRecoveryState();
  initial.bannedSignatures.push({
    toolName: "read_file",
    argsHash: '{"_raw":"{\\"path\\":\\"api/src/services/variants/variant.route.ts\\"}{\\"path\\":\\"api/src/services/variants/variants.service.ts\\"}"}',
    errorMessage: "Invalid JSON arguments",
    errorKind: "VALIDATION",
    bannedAt: Date.now(),
  });
  initial.recoveryCount = 1;
  initial.isInRecovery = true;

  persistDuplicateRecoveryState(sessionKey, initial);

  const restored = loadDuplicateRecoveryState(sessionKey);
  assert.equal(restored.recoveryCount, 1);
  assert.equal(restored.isInRecovery, true);
  assert.equal(restored.bannedSignatures.length, 1);
  assert.equal(restored.bannedSignatures[0].toolName, "read_file");

  restored.recoveryCount = 2;
  persistDuplicateRecoveryState(sessionKey, restored);

  const reloaded = loadDuplicateRecoveryState(sessionKey);
  assert.equal(reloaded.recoveryCount, 2);

  clearDuplicateRecoveryState(sessionKey);
  const cleared = loadDuplicateRecoveryState(sessionKey);
  assert.equal(cleared.recoveryCount, 0);
  assert.equal(cleared.bannedSignatures.length, 0);
});
