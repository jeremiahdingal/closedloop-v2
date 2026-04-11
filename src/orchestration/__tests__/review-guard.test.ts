import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadReviewContract, runReviewGuard } from "../review-guard.ts";

test("loadReviewContract parses strict REVIEW_CONTRACT JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-contract-"));
  try {
    await writeFile(
      path.join(root, "PROJECT_STRUCTURE.md"),
      [
        "# Project Structure",
        "",
        "## REVIEW_CONTRACT",
        "",
        "```json",
        JSON.stringify({
          schemaSources: ["src/schemas/order.ts"],
          derivedSchemas: [
            {
              source: "src/schemas/order.ts",
              derived: "src/schemas/order.generated.ts",
              strict: true,
            },
          ],
          generatedReadOnlyPaths: ["src/schemas/order.generated.ts"],
          folderOwnership: [{ path: "src/schemas", owner: "schemas" }],
          strictFolderBoundaries: true,
        }, null, 2),
        "```",
      ].join("\n"),
      "utf8"
    );

    const contract = await loadReviewContract(root, "PROJECT_STRUCTURE.md");
    assert.equal(contract.found, true);
    assert.equal(contract.valid, true);
    assert.ok(contract.contract);
    assert.deepEqual(contract.contract?.schemaSources, ["src/schemas/order.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runReviewGuard blocks derived schema edits without source changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-guard-"));
  try {
    await writeFile(
      path.join(root, "PROJECT_STRUCTURE.md"),
      [
        "# Project Structure",
        "",
        "## REVIEW_CONTRACT",
        "",
        "```json",
        JSON.stringify({
          schemaSources: ["src/schemas/order.ts"],
          derivedSchemas: [
            {
              source: "src/schemas/order.ts",
              derived: "src/schemas/order.generated.ts",
              strict: true,
            },
          ],
          generatedReadOnlyPaths: ["src/schemas/order.generated.ts"],
          folderOwnership: [{ path: "src/schemas", owner: "schemas" }],
          strictFolderBoundaries: true,
        }, null, 2),
        "```",
      ].join("\n"),
      "utf8"
    );

    const contract = await loadReviewContract(root, "PROJECT_STRUCTURE.md");
    const guard = runReviewGuard({
      diff: [
        "diff --git a/src/schemas/order.generated.ts b/src/schemas/order.generated.ts",
        "--- a/src/schemas/order.generated.ts",
        "+++ b/src/schemas/order.generated.ts",
        "@@",
        "+export const ORDER_SCHEMA = {}",
      ].join("\n"),
      allowedPaths: ["src/schemas"],
      contract,
      destructiveBlockers: [],
    });

    assert.equal(guard.passed, false);
    assert.ok(guard.blockers.some((blocker) => blocker.includes("Derived schema changed without source update")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runReviewGuard blocks files outside declared folder ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-guard-"));
  try {
    await writeFile(
      path.join(root, "PROJECT_STRUCTURE.md"),
      [
        "# Project Structure",
        "",
        "## REVIEW_CONTRACT",
        "",
        "```json",
        JSON.stringify({
          schemaSources: [],
          derivedSchemas: [],
          generatedReadOnlyPaths: [],
          folderOwnership: [{ path: "src/schemas", owner: "schemas" }],
          strictFolderBoundaries: true,
        }, null, 2),
        "```",
      ].join("\n"),
      "utf8"
    );

    const contract = await loadReviewContract(root, "PROJECT_STRUCTURE.md");
    const guard = runReviewGuard({
      diff: [
        "diff --git a/src/ui/order.ts b/src/ui/order.ts",
        "--- a/src/ui/order.ts",
        "+++ b/src/ui/order.ts",
        "@@",
        "+export const foo = 1",
      ].join("\n"),
      allowedPaths: ["src"],
      contract,
      destructiveBlockers: [],
    });

    assert.equal(guard.passed, false);
    assert.ok(guard.blockers.some((blocker) => blocker.includes("outside declared folder ownership")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
