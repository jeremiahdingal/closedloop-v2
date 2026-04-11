import test from "node:test";
import assert from "node:assert/strict";
import { buildToolingContext } from "../context-builder.ts";
import { AppDatabase } from "../../db/database.ts";

test("buildToolingContext creates sections for tool guidance", async () => {
  // Use in-memory DB
  const db = new AppDatabase(":memory:");
  const indexId = db.createRagIndex({
    repoRoot: "/test",
    commitHash: "abc",
    chunkCount: 1,
    modelName: "test-model"
  });

  // Insert mock chunks
  db.insertRagChunks(indexId, [
    {
      filePath: "src/public/tooling/playbooks/builder.md",
      chunkType: "doc",
      content: "Builder Playbook Content",
      embedding: Buffer.alloc(1024), // Mock embedding
      tokenEstimate: 5,
    },
    {
      filePath: "src/public/tooling/toolcards/read_file.md",
      chunkType: "doc",
      content: "Tool: read_file",
      embedding: Buffer.alloc(1024),
      tokenEstimate: 3,
    },
    {
      filePath: "src/public/tooling/repair/common-tool-call-errors.md",
      chunkType: "doc",
      content: "Repair: Malformed JSON",
      embedding: Buffer.alloc(1024),
      tokenEstimate: 4,
    }
  ]);

  const ctx = await buildToolingContext({
    role: "builder",
    availableTools: ["read_file"],
    db,
    indexId,
    includeRepair: true,
  });

  assert.ok(ctx.includes("=== Tool Guidance ==="));
  assert.ok(ctx.includes("Builder Playbook Content"));
  assert.ok(ctx.includes("Tool: read_file"));
  assert.ok(ctx.includes("Repair: Malformed JSON"));
});
