import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveConstrainedTargetDir, normalizeWorkspaceConfigPatch } from "../src/config.ts";
import { makeTempDir } from "./helpers.ts";

test("resolveConstrainedTargetDir allows the configured target dir and nested paths", async () => {
  const root = await makeTempDir("target-root-");
  const nested = path.join(root, "nested", "child");

  assert.equal(
    resolveConstrainedTargetDir(root, { targetDir: root }),
    path.resolve(root)
  );
  assert.equal(
    resolveConstrainedTargetDir(nested, { targetDir: root }),
    path.resolve(nested)
  );
});

test("resolveConstrainedTargetDir rejects paths outside the configured target dir", async () => {
  const root = await makeTempDir("target-root-");
  const outside = await makeTempDir("outside-root-");

  assert.throws(
    () => resolveConstrainedTargetDir(outside, { targetDir: root }),
    /Target directory must stay inside configured workspace root/
  );
});

test("normalizeWorkspaceConfigPatch resolves targetDir to an existing absolute directory", async () => {
  const root = await makeTempDir("target-root-");
  const normalized = normalizeWorkspaceConfigPatch({ targetDir: root });

  assert.equal(normalized.targetDir, path.resolve(root));
});

test("normalizeWorkspaceConfigPatch rejects a missing targetDir", async () => {
  const missing = path.join(await makeTempDir("target-root-"), "missing-subdir");

  assert.throws(
    () => normalizeWorkspaceConfigPatch({ targetDir: missing }),
    /Configured targetDir does not exist or is not a directory/
  );
});
