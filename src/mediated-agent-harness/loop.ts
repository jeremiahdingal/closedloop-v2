import type {
  ChatMessage,
  CompleteToolCall,
  MediatedHarnessConfig,
  MediatedHarnessEvent,
  MediatedHarnessResult,
  OpenAIToolCall,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
  Usage,
} from "./types.ts";
import { StagnationError, ModelConnectionError, LoopTimeoutError } from "./errors.ts";
import { StreamParser } from "./stream-parser.ts";
import { WORKSPACE_TOOLS, executeToolCall } from "./tools.ts";
import { CallHistory, validateAndRepair } from "./validator.ts";

// ─── Main loop ──────────────────────────────────────────────────────────────

export interface LoopInput {
  systemPrompt: string;
  userPrompt: string;
  config: MediatedHarnessConfig;
  toolContext: ToolExecutionContext;
}

export async function runMediatedLoop(input: LoopInput): Promise<MediatedHarnessResult> {
  const {
    systemPrompt,
    userPrompt,
    config,
    toolContext,
  } = input;

  const baseURL = config.baseURL ?? "http://localhost:11434/v1";
  const apiKey = config.apiKey ?? "ollama";
  const maxIterations = config.maxIterations ?? 25;
  const timeoutMs = config.timeoutMs ?? 600_000;
  const temperature = config.temperature ?? 0;
  const emit = config.onEvent ?? (() => {});

  // Augment tool context with braveApiKey from config if not already set
  const ctx: ToolExecutionContext = toolContext.braveApiKey
    ? toolContext
    : { ...toolContext, braveApiKey: config.braveApiKey };

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const tools = WORKSPACE_TOOLS;
  const toolSchemaMap = new Map(tools.map(t => [t.function.name, t]));
  const history = new CallHistory();
  const collectedToolCalls: ToolCall[] = [];
  const startTime = Date.now();

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      throw new LoopTimeoutError(
        `Loop timed out after ${elapsed}ms (limit: ${timeoutMs}ms)`,
        elapsed,
        timeoutMs
      );
    }

    // Check stagnation
    if (iteration > 0) {
      const recentCalls = history.getRecentCalls(Infinity);
      if (history.hasRepeatedCalls(3)) {
        throw new StagnationError(
          "Identical tool calls detected 3 times in a row",
          iteration,
          "repeated_call"
        );
      }
      if (history.getConsecutiveErrors() >= 5) {
        throw new StagnationError(
          "5 consecutive tool errors",
          iteration,
          "consecutive_errors"
        );
      }
    }

    // Make streaming request
    let response: Response;
    try {
      response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          tools: tools.map(t => ({
            type: t.type,
            function: {
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters,
            },
          })),
          stream: true,
          temperature,
        }),
      });
    } catch (err) {
      throw new ModelConnectionError(
        `Failed to connect to model server: ${err instanceof Error ? err.message : String(err)}`,
        baseURL,
        err instanceof Error ? err : undefined
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ModelConnectionError(
        `Model server returned ${response.status}: ${body}`,
        baseURL
      );
    }

    // Parse streaming response
    const parser = new StreamParser();
    const reader = response.body?.getReader();
    if (!reader) {
      throw new ModelConnectionError("No response body from model server", baseURL);
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            parser.feed(trimmed);
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        parser.feed(buffer.trim());
      }
    } finally {
      reader.releaseLock();
    }

    const state = parser.drain();

    // Emit thinking if present (opportunistic)
    if (state.thinking) {
      emit({ kind: "thinking", text: state.thinking });
    }

    // Emit text content
    if (state.content) {
      emit({ kind: "text", text: state.content });
    }

    // If no API tool calls, check for XML-style tool calls or termination
    if (state.toolCalls.length === 0) {
      const text = state.content.trim();

      // Check for XML-style tool calls (common with qwen models)
      if (text) {
        const xmlCalls = extractXmlToolCalls(text);
        if (xmlCalls.length > 0) {
          // Treat XML tool calls as if they were API tool calls
          state.toolCalls = xmlCalls;
          // Fall through to the tool call processing below
        } else {
          // No tool calls at all — try to accept as JSON
          const jsonResult = extractJson(text);
          if (jsonResult) {
            emit({
              kind: "complete",
              result: text,
              iterations: iteration + 1,
            });
            return {
              text,
              toolCalls: collectedToolCalls,
              iterations: iteration + 1,
              usage: state.usage,
            };
          }

          // Not valid JSON — force tool call
          messages.push({ role: "assistant", content: text });
          messages.push({
            role: "user",
            content:
              "You produced text without a tool call. STOP. Call the 'finish' tool now " +
              "with 'summary' and 'result' parameters. Do not write any more text.",
          });
          continue;
        }
      }

      // Empty response — force a tool call
      if (iteration === 0) {
        messages.push({ role: "assistant", content: null });
        messages.push({
          role: "user",
          content: "No output. Call list_dir to start, then finish with your answer.",
        });
        continue;
      }

      throw new StagnationError(
        "Model produced empty response",
        iteration + 1,
        "no_progress"
      );
    }

    // Process tool calls
    const assistantToolCalls: OpenAIToolCall[] = [];
    const toolResults: ChatMessage[] = [];

    for (const completeCall of state.toolCalls) {
      // Validate and repair
      const validated = validateAndRepair(
        { name: completeCall.name, arguments: completeCall.arguments },
        toolSchemaMap,
        history,
        config.allowedPaths ?? ["*"]
      );

      if ("kind" in validated) {
        // Error — StagnationError or ToolValidationError
        if (validated instanceof StagnationError) {
          throw validated;
        }

        // ToolValidationError — feed error back to model
        const toolCall: ToolCall = {
          id: completeCall.id,
          name: completeCall.name,
          args: {},
        };
        emit({ kind: "tool_error", call: toolCall, error: validated.message });
        history.record(completeCall.name, {}, true);

        assistantToolCalls.push({
          id: completeCall.id,
          type: "function",
          function: {
            name: completeCall.name,
            arguments: completeCall.arguments,
          },
        });

        toolResults.push({
          role: "tool",
          content: `Error: ${validated.message}${validated.remediation ? ` Hint: ${validated.remediation}` : ""}`,
          tool_call_id: completeCall.id,
        });

        continue;
      }

      // Validated call
      const toolCall: ToolCall = {
        id: completeCall.id,
        name: validated.name,
        args: validated.args,
      };

      // Check for finish
      if (validated.name === "finish") {
        const summary = typeof validated.args.summary === "string" ? validated.args.summary : "";
        const result = typeof validated.args.result === "string" ? validated.args.result : "";
        collectedToolCalls.push(toolCall);
        emit({ kind: "tool_call", call: toolCall });
        emit({ kind: "tool_result", result: { callId: completeCall.id, name: "finish", output: summary } });
        emit({ kind: "complete", result, iterations: iteration + 1 });

        return {
          text: result,
          toolCalls: collectedToolCalls,
          iterations: iteration + 1,
          usage: state.usage,
        };
      }

      // Execute tool
      emit({ kind: "tool_call", call: toolCall });
      collectedToolCalls.push(toolCall);

      const result = await executeToolCall(toolCall, ctx);
      history.record(validated.name, validated.args, result.isError ?? false);

      emit({ kind: "tool_result", result });

      assistantToolCalls.push({
        id: completeCall.id,
        type: "function",
        function: {
          name: validated.name,
          arguments: JSON.stringify(validated.args),
        },
      });

      toolResults.push({
        role: "tool",
        content: result.output,
        tool_call_id: completeCall.id,
      });
    }

    // Append assistant message with tool calls
    messages.push({
      role: "assistant",
      content: state.content || null,
      tool_calls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
    });

    // Append tool results
    for (const tr of toolResults) {
      messages.push(tr);
    }
  }

  // Max iterations reached
  throw new StagnationError(
    `Maximum iterations (${maxIterations}) reached without completion`,
    maxIterations,
    "max_iterations"
  );
}

