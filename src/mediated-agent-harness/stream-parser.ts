import type {
  ChatCompletionChunk,
  CompleteToolCall,
  StreamState,
  ToolCallDelta,
  Usage,
} from "./types.ts";

interface AccumulatedToolDelta {
  index: number;
  id: string | null;
  name: string | null;
  argsBuffer: string;
}

export class StreamParser {
  private content = "";
  private toolDeltas = new Map<number, AccumulatedToolDelta>();
  private done = false;
  private usage: Usage | null = null;
  private thinking = "";
  private inThinking = false;
  private buffer = "";

  feed(rawLine: string): void {
    const line = rawLine.trim();

    if (!line) return;

    // Handle [DONE] sentinel
    if (line === "data: [DONE]") {
      this.done = true;
      return;
    }

    // Handle data: prefix
    let jsonStr = line;
    if (line.startsWith("data: ")) {
      jsonStr = line.slice(6);
    } else if (line.startsWith("data:")) {
      jsonStr = line.slice(5);
    } else {
      // Not an SSE data line — might be a comment line or partial chunk
      return;
    }

    jsonStr = jsonStr.trim();
    if (!jsonStr) return;

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(jsonStr);
    } catch {
      // Partial or malformed JSON — buffer it for retry
      this.buffer += jsonStr;
      try {
        chunk = JSON.parse(this.buffer);
        this.buffer = "";
      } catch {
        return; // still incomplete
      }
    }

    // Capture usage from final chunk (some servers put it here)
    if (chunk.usage) {
      this.usage = chunk.usage;
    }

    // Process choices
    if (!chunk.choices || chunk.choices.length === 0) return;

    const choice = chunk.choices[0];

    // Handle finish_reason
    if (choice.finish_reason === "stop" || choice.finish_reason === "tool_calls") {
      // Stream is ending — continue processing the delta though
    }

    const delta = choice.delta;
    if (!delta) return;

    // Accumulate thinking text (some models use <think> tags or reasoning_content)
    if (delta.content !== undefined && delta.content !== null) {
      this.accumulateContent(delta.content);
    }

    // Accumulate tool call deltas
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        this.accumulateToolDelta(tc);
      }
    }
  }

  private accumulateContent(text: string): void {
    // Detect thinking tags — models vary in how they emit reasoning
    if (text.includes("<think>")) {
      this.inThinking = true;
      const afterThink = text.split("<think>").pop() ?? "";
      this.thinking += afterThink;
      return;
    }
    if (text.includes("</think>")) {
      this.inThinking = false;
      const beforeClose = text.split("</think>")[0] ?? "";
      this.thinking += beforeClose;
      // Content after </think> is regular content
      const parts = text.split("</think>");
      if (parts.length > 1) {
        this.content += parts.slice(1).join("</think>");
      }
      return;
    }

    if (this.inThinking) {
      this.thinking += text;
    } else {
      this.content += text;
    }
  }

  private accumulateToolDelta(tc: ToolCallDelta): void {
    const idx = tc.index;
    let existing = this.toolDeltas.get(idx);

    if (!existing) {
      existing = {
        index: idx,
        id: tc.id ?? null,
        name: tc.function?.name ?? null,
        argsBuffer: "",
      };
      this.toolDeltas.set(idx, existing);
    }

    // Merge id if not set yet
    if (tc.id && !existing.id) {
      existing.id = tc.id;
    }

    // Merge name if not set yet
    if (tc.function?.name && !existing.name) {
      existing.name = tc.function.name;
    }

    // Append argument fragments
    if (tc.function?.arguments) {
      existing.argsBuffer += tc.function.arguments;
    }
  }

  drain(): StreamState {
    const toolCalls: CompleteToolCall[] = [];

    for (const delta of this.toolDeltas.values()) {
      if (!delta.name) continue;

      let args = delta.argsBuffer.trim();
      if (!args) {
        args = "{}";
      }

      // Attempt to parse — if invalid JSON, try to repair
      try {
        JSON.parse(args);
      } catch {
        // Some models emit trailing commas or incomplete JSON
        // Try basic repair: add closing braces/brackets
        args = this.attemptJsonRepair(args);
      }

      toolCalls.push({
        id: delta.id ?? `call_${delta.index}`,
        name: delta.name,
        arguments: args,
      });
    }

    return {
      content: this.content,
      toolCalls,
      done: this.done,
      usage: this.usage,
      thinking: this.thinking || null,
    };
  }

  isDone(): boolean {
    return this.done;
  }

  getContent(): string {
    return this.content;
  }

  getThinking(): string {
    return this.thinking;
  }

  reset(): void {
    this.content = "";
    this.toolDeltas.clear();
    this.done = false;
    this.usage = null;
    this.thinking = "";
    this.inThinking = false;
    this.buffer = "";
  }

  private attemptJsonRepair(raw: string): string {
    let repaired = raw;

    // Remove trailing commas before } or ]
    repaired = repaired.replace(/,(\s*[}\]])/g, "$1");

    // Count open/close braces and brackets
    let opens = 0;
    let closes = 0;
    for (const ch of repaired) {
      if (ch === "{" || ch === "[") opens++;
      if (ch === "}" || ch === "]") closes++;
    }

    // Add missing closing characters
    const diff = opens - closes;
    for (let i = 0; i < diff; i++) {
      // Determine what to close based on the last unclosed opener
      const lastOpenBrace = repaired.lastIndexOf("{");
      const lastOpenBracket = repaired.lastIndexOf("[");
      if (lastOpenBrace > lastOpenBracket) {
        repaired += "}";
      } else if (lastOpenBracket > lastOpenBrace) {
        repaired += "]";
      } else {
        repaired += "}";
      }
    }

    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      // If repair fails, return as-is wrapped in an object
      return JSON.stringify({ _raw: raw });
    }
  }
}

export function parseSSELines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      lines.push(trimmed);
    }
  }
  return lines;
}

export function createStreamParser(): StreamParser {
  return new StreamParser();
}
