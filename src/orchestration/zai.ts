import type { AgentStreamPayload } from "../types.ts";

export type ZaiTaskInput = {
  role: string;
  prompt: string;
  runId?: string | null;
  ticketId?: string | null;
  epicId?: string | null;
  onStream?: (event: AgentStreamPayload) => void;
};

const ZAI_BASE_URL = process.env.ZAI_BASE_URL || "https://api.z.ai/api/anthropic";
const ZAI_API_KEY = process.env.ZAI_API_KEY || "";
const ZAI_MODEL = process.env.ZAI_MODEL || "claude-sonnet-4-20250514";

export class ZaiRunner {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultModel: string;

  constructor(opts?: { apiKey?: string; baseURL?: string; model?: string }) {
    this.apiKey = opts?.apiKey || ZAI_API_KEY;
    this.baseURL = opts?.baseURL || ZAI_BASE_URL;
    this.defaultModel = opts?.model || ZAI_MODEL;
  }

  /**
   * Resolve the actual model name from a `zai:` prefixed config value.
   * e.g. "zai:claude-sonnet-4-20250514" → "claude-sonnet-4-20250514"
   */
  resolveModel(configValue: string): string {
    if (configValue.startsWith("zai:")) return configValue.slice(4);
    return this.defaultModel;
  }

  async rawPrompt(
    role: string,
    prompt: string,
    model: string,
    onStream?: ZaiTaskInput["onStream"],
    meta?: { runId?: string | null; ticketId?: string | null; epicId?: string | null }
  ): Promise<string> {
    const url = `${this.baseURL}/v1/messages`;
    let sequence = 0;

    const emit = (streamKind: AgentStreamPayload["streamKind"], content: string, done = false) => {
      if (!content && !done) return;
      onStream?.({
        agentRole: role as AgentStreamPayload["agentRole"],
        source: "zai",
        streamKind,
        content,
        runId: meta?.runId ?? null,
        ticketId: meta?.ticketId ?? null,
        epicId: meta?.epicId ?? null,
        sequence: sequence++,
        done,
        metadata: { model },
      });
    };

    emit("system", `Calling Z AI (${model})...`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(900_000),
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Z AI returned ${response.status}: ${body}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body from Z AI");

    const decoder = new TextDecoder();
    let buffer = "";
    let combined = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("event:")) continue;
        if (!trimmed.startsWith("data:")) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);

          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            const text = event.delta.text;
            combined += text;
            emit("assistant", text);
          }

          if (event.type === "message_delta" && event.delta?.stop_reason) {
            emit("status", `completed (${event.delta.stop_reason})`, true);
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    return combined;
  }
}
