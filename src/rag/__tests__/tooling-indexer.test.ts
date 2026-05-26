import test from "node:test";
import assert from "node:assert/strict";
import { isDocFile, chunkDocFile, isTransientRagPath } from "../indexer.ts";

test("isDocFile identifies markdown files correctly", () => {
  assert.ok(isDocFile("src/public/tooling/toolcards/read_file.md"));
  assert.ok(isDocFile("README.md"));
  assert.ok(!isDocFile("src/index.ts"));
});

test("chunkDocFile generates chunks for markdown files", () => {
  const content = `# Tool: test
  
Use for:
- Testing
`;
  const chunks = chunkDocFile("test.md", content);
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].chunkType, "doc");
  assert.ok(chunks[0].content.includes("# Tool: test"));
});

test("isTransientRagPath excludes generated Playwright and coverage artifacts", () => {
  assert.ok(isTransientRagPath("playwright-report/data/failure.md"));
  assert.ok(isTransientRagPath("test-results/edit-features/error-context.md"));
  assert.ok(isTransientRagPath("output/generated/test-plan.md"));
  assert.ok(isTransientRagPath("coverage/index.html"));
  assert.equal(isTransientRagPath("docs/README.md"), false);
});
