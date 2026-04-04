import test from "node:test";
import assert from "node:assert/strict";
import { validateBuilderPlan } from "../src/orchestration/validation.ts";

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
