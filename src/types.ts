export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "escalated" | "cancelled";
export type TicketStatus = "queued" | "building" | "reviewing" | "testing" | "approved" | "escalated" | "failed" | "cancelled";
export type EpicStatus = "planning" | "executing" | "reviewing" | "done" | "failed" | "cancelled";

export type AgentRole =
  | "epicDecoder"
  | "builder"
  | "explorer"
  | "coder"
  | "reviewer"
  | "tester"
  | "epicReviewer"
  | "playWriter"
  | "playTester"
  | "doctor"
  | "system";

export type EpicRecord = {
  id: string;
  title: string;
  goalText: string;
  targetDir: string;
  targetBranch: string | null;
  status: EpicStatus;
  createdAt: string;
  updatedAt: string;
};

export type TicketRecord = {
  id: string;
  epicId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  allowedPaths: string[];
  status: TicketStatus;
  priority: "high" | "medium" | "low";
  currentRunId: string | null;
  currentNode: string | null;
  lastHeartbeatAt: string | null;
  lastMessage: string | null;
  diffFiles: { path: string; additions: number; deletions: number }[] | null;
  prUrl: string | null;
  metadata: Record<string, Json>;
  createdAt: string;
  updatedAt: string;
};

export type RunRecord = {
  id: string;
  kind: "epic" | "ticket" | "epic_review" | "epic_play_loop";
  epicId: string | null;
  ticketId: string | null;
  status: RunStatus;
  currentNode: string | null;
  attempt: number;
  heartbeatAt: string | null;
  lastMessage: string | null;
  errorText: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRecord = {
  id: string;
  ticketId: string;
  runId: string;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  headCommit: string | null;
  savedBranch: string | null;
  status: "active" | "archived" | "cleaned";
  leaseOwner: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DirectChatSessionRecord = {
  id: string;
  title: string;
  targetDir: string;
  branchName: string;
  model: string;
  createdAt: string;
  updatedAt: string;
};

export type DirectChatMessageRecord = {
  id: number;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallsJson: string | null;
  toolResultsJson: string | null;
  createdAt: string;
};

export type BuilderOperation =
  | { kind: "replace_file"; path: string; content: string }
  | { kind: "append_file"; path: string; content: string };

export type BuilderPlan = {
  summary: string;
  intendedFiles: string[];
  operations: BuilderOperation[];
};

export type ReviewerVerdict = {
  approved: boolean;
  blockers: string[];
  suggestions: string[];
  riskLevel: "low" | "medium" | "high";
};

export type GoalTicketPlan = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  allowedPaths: string[];
  priority: "high" | "medium" | "low";
};

export type GoalDecomposition = {
  summary: string;
  tickets: GoalTicketPlan[];
  clarificationQuestions?: string[];
};

export type GoalReview = {
  verdict: "approved" | "needs_followups" | "failed";
  summary: string;
  followupTickets: GoalTicketPlan[];
};

export type FailureDecision = {
  decision: "retry_same_node" | "retry_builder" | "blocked" | "todo" | "escalate" | "approve";
  reason: string;
};

export type OpenCodeLaunchInfo = {
  cwd: string;
  repoRoot: string;
  model: string;
  promptLength: number;
  command: string;
  args: string[];
  shell: boolean;
  binaryPath: string;
  binarySource: "package-entrypoint" | "override-path" | "override-command";
  cwdExists: boolean;
  cwdIsDirectory: boolean;
};

export type TicketContextPacket = {
  epicId: string;
  ticketId: string;
  runId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  allowedPaths: string[];
  reviewBlockers: string[];
  priorTestFailures: string[];
  modelAssignments: Record<AgentRole, string>;
  workspaceId: string;
  workspacePath: string;
  branchName: string;
  attempt: number;
  retrievedContext?: {
    codeContext: string;
    docContext: string;
    toolContext?: string;
    projectStructure?: string;
    retrievalMode: "semantic" | "keyword";
    chunkCount: number;
  } | null;
};

export type CommandName = "test" | "lint" | "typecheck" | "build" | "status";

export type CommandCatalog = Record<CommandName, string>;

export type ToolInvocationResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type WriteFileInput = {
  path: string;
  content: string;
};



export type AgentStreamPayload = {
  agentRole: AgentRole;
  source: "opencode" | "orchestrator" | "mediated-harness" | "zai";
  streamKind: "stdout" | "stderr" | "thinking" | "assistant" | "system" | "status" | "raw" | "tool_call" | "tool_result" | "error" | "plan_cleared";
  content: string;
  runId?: string | null;
  ticketId?: string | null;
  epicId?: string | null;
  sessionId?: string | null;
  sequence?: number;
  done?: boolean;
  metadata?: Record<string, Json>;
};

export type OpenCodeBuilderResult = {
  summary: string;
  sessionId?: string | null;
  rawOutput: string;
  launchInfo?: OpenCodeLaunchInfo | null;
};

export type HandoffPacket = {
  role: AgentRole;
  state: "approved" | "rejected" | "todo" | "blocked" | "escalated" | "completed";
  summary: string;
  files: string[];
  reason?: string;
  payload?: Json;
};

export type TesterResult = {
  testNecessityScore: number;
  testNecessityReason: string;
  testsWritten: boolean;
  testFiles: string[];
  testResults: "PASS" | "FAIL" | "SKIPPED";
  testOutput: string;
  testsRun: number;
};

export type EpicReviewDisposition =
  | "approved_complete"
  | "partial_ready"
  | "not_reviewable";

export type TicketEpicReviewPacket = {
  ticketId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  dependencies: string[];
  ticketStatus: string;
  currentRunId: string | null;
  builderSummary: string | null;
  intendedFiles: string[];
  lastDiff: string | null;
  diffPresent: boolean;
  review: {
    verdict: boolean;
    blockers: string[];
    suggestions: string[];
  } | null;
  failure: {
    stage: string;
    reason: string;
  } | null;
  epicReviewReadiness: "ready" | "blocked";
  epicReviewDisposition: EpicReviewDisposition;
};

export type EditOperation =
  | { kind: "search_replace"; path: string; expected_sha256: string; search: string; replace: string }
  | { kind: "create_file"; path: string; content: string }
  | { kind: "append_file"; path: string; content: string }
  | { kind: "delete_file"; path: string; expected_sha256: string; reason: string }
  | { kind: "rename_file"; path: string; newPath: string; expected_sha256: string; reason: string };

export type CanonicalEditPacket = {
  ticketId: string;
  goalText: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  files: Array<{
    path: string;
    exists: boolean;
    sha256: string | null;
    content: string | null; // null if too large, then excerpts used
    excerpts?: Array<{ content: string; startLine: number; endLine: number }>;
  }>;
  destructivePermissions: {
    allowFileDeletion: boolean;
    allowFileRename: boolean;
    allowLargeDeletion: boolean;
    allowFullReplace: boolean;
  };
  allowedDeletePaths: string[];
  allowedRenamePaths: string[];
  allowedFullReplacePaths: string[];
};

export type ExplorerOutput = {
  relevantFiles: string[];
  relevantSymbols: string[];
  likelyEditRegions: Array<{ path: string; region: string }>;
  summary: string;
  risks: string[];
  missingContext: string[];
  recommendedFilesForCoding: string[];
  blockers?: string[];
};

export type CoderOutput = {
  summary: string;
  intendedFiles: string[];
  unresolvedBlockers: string[];
  operations: EditOperation[];
};
