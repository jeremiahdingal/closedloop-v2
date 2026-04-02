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
  apiKey?: string;
  model: string;
  cwd: string;
  allowedPaths?: string[];
  maxIterations?: number;
  timeoutMs?: number;
  temperature?: number;
  braveApiKey?: string;
  onEvent?: (event: MediatedHarnessEvent) => void;
}

export interface ToolExecutionContext {
  cwd: string;
  workspaceId: string;
  allowedPaths: string[];
  braveApiKey?: string;
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
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "tool_result"; result: ToolResult }
  | { kind: "tool_error"; call: ToolCall; error: string }
  | { kind: "complete"; result: string; iterations: number }
  | { kind: "error"; error: string };

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
