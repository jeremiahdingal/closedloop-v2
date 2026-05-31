import test from "node:test";
import assert from "node:assert/strict";
import {
  isEquivalentSearchPattern,
  shouldBlockSearch,
  recordNegativeEvidence,
  recordPositiveEvidence,
  isTargetExhausted,
  inferSearchTarget,
} from "../negative-evidence.ts";
import { createEpicDecoderLedger, type DiscoveryLedger, type EpicDecoderLedger } from "../role-ledgers.ts";
import { createEpicDecoderBeforeToolCall, validateTicketPathIntent } from "../controller.ts";
import { createContinuationState } from "../agent-state.ts";

// ─── Test 1: contact search variants are equivalent ─────────────────────────

test("treats contact search variants as equivalent", () => {
  const patterns = [
    "**/contact-form.*",
    "**/ContactForm.tsx",
    "packages/app/screens/contact/ContactForm.tsx",
    "packages/app/screens/contact/index.tsx",
    "**/contact/**",
  ];

  assert.equal(isEquivalentSearchPattern(patterns[1], [patterns[0]]), true);
  assert.equal(isEquivalentSearchPattern(patterns[2], [patterns[0]]), true);
  assert.equal(isEquivalentSearchPattern(patterns[4], [patterns[0]]), true);
});

// ─── Test 2: read_file file-not-found records negative evidence ─────────────

test("records read_file file-not-found as negative evidence", () => {
  const ledger = createEpicDecoderLedger();
  let state = createContinuationState<EpicDecoderLedger, unknown>({
    role: "epicDecoder",
    objective: "test",
    ledger,
    phase: "evidence",
  });

  // Simulate what updateDiscoveryLedgerFromToolResult does for read_file
  const discovery = state.ledger.discoveryLedger;
  const updated = recordNegativeEvidence(
    discovery,
    "contact",
    "evidence",
    "packages/app/screens/contact/ContactForm.tsx",
    "Error: file not found: packages/app/screens/contact/ContactForm.tsx",
    true
  );

  assert.equal(updated.negativeEvidence.length, 1);
  assert.equal(updated.negativeEvidence[0].target, "contact");
  assert.equal(updated.negativeEvidence[0].searchCount, 1);
});

// ─── Test 3: third failed search exhausts target ────────────────────────────

test("exhausts a target after three failed searches", () => {
  let ledger = createEpicDecoderLedger().discoveryLedger;

  ledger = recordNegativeEvidence(ledger, "contact", "skeleton", "**/contact-form.*", "No files matched", true);
  ledger = recordNegativeEvidence(ledger, "contact", "evidence", "**/ContactForm.tsx", "No files matched", true);
  ledger = recordNegativeEvidence(ledger, "contact", "evidence", "packages/app/screens/contact/ContactForm.tsx", "file not found", true);

  assert.equal(isTargetExhausted(ledger, "contact"), true);
  assert.equal(shouldBlockSearch(ledger, "contact", "**/contact/**"), true);
});

// ─── Test 4: pre-tool hook blocks repeated contact search ───────────────────

test("blocks repeated contact discovery after target exhaustion", async () => {
  const ledger = createEpicDecoderLedger();
  ledger.discoveryLedger = recordNegativeEvidence(
    ledger.discoveryLedger, "contact", "skeleton", "**/contact-form.*", "No files matched", true
  );
  ledger.discoveryLedger = recordNegativeEvidence(
    ledger.discoveryLedger, "contact", "evidence", "**/ContactForm.tsx", "No files matched", true
  );
  ledger.discoveryLedger = recordNegativeEvidence(
    ledger.discoveryLedger, "contact", "evidence", "packages/app/screens/contact/ContactForm.tsx", "file not found", true
  );

  const state = createContinuationState<EpicDecoderLedger, unknown>({
    role: "epicDecoder",
    objective: "test",
    ledger,
    phase: "skeleton",
  });

  const hook = createEpicDecoderBeforeToolCall(state);

  const decision = await hook({
    role: "epicDecoder",
    phase: "skeleton",
    toolName: "glob_files",
    args: { pattern: "**/contact/**" },
    state,
  });

  assert.equal(decision.blocked, true);
  assert.ok(decision.nudge?.includes('Target "contact" is already missing'));
  assert.ok(decision.nudge?.includes("call finish_looplet"));
});

// ─── Test 5: missing path cannot be "modify" ────────────────────────────────

test("rejects modify ticket for a file proven missing", () => {
  const ledger = createEpicDecoderLedger();
  ledger.discoveryLedger = recordNegativeEvidence(
    ledger.discoveryLedger,
    "contact",
    "evidence",
    "packages/app/screens/contact/ContactForm.tsx",
    "file not found",
    true
  );

  const result = validateTicketPathIntent(
    "Modify packages/app/screens/contact/ContactForm.tsx to add validation.",
    ledger
  );

  assert.equal(result.ok, false);
  assert.ok(result.rewrittenText?.includes("Create packages/app/screens/contact/ContactForm.tsx"));
});

