export type Epic = {
  id: string;
  title: string;
  goalText: string;
  targetDir: string;
  targetBranch: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type Ticket = {
  id: string;
  epicId: string;
  title: string;
  description: string;
  status: string;
  currentNode: string | null;
  lastMessage: string | null;
  priority: string;
  dependencies: string[];
  currentRunId: string | null;
  diffFiles?: { path: string; additions: number; deletions: number }[];
  prUrl?: string | null;
};

export type Run = {
  id: string;
  kind: string;
  status: string;
  currentNode: string | null;
  ticketId: string | null;
  epicId: string | null;
  lastMessage: string | null;
  heartbeatAt: string | null;
};

export type AgentEvent = {
  id: number;
  created_at: string;
  message: string;
  run_id: string | null;
  ticket_id: string | null;
  payload: {
    agentRole: string;
    streamKind: string;
    content: string;
    source: string;
    done?: boolean;
    runId?: string | null;
    ticketId?: string | null;
    epicId?: string | null;
    metadata?: Record<string, unknown>;
  } | null;
};

export type ModelAdapterOption = {
  id: string;
  label: string;
  description: string;
};

export type AgentModelInfo = {
  currentModel: string;
  adapters: ModelAdapterOption[];
  switchable: boolean;
};

export type AgentModelsConfig = Record<string, AgentModelInfo>;

export type TicketDiffResponse = {
  ticketId: string;
  diff: string;
  artifactName: string | null;
  createdAt: string | null;
};

export type ParsedDiffHunk = {
  header: string;
  lines: string[];
};

export type ParsedDiffFile = {
  path: string;
  additions: number;
  deletions: number;
  hunks: ParsedDiffHunk[];
};

export type Dashboard = {
  epics: Epic[];
  tickets: Ticket[];
  runs: Run[];
  agentEvents: AgentEvent[];
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

export type AgentStreamStatus = "idle" | "running" | "stalled" | "completed";

export type GoalDecomposition = {
  summary: string;
  clarificationQuestions?: string[];
  tickets: Array<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    dependencies: string[];
    allowedPaths: string[];
    priority: string;
  }>;
};
