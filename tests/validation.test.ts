import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonText, validateBuilderPlan, validateReviewerVerdict } from "../src/orchestration/validation.ts";

test("validateBuilderPlan normalizes malformed trailing punctuation in file paths", () => {
  const plan = validateBuilderPlan({
    summary: "Create hello.json",
    intendedFiles: ["hello.json"],
    operations: [
      {
        kind: "replace_file",
        path: "hello.json], ",
        content: "{\n  \"ok\": true\n}\n"
      }
    ]
  });

  assert.deepEqual(plan.intendedFiles, ["hello.json"]);
  assert.equal(plan.operations[0]?.path, "hello.json");
});

test("parseJsonText repairs malformed FINAL_JSON output with backslashes and raw newlines", () => {
  const raw = `<FINAL_JSON>{"summary":"Decode epic","tickets":[{"id":"T1","title":"Fix decoder output","description":"Repair api\\vitest.config.ts and
keep parsing the payload.","acceptanceCriteria":["The payload parses"],"dependencies":[],"allowedPaths":["src\\orchestration","test-results\\fixtures"],"priority":"high"}]}</FINAL_JSON>`;

  const parsed = parseJsonText(raw) as {
    summary: string;
    tickets: Array<{
      description: string;
      allowedPaths: string[];
    }>;
  };

  assert.equal(parsed.summary, "Decode epic");
  assert.equal(parsed.tickets[0]?.description, "Repair api\\vitest.config.ts and\nkeep parsing the payload.");
  assert.equal(parsed.tickets[0]?.allowedPaths[0], "src\\orchestration");
  assert.equal(typeof parsed.tickets[0]?.allowedPaths[1], "string");
  assert.ok((parsed.tickets[0]?.allowedPaths[1] ?? "").startsWith("test-results"));
});

test("validateReviewerVerdict accepts legacy verdict/issues reviewer shape", () => {
  assert.deepEqual(
    validateReviewerVerdict({
      verdict: "approved",
      summary: "Looks good",
      issues: ["Consider adding a narrower assertion"],
    }),
    {
      approved: true,
      blockers: [],
      suggestions: ["Consider adding a narrower assertion"],
      riskLevel: "low",
    }
  );

  assert.deepEqual(
    validateReviewerVerdict({
      verdict: "rejected",
      summary: "Syntax error",
      issues: ["App.tsx has invalid JSX"],
    }),
    {
      approved: false,
      blockers: ["App.tsx has invalid JSX"],
      suggestions: [],
      riskLevel: "high",
    }
  );
});
