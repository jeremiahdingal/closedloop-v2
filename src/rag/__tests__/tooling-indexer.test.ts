import test from "node:test";
import assert from "node:assert/strict";
import { isDocFile, chunkDocFile } from "../indexer.ts";

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
