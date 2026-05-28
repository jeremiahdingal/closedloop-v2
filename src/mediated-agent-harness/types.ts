import { z } from "zod";

// ─── Tool definition (OpenAI function-calling format) ───────────────────────

export const ToolParameterSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  properties: z.record(z.any()).optional(),
  required: z.array(z.string()).optional(),
  items: z.any().optional(),
  additionalProperties: z.boolean().optional(),
});

export type ToolParameter = z.infer<typeof ToolParameterSchema>;

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameter>;
      required?: string[];
      additionalProperties: false;
    };
  };
}

// ─── Tool calls and results ─────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface CompleteToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string from model
}

export interface ToolResult {
  callId: string;
  name: string;
  output: string;
  isError?: boolean;
}

// ─── Streaming state ────────────────────────────────────────────────────────

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamState {
  content: string;
  toolCalls: CompleteToolCall[];
  done: boolean;
  usage: Usage | null;
  thinking: string | null;
}

// ─── Mediated bridge config ─────────────────────────────────────────────────

export interface MediatedHarnessConfig {
  baseURL?: string;
  /** API key for Anthropic-compatible backends */
  apiKey?: string;
  /** "ollama" (default) or "anthropic" or "openrouter" for OpenRouter-compatible endpoints */
  apiBackend?: "ollama" | "anthropic" | "openrouter";
  model: string;
  cwd: string;
  role?: string;
  toolMode?: "native" | "xml";
  noThink?: boolean;
  allowedPaths?: string[];
  maxIterations?: number;
  timeoutMs?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  numCtx?: number;
  braveApiKey?: string;
  onEvent?: (event: MediatedHarnessEvent) => void;
}

export interface ToolExecutionContext {
  cwd: string;
  workspaceId: string;
  readTrackingKey?: string;
  allowedPaths: string[];
  availableCommands?: string[];
  braveApiKey?: string;
  ragIndexId?: number;
  db?: any; // AppDatabase - optional to avoid circular deps
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  readFiles(paths: string[]): Promise<Record<string, string>>;
  writeFiles(files: { path: string; content: string }[]): Promise<void>;
  gitDiff(): Promise<string>;
  gitDiffStaged?(): Promise<string>;
  gitStatus(): Promise<string>;
  runNamedCommand(name: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  saveArtifact(opts: { name: string; content: string; kind?: string }): Promise<string>;
  readArtifact?(opts: { name?: string; kind?: string }): Promise<string | null>;
  getAvailableCommands?(): string[];
}

// ─── Events ─────────────────────────────────────────────────────────────────

export type MediatedHarnessEvent =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "streaming_text"; text: string }
  | { kind: "streaming_thinking"; text: string }
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "tool_result"; result: ToolResult }
  | { kind: "tool_error"; call: ToolCall; error: string }
  | { kind: "complete"; result: string; iterations: number }
  | { kind: "error"; error: string }
  | { kind: "duplicate_recovery"; bannedCall: string; recoveryCount: number };

// ─── Result ─────────────────────────────────────────────────────────────────

export interface MediatedHarnessResult {
  text: string;
  toolCalls: ToolCall[];
  iterations: number;
  usage: Usage | null;
}

// ─── Message types (OpenAI format) ──────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// ─── OpenAI streaming chunk types ───────────────────────────────────────────

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason: string | null;
  }[];
  usage?: Usage | null;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

// ─── Duplicate recovery types ───────────────────────────────────────────────

export interface BannedCallSignature {
  toolName: string;
  argsHash: string;
  errorMessage: string;
  errorKind: string;
  bannedAt: number;
}

export interface DuplicateRecoveryState {
  bannedSignatures: BannedCallSignature[];
  recoveryCount: number;
  postRecoveryCallCount: number;
  isInRecovery: boolean;
  hasMadeProgress: boolean;
}

// ─── Ollama native API types ─────────────────────────────────────────────────

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaChatMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaChatMessage {
  role: string;
  content: string;
  thinking?: string;
  tool_calls?: OllamaNativeToolCall[];
}

export interface OllamaNativeToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}
