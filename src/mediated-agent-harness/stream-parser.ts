import type {
  ChatCompletionChunk,
  CompleteToolCall,
  OllamaChatResponse,
  StreamState,
  Usage,
} from "./types.ts";

interface AccumulatedToolCall {
  name: string;
  argsBuffer: string;
}

export class StreamParser {
  private content = "";
  private toolCalls = new Map<number, AccumulatedToolCall>();
  private done = false;
  private usage: Usage | null = null;
  private thinking = "";
  private inThinking = false;
  private buffer = "";
  private onStreamingContent?: (text: string, isThinking: boolean) => void;

  constructor(onStreamingContent?: (text: string, isThinking: boolean) => void) {
    this.onStreamingContent = onStreamingContent;
  }

  feedOpenAI(chunk: ChatCompletionChunk): void {
    if (chunk.usage) {
      this.usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;

    if (choice.finish_reason) {
      this.done = true;
    }

    const delta = choice.delta;
    if (!delta) return;

    if (delta.content) {
      this.accumulateContent(delta.content);
    }

    // Handle reasoning/thinking deltas (common in OpenRouter/DeepSeek/etc.)
    const reasoning = (delta as any).reasoning_content || (delta as any).reasoning || (delta as any).thinking;
    if (reasoning) {
      this.thinking += reasoning;
      this.onStreamingContent?.(reasoning, true);
    }

    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        let existing = this.toolCalls.get(idx);
        
        if (!existing) {
          existing = { name: tc.function?.name ?? "", argsBuffer: "" };
          this.toolCalls.set(idx, existing);
        }

        if (tc.function?.name && !existing.name) {
          existing.name = tc.function.name;
        }

        if (tc.function?.arguments) {
          existing.argsBuffer += tc.function.arguments;
        }
      }
    }
  }

  feed(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    // Accumulate into buffer and try to parse complete JSON objects
    this.buffer += line;

    let chunk: OllamaChatResponse;
    try {
      chunk = JSON.parse(this.buffer);
      this.buffer = "";
    } catch {
      // Might be incomplete JSON — keep buffering.
      // But if the buffer is getting very large without parsing, clear it.
      if (this.buffer.length > 1_000_000) {
        this.buffer = "";
      }
      return;
    }

    // Handle done flag
    if (chunk.done) {
      this.done = true;

      // Extract usage from final chunk
      if (chunk.prompt_eval_count != null || chunk.eval_count != null) {
        const promptTokens = chunk.prompt_eval_count ?? 0;
        const completionTokens = chunk.eval_count ?? 0;
        this.usage = {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        };
      }
    }

    const message = chunk.message;
    if (!message) return;

    // Accumulate content
    if (message.content) {
      this.accumulateContent(message.content);
    }

    // Accumulate native thinking field
    if (message.thinking) {
      this.thinking += message.thinking;
      this.onStreamingContent?.(message.thinking, true);
    }

    // Accumulate tool calls (Ollama sends complete tool calls per line)
    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      for (let i = 0; i < message.tool_calls.length; i++) {
        const tc = message.tool_calls[i];
        if (!tc.function?.name) continue;

        const argsObj = tc.function.arguments ?? {};
        const argsStr = typeof argsObj === "string" ? argsObj : JSON.stringify(argsObj);

        // Merge with existing entry at this index
        const existing = this.toolCalls.get(i);
        if (existing) {
          // If we already have args and new args are non-empty, append
          if (argsStr && argsStr !== "{}") {
            existing.argsBuffer += argsStr;
          }
        } else {
          this.toolCalls.set(i, {
            name: tc.function.name,
            argsBuffer: argsStr,
          });
        }
      }
    }
  }

  private accumulateContent(text: string): void {
    // Detect thinking tags — some models still use tags even with native thinking
    if (text.includes("<think")) {
      this.inThinking = true;
      const afterThink = text.split("<think").pop() ?? "";
      this.thinking += afterThink;
      this.onStreamingContent?.(afterThink, true);
      return;
    }
    if (text.includes("</think")) {
      this.inThinking = false;
      const beforeClose = text.split("</think")[0] ?? "";
      this.thinking += beforeClose;
      this.onStreamingContent?.(beforeClose, true);
      // Content after </think is regular content
      const parts = text.split("</think");
      if (parts.length > 1) {
        const afterClose = parts.slice(1).join("</think");
        this.content += afterClose;
        this.onStreamingContent?.(afterClose, false);
      }
      return;
    }

    if (this.inThinking) {
      this.thinking += text;
      this.onStreamingContent?.(text, true);
    } else {
      this.content += text;
      this.onStreamingContent?.(text, false);
    }
  }

  drain(): StreamState {
    const toolCalls: CompleteToolCall[] = [];

    for (const [idx, accumulated] of this.toolCalls.entries()) {
      let args = accumulated.argsBuffer.trim();
      if (!args) {
        args = "{}";
      }

      // Attempt to parse — if invalid JSON, try to repair
      try {
        JSON.parse(args);
      } catch {
        args = this.attemptJsonRepair(args);
      }

      toolCalls.push({
        id: `call_${idx}`,
        name: accumulated.name,
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
    this.toolCalls.clear();
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
      const firstObject = this.extractFirstBalancedJsonObject(repaired);
      if (firstObject) {
        try {
          JSON.parse(firstObject);
          return firstObject;
        } catch {
          // Fall through to the wrapped raw payload.
        }
      }

      // If repair fails, return as-is wrapped in an object
      return JSON.stringify({ _raw: raw });
    }
  }

  private extractFirstBalancedJsonObject(raw: string): string | null {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
        continue;
      }

      if (ch === "}") {
        if (depth === 0) continue;
        depth--;
        if (depth === 0 && start >= 0) {
          return raw.slice(start, i + 1);
        }
      }
    }

    return null;
  }
}

export function parseNDJSONLines(text: string): string[] {
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