// ─── Test 6: positive checkout path remains allowed ─────────────────────────

test("does not block verified positive evidence", () => {
  let discovery = createEpicDecoderLedger().discoveryLedger;

  discovery = recordPositiveEvidence(
    discovery,
    "checkout",
    "evidence",
    ["tests/checkout-flow.spec.ts"],
    ["Found checkout flow test"]
  );

  assert.equal(shouldBlockSearch(discovery, "checkout", "**/checkout*.tsx"), false);
});

// ─── Additional tests ───────────────────────────────────────────────────────

test("inferSearchTarget detects contact from various patterns", () => {
  assert.equal(inferSearchTarget("**/contact-form.*"), "contact");
  assert.equal(inferSearchTarget("**/ContactForm.tsx"), "contact");
  assert.equal(inferSearchTarget("packages/app/screens/contact/ContactForm.tsx"), "contact");
  assert.equal(inferSearchTarget("**/contact/**"), "contact");
});

test("shouldBlockSearch blocks after 2 equivalent searches", () => {
  let ledger = createEpicDecoderLedger().discoveryLedger;
  ledger = recordNegativeEvidence(ledger, "contact", "skeleton", "**/contact-form.*", "No files matched", true);
  ledger = recordNegativeEvidence(ledger, "contact", "evidence", "**/ContactForm.tsx", "No files matched", true);

  assert.equal(shouldBlockSearch(ledger, "contact", "**/contact-form.*"), true);
  assert.equal(shouldBlockSearch(ledger, "contact", "**/ContactForm.tsx"), true);
});

test("shouldBlockSearch blocks all searches after 3 failures even with different pattern", () => {
  let ledger = createEpicDecoderLedger().discoveryLedger;
  ledger = recordNegativeEvidence(ledger, "auth", "skeleton", "**/auth.*", "No files matched", true);
  ledger = recordNegativeEvidence(ledger, "auth", "evidence", "**/login.*", "No files matched", true);
  ledger = recordNegativeEvidence(ledger, "auth", "evidence", "src/auth.ts", "file not found", true);

  assert.equal(shouldBlockSearch(ledger, "auth", "**/totally-different.*"), true);
});

test("validateTicketPathIntent allows create for missing file", () => {
  const ledger = createEpicDecoderLedger();
  ledger.discoveryLedger = recordNegativeEvidence(
    ledger.discoveryLedger, "contact", "evidence",
    "packages/app/screens/contact/ContactForm.tsx", "file not found", true
  );

  const result = validateTicketPathIntent(
    "Create packages/app/screens/contact/ContactForm.tsx because no existing contact form was found.",
    ledger
  );

  assert.equal(result.ok, true);
});

test("validateTicketPathIntent allows modify for verified file", () => {
  const ledger = createEpicDecoderLedger();
  ledger.discoveryLedger = recordPositiveEvidence(
    ledger.discoveryLedger, "checkout", "evidence",
    ["src/checkout.ts"], ["Found checkout"]
  );

  const result = validateTicketPathIntent(
    "Modify src/checkout.ts to add validation.",
    ledger
  );

  assert.equal(result.ok, true);
});

test("beforeToolCall hook allows finish_looplet through", async () => {
  const ledger = createEpicDecoderLedger();
  ledger.discoveryLedger = recordNegativeEvidence(
    ledger.discoveryLedger, "contact", "skeleton", "**/contact-form.*", "No files matched", true
  );

  const state = createContinuationState<EpicDecoderLedger, unknown>({
    role: "epicDecoder",
    objective: "test",
    ledger,
    phase: "skeleton",
  });

  const hook = createEpicDecoderBeforeToolCall(state);

  const decision = await hook({
    role: "epicDecoder",
    phase: "skeleton",
    toolName: "finish_looplet",
    args: { summary: "done", phaseComplete: true },
    state,
  });

  assert.equal(decision.blocked, undefined);
});

test("beforeToolCall hook allows non-epicDecoder roles through", async () => {
  const ledger = createEpicDecoderLedger();
  ledger.discoveryLedger = recordNegativeEvidence(
    ledger.discoveryLedger, "contact", "skeleton", "**/contact-form.*", "No files matched", true
  );

  const state = createContinuationState<EpicDecoderLedger, unknown>({
    role: "epicDecoder",
    objective: "test",
    ledger,
    phase: "skeleton",
  });

  const hook = createEpicDecoderBeforeToolCall(state);

  const decision = await hook({
    role: "builder",
    phase: "edit",
    toolName: "glob_files",
    args: { pattern: "**/contact/**" },
    state,
  });

  assert.equal(decision.blocked, undefined);
});
