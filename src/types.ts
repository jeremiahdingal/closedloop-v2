export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "escalated" | "cancelled";
export type TicketStatus = "queued" | "building" | "reviewing" | "testing" | "approved" | "escalated" | "failed";
export type EpicStatus = "planning" | "executing" | "reviewing" | "done" | "failed";

export type AgentRole =
  | "goalDecomposer"
  | "builder"
  | "reviewer"
  | "tester"
  | "goalReviewer"
  | "doctor";

export type EpicRecord = {
  id: string;
  title: string;
  goalText: string;
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
  metadata: Record<string, Json>;
  createdAt: string;
  updatedAt: string;
};

export type RunRecord = {
  id: string;
  kind: "epic" | "ticket";
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
  status: "active" | "archived" | "cleaned";
  leaseOwner: string | null;
  createdAt: string;
  updatedAt: string;
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
};

export type GoalReview = {
  verdict: "approved" | "needs_followups" | "failed";
  summary: string;
  followupTickets: GoalTicketPlan[];
};

export type FailureDecision = {
  decision: "retry_same_node" | "retry_builder" | "blocked" | "todo" | "escalate";
  reason: string;
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
};

export type CommandName = "test" | "lint" | "typecheck" | "status";

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
  source: "opencode" | "orchestrator";
  streamKind: "stdout" | "stderr" | "thinking" | "assistant" | "system" | "status" | "raw";
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
};

export type HandoffPacket = {
  role: AgentRole;
  state: "approved" | "rejected" | "todo" | "blocked" | "escalated" | "completed";
  summary: string;
  files: string[];
  reason?: string;
  payload?: Json;
};
