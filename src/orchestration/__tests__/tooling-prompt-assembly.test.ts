import test from "node:test";
import assert from "node:assert/strict";
import { builderToolingPrompt, coderPrompt, epicDecoderToolingPrompt } from "../prompts.ts";
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
    pausedFromStatus: null,
    scheduledDate: null,
    assetPaths: [],
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

  const prompt = epicDecoderToolingPrompt(epic, ragCtx, null, "mediated:qwen3.5:9b", "PREVIOUS ATTEMPT FEEDBACK:\nOutput strict JSON only.");
  assert.ok(prompt.includes("EPIC_TOOL_CONTEXT"));
  assert.ok(prompt.includes("Available tools this run:"));
  assert.ok(prompt.includes("Every ticket must include allowedPaths and use forward slashes in all paths."));
  assert.ok(prompt.includes("PREVIOUS ATTEMPT FEEDBACK"));
  assert.ok(prompt.includes("\"allowedPaths\":[\"string\"]"));
});

test("coderPrompt includes retrieved context when explorer is skipped", () => {
  const ticket: TicketRecord = {
    id: "T2",
    epicId: "E2",
    title: "Skip explorer coder",
    description: "Use retrieved context directly",
    acceptanceCriteria: ["Do the thing"],
    dependencies: [],
    allowedPaths: ["src/foo.ts"],
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
    epicId: "E2",
    ticketId: "T2",
    runId: "R2",
    title: "Skip explorer coder",
    description: "Use retrieved context directly",
    acceptanceCriteria: ["Do the thing"],
    dependencies: [],
    allowedPaths: ["src/foo.ts"],
    reviewBlockers: [],
    priorTestFailures: [],
    modelAssignments: {} as any,
    workspaceId: "ws2",
    workspacePath: "path2",
    branchName: "branch2",
    attempt: 1,
    retrievedContext: {
      codeContext: "CODE_CONTEXT_HERE",
      docContext: "DOC_CONTEXT_HERE",
      toolContext: "CODER_TOOL_CONTEXT_HERE",
      projectStructure: "PROJECT_STRUCTURE_HERE",
      retrievalMode: "semantic",
      chunkCount: 3
    }
  };

  const prompt = coderPrompt(
    ticket,
    { summary: "minimal", relevantFiles: ["src/foo.ts"], relevantSymbols: [], likelyEditRegions: [], recommendedFilesForCoding: ["src/foo.ts"], risks: [], missingContext: [], blockers: [] },
    ["src/foo.ts"],
    undefined,
    { skipped: true, reason: "Explorer was skipped by retry logic." },
    packet
  );

  assert.ok(prompt.includes("CODER_TOOL_CONTEXT_HERE"));
  assert.ok(prompt.includes("DOC_CONTEXT_HERE"));
  assert.ok(prompt.includes("CODE_CONTEXT_HERE"));
  assert.ok(prompt.includes("PROJECT_STRUCTURE_HERE"));
  assert.ok(prompt.includes("Explorer was skipped by retry logic."));
});
