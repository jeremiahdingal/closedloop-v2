import test from "node:test";
import assert from "node:assert/strict";
import { builderToolingPrompt, epicDecoderToolingPrompt } from "../prompts.ts";
import type { TicketRecord, EpicRecord, TicketContextPacket } from "../../types.ts";

test("builderToolingPrompt includes toolContext if present", () => {
  const ticket: TicketRecord = {
    id: "T1",
    epicId: "E1",
    title: "Test",
    description: "Do stuff",
    acceptanceCriteria: [],
    dependencies: [],
    allowedPaths: [],
    priority: "high",
    status: "queued",
    metadata: {},
    createdAt: "",
    updatedAt: "",
    currentRunId: null,
    currentNode: null,
    lastHeartbeatAt: null,
    lastMessage: null,
    diffFiles: null,
    prUrl: null
  };
  const packet: TicketContextPacket = {
    epicId: "E1",
    ticketId: "T1",
    runId: "R1",
    title: "Test",
    description: "Do stuff",
    acceptanceCriteria: [],
    dependencies: [],
    allowedPaths: [],
    reviewBlockers: [],
    priorTestFailures: [],
    modelAssignments: {} as any,
    workspaceId: "ws1",
    workspacePath: "path1",
    branchName: "branch1",
    attempt: 1,
    retrievedContext: {
      codeContext: "code",
      docContext: "doc",
      toolContext: "MOCK_TOOL_CONTEXT",
      retrievalMode: "semantic",
      chunkCount: 1
    }
  };

  const prompt = builderToolingPrompt(ticket, packet);
  assert.ok(prompt.includes("MOCK_TOOL_CONTEXT"));
  assert.ok(prompt.includes("Available tools this run:"));
});

test("epicDecoderToolingPrompt includes toolContext if present", () => {
  const epic: EpicRecord = {
    id: "E1",
    title: "Epic",
    goalText: "Goal",
    targetDir: "dir",
    targetBranch: null,
    status: "planning",
    createdAt: "",
    updatedAt: ""
  };
  
  const ragCtx = {
    codeContext: "code",
    docContext: "doc",
    toolContext: "EPIC_TOOL_CONTEXT",
    totalTokenEstimate: 10,
    retrievalMode: "semantic" as const,
    chunkCount: 1
  };

  const prompt = epicDecoderToolingPrompt(epic, ragCtx);
  assert.ok(prompt.includes("EPIC_TOOL_CONTEXT"));
  assert.ok(prompt.includes("Available tools this run:"));
});