// ─── JSON extraction from text ──────────────────────────────────────────────

function extractJson(text: string): unknown | null {
  // Try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // Not direct JSON
  }

  // Try extracting JSON from code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // Not valid JSON in code block
    }
  }

  // Try extracting JSON from text (look for { ... } at top level)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

// ─── XML tool call extraction (qwen-style) ───────────────────────────────────

function extractXmlToolCalls(text: string): CompleteToolCall[] {
  const calls: CompleteToolCall[] = [];
  const fnRegex = /<function=([^>]+)>[\s\S]*?<\/function=\1>/g;
  let fnMatch: RegExpExecArray | null;

  while ((fnMatch = fnRegex.exec(text)) !== null) {
    const fnName = fnMatch[1];
    const fnBody = fnMatch[0];
    const args: Record<string, unknown> = {};
    const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter=\1>/g;
    let paramMatch: RegExpExecArray | null;

    while ((paramMatch = paramRegex.exec(fnBody)) !== null) {
      const paramName = paramMatch[1];
      const rawValue = paramMatch[2];
      try {
        args[paramName] = JSON.parse(rawValue);
      } catch {
        args[paramName] = rawValue;
      }
    }

    calls.push({
      id: "xml_call_" + calls.length,
      name: fnName,
      arguments: JSON.stringify(args),
    });
  }

  return calls;
}
