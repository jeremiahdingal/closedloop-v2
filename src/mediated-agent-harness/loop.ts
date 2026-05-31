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
import { WORKSPACE_TOOLS, BROWSER_TOOLS, executeToolCall, getAvailableToolsList, resetExploreModeFiles } from "./tools.ts";
import { CallHistory, validateAndRepair, stableStringify } from "./validator.ts";
import { computeBudget, shouldCompact, summarizeMessages, estimateMessagesTokens } from "./context-budget.ts";
import { classifyStall, computeStallLevel, getRecoveryAction, createStallState, recordStall, resetStallCounters, type StallState, type StallKind } from "./stall-recovery.ts";
import {
  loadDuplicateRecoveryState,
  persistDuplicateRecoveryState,
  checkDuplicateCall,
  isCallBanned,
  performDuplicateRecovery,
  recordPostRecoveryProgress,
  shouldForceFinishAfterRecovery,
} from "./duplicate-detector.ts";
import type { DuplicateRecoveryState } from "./types.ts";

const KNOWN_TOOL_NAMES = new Set([
  "explore_mode",
  "glob_files", "grep_files", "list_dir", "read_file", "read_files",
  "write_file", "write_files", "search_replace", "git_diff", "git_diff_staged",
  "git_status", "list_changed_files", "run_command", "finish", "finish_looplet",
  "web_search", "semantic_search", "read_artifact", "save_artifact"
]);

// ─── Main loop ──────────────────────────────────────────────────────────────

export interface LoopInput {
  systemPrompt: string;
  userPrompt: string;
  messages?: ChatMessage[];
  config: MediatedHarnessConfig;
  toolContext: ToolExecutionContext;
}

export function resolveModelContextWindow(model: string): number {
  let result = 65536;
  if (model.startsWith("glm-4.7")) result = 200000;
  else if (model.startsWith("qwen3.5:9b")) result = 65536;
  else if (model.startsWith("qwen3.5:4b")) result = 65536;
  else if (model.startsWith("qwen3.5:27b")) result = 65536;
  else if (model.includes("qwen3.6-35b")) result = 8192;
  else if (model.includes("qwen3.6-27b")) result = 65536;
  else if (model.startsWith("ibm/granite4.1:30b-q3")) result = 65536;
  else if (model.startsWith("ibm/granite4.1")) result = 32768;
  else if (model.startsWith("qwen3:14b")) result = 65536;
  else if (model.startsWith("devstral-small-2:24b")) result = 393216;
  else if (model.startsWith("qwen2.5-coder:14b")) result = 65536;
  return result;
}

export async function runMediatedLoop(input: LoopInput): Promise<MediatedHarnessResult> {
  const {
    systemPrompt,
    userPrompt,
    messages: initialMessages,
    config,
    toolContext,
  } = input;

  const baseURL = config.baseURL ?? "http://localhost:11434";
  const apiBackend = config.apiBackend ?? "ollama";
  const toolMode = config.toolMode ?? "native";
  const maxIterations = config.continuation?.maxIterations ?? config.maxIterations ?? 80;
  const timeoutMs = config.timeoutMs ?? 900_000;
  const temperature = config.temperature ?? 1.0;
  const topP = config.topP ?? 0.95;
  const topK = config.topK ?? 64;
  const numCtx = config.numCtx ?? resolveModelContextWindow(config.model);
  const idleThresholdMs = config.role === "coder" ? 600_000 : 60_000;
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? idleThresholdMs;
  const emit = config.onEvent ?? (() => {});

  // Augment tool context with braveApiKey from config if not already set
  const ctx: ToolExecutionContext = toolContext.braveApiKey
    ? toolContext
    : { ...toolContext, braveApiKey: config.braveApiKey };

  const messages: ChatMessage[] = initialMessages && initialMessages.length > 0
    ? initialMessages
    : [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

  // Filter tools by role
  const availableToolNames = config.role ? getAvailableToolsList(config.role) : Array.from(KNOWN_TOOL_NAMES);

  // Apply phase-aware tool allowlists if continuation is enabled
  const phaseAllowedTools = config.continuation?.enabled ? config.continuation.allowedToolsOverride : undefined;
  const effectiveAllowedTools = phaseAllowedTools && phaseAllowedTools.length > 0
    ? availableToolNames.filter(t => phaseAllowedTools.includes(t))
    : availableToolNames;

  const allowedToolSet = new Set(effectiveAllowedTools);
  const buildToolOnlyNudge = (reason: "text" | "empty" | "recovery" = "text") =>
    buildPhaseAwareToolOnlyNudge(config, effectiveAllowedTools, reason);

  // Include browser tools for playTester and tester roles if they are in the allowed list
  const needsBrowser = (role: string) => role === "playTester" || role === "tester";
  let tools = needsBrowser(config.role ?? "")
    ? [...WORKSPACE_TOOLS, ...BROWSER_TOOLS]
    : WORKSPACE_TOOLS;

  tools = tools.filter(t => allowedToolSet.has(t.function.name));

  const toolSchemaMap = new Map(tools.map(t => [t.function.name, t]));
  const history = new CallHistory();
  const collectedToolCalls: ToolCall[] = [];
  const startTime = Date.now();
  let lastActivityTime = startTime;
  let stallState = createStallState();
  const duplicateRecoverySessionKey = `${config.role ?? "unknown"}:${config.cwd}`;
  let dupRecoveryState = loadDuplicateRecoveryState(duplicateRecoverySessionKey);

  emit({ kind: "text", text: `--- SYSTEM PROMPT ---\n${systemPrompt}\n\n--- USER PROMPT ---\n${userPrompt}\n-------------------` });

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Check timeout — only throw if idle (no recent activity) beyond the limit
    const now = Date.now();
    const totalElapsed = now - startTime;
    const idleElapsed = now - lastActivityTime;
    if (totalElapsed > timeoutMs && idleElapsed > idleThresholdMs) {
      throw new LoopTimeoutError(
        `Loop timed out after ${totalElapsed}ms (limit: ${timeoutMs}ms, idle: ${idleElapsed}ms)`,
        totalElapsed,
        timeoutMs
      );
    }
    // No hard ceiling — rely on the idle-based timeout above

    // Check stagnation — use progressive stall recovery
    if (iteration > 0) {
      const repeatedCount = history.hasRepeatedCalls(10) ? 10 : 0;
      const stallKind = classifyStall({
        hasEmptyResponse: false,
        hasNoToolCalls: false,
        repeatedCallCount: repeatedCount,
        consecutiveErrors: history.getConsecutiveErrors(),
      });

      if (stallKind) {
        stallState = recordStall(stallState, stallKind);
        const level = computeStallLevel(stallKind, stallState.counts[stallKind], numCtx);
        const action = getRecoveryAction(stallKind, level, config.role, iteration, maxIterations);

        if (action.forceXmlMode) {
          stallState = { ...stallState, toolModeOverride: "xml" };
        }

        if (action.forceFinish || level === "forced") {
          throw new StagnationError(
            `Stall recovery forced finish after ${stallState.counts[stallKind]} consecutive ${stallKind} events`,
            iteration,
            "stall_recovery_forced"
          );
        }

        if (action.allowRetry) {
          messages.push({ role: "user", content: action.nudgeMessage });
          emit({ kind: "status", text: `Stall recovery nudge injected:\n${action.nudgeMessage}` });
          emit({ kind: "text", text: `[stall-recovery] ${stallKind} at ${level} level, nudging model...` });
          continue;
        } else {
          throw new StagnationError(
            `Stall recovery exhausted: ${stallKind} at ${level} level`,
            iteration,
            "stall_recovery_forced"
          );
        }
      }
    }


    // Early nudge at 60%: remind about structured JSON output
    if (iteration >= Math.floor(maxIterations * 0.6)) {
      const hasNudged = messages.some(m => typeof m.content === 'string' && m.content.includes('[BUDGET 60%]'));
      if (!hasNudged) {
        const budgetNudge = buildBudgetNudge(config.role, iteration, maxIterations, 0.6);
        if (budgetNudge) {
          messages.push({ role: "user", content: budgetNudge });
          emit({ kind: "text", text: `[nudge] 60% budget reached for ${config.role}...` });
        }
      }
    }

    // Convergence: at 80% iterations, force conclusion
    const convergenceThreshold = Math.floor(maxIterations * 0.8);
    if (iteration >= convergenceThreshold) {
      const hasConverged = messages.some(m => typeof m.content === 'string' && m.content.includes('[BUDGET 80%]'));
      if (!hasConverged) {
        if (config.role === "explorer") {
          resetExploreModeFiles();
        }
        const convergenceNudge = buildConvergenceNudge(config.role, iteration, maxIterations);
        if (convergenceNudge) {
          messages.push({ role: "user", content: convergenceNudge });
          emit({ kind: "text", text: `[convergence] Budget at 80%, forcing ${config.role} to conclude...` });
        }
      }
    }



    // Context budget check — applies to ALL roles
    if (iteration > 3) {
      const budget = computeBudget(messages, numCtx);
      const compactLevel = shouldCompact(budget);

      if (compactLevel !== "none") {
        const passNum = stallState.compaction.passCount + 1;
        emit({ kind: "text", text: `[context] Budget at ${Math.round(budget.usedFraction * 100)}%, summarizing history (pass ${passNum})...` });

        const result = await summarizeMessages(messages, numCtx, config.model, baseURL, stallState.compaction);
        if (result.removedTokens > 0) {
          messages.length = 0;
          messages.push(...result.messages);
          // Force the model to continue after compaction — without this it stalls
          // on the COMPACTED HISTORY blob and produces empty responses.
          messages.push({
            role: "user",
            content: buildPostCompactionResumePrompt(config.role)
          });
          stallState = {
            ...stallState,
            compaction: {
              passCount: passNum,
              totalRemovedTokens: stallState.compaction.totalRemovedTokens + result.removedTokens,
            },
          };
          emit({ kind: "text", text: `[context] Summarization pass ${passNum} complete: removed ${result.removedTokens} tokens (now at ${Math.round(estimateMessagesTokens(messages) / numCtx * 100)}%)` });
        }
      }
    }
    emit({ kind: "text", text: `[iteration ${iteration + 1}/${maxIterations}] Calling model...` });

    const effectiveToolMode = stallState.toolModeOverride ?? toolMode;
    const requestController = new AbortController();

    // Make streaming request to model backend
    let response: Response;
    try {
      if (apiBackend === "anthropic") {
        response = await fetchAnthropic(baseURL, config.apiKey ?? "", config.model, messages, tools, effectiveToolMode, systemPrompt, numCtx, requestController.signal);
      } else if (apiBackend === "openrouter") {
        response = await fetchOpenRouter(baseURL || "https://openrouter.ai/api/v1", config.apiKey ?? "", config.model, messages, tools, effectiveToolMode, temperature, topP, topK, numCtx, requestController.signal);
      } else {
        response = await fetchOllama(baseURL, config.model, messages, tools, effectiveToolMode, temperature, topP, topK, numCtx, config.noThink, requestController.signal);
      }
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

    // Repetition spiral detection
    let lastChunk = "";
    let repeatCount = 0;
    const SPIRAL_THRESHOLD = 5;
    let spiralDetected = false;
    const textSpiralGuard = createTextSpiralGuard();

    // Parse streaming response
    const parser = new StreamParser((text: string, isThinking: boolean) => {
      emit({ kind: isThinking ? "streaming_thinking" : "streaming_text", text });
      if (!isThinking && textSpiralGuard.feed(text)) {
        spiralDetected = true;
        emit({ kind: "text", text: "[spiral-detected] Repeated assistant text detected. Aborting stream." });
      }
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new ModelConnectionError("No response body from model server", baseURL);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const anthropicToolNames = new Map<number, string>();

    try {
      while (true) {
        const { done, value } = await readStreamChunkWithIdleTimeout(
          reader,
          streamIdleTimeoutMs,
          () => requestController.abort(),
        );
        if (done) break;
        if (spiralDetected) break;

        const decoded = decoder.decode(value, { stream: true });
        buffer += decoded;

        // Repetition spiral detection: same chunk repeated N times
        const trimmedChunk = decoded.trim();
        if (trimmedChunk.length > 10) {
          if (trimmedChunk === lastChunk) {
            repeatCount++;
            if (repeatCount >= SPIRAL_THRESHOLD) {
              spiralDetected = true;
              emit({ kind: "text", text: `[spiral-detected] Same chunk repeated ${repeatCount + 1} times. Aborting stream.` });
              break;
            }
          } else {
            lastChunk = trimmedChunk;
            repeatCount = 0;
          }
        }

        if (apiBackend === "anthropic") {
          // Anthropic SSE: event:\ndata:{json}\n\n
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const event of events) {
            const dataLine = event.split("\n").find(l => l.startsWith("data:"));
            if (!dataLine) continue;
            const jsonStr = dataLine.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const evt = JSON.parse(jsonStr);
              if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                parser.feed(JSON.stringify({ message: { content: evt.delta.text } }));
              } else if (evt.type === "content_block_delta" && evt.delta?.type === "thinking_delta") {
                parser.feed(JSON.stringify({ message: { content: "" }, thinking: evt.delta.thinking }));
              } else if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
                anthropicToolNames.set(evt.index, evt.content_block.name);
              } else if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta") {
                const idx = evt.index ?? 0;
                const name = anthropicToolNames.get(idx) ?? "";
                parser.feed(JSON.stringify({ message: { tool_calls: [{ function: { name, arguments: evt.delta.partial_json } }] } }));
              } else if (evt.type === "message_stop") {
                parser.feed(JSON.stringify({ done: true }));
              }
            } catch { /* skip malformed */ }
          }
        } else if (apiBackend === "openrouter") {
          // OpenAI SSE: data: {json}
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const event of events) {
            const dataLine = event.split("\n").find(l => l.startsWith("data:"));
            if (!dataLine) continue;
            const jsonStr = dataLine.slice(5).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;
            try {
              const chunk = JSON.parse(jsonStr);
              parser.feedOpenAI(chunk);
            } catch { /* skip */ }
          }
        } else {
          // Ollama NDJSON: one JSON object per line
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              parser.feed(trimmed);
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        if (apiBackend === "anthropic") {
          // Process any remaining SSE event
          const dataLine = buffer.split("\n").find(l => l.startsWith("data:"));
          if (dataLine) {
            try {
              const evt = JSON.parse(dataLine.slice(5).trim());
              if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                parser.feed(JSON.stringify({ message: { content: evt.delta.text } }));
              }
            } catch { /* skip */ }
          }
        } else if (apiBackend === "openrouter") {
           const dataLine = buffer.split("\n").find(l => l.startsWith("data:"));
           if (dataLine) {
             const jsonStr = dataLine.slice(5).trim();
             if (jsonStr && jsonStr !== "[DONE]") {
               try {
                 const chunk = JSON.parse(jsonStr);
                 parser.feedOpenAI(chunk);
               } catch { /* skip */ }
             }
           }
        } else {
          parser.feed(buffer.trim());
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (spiralDetected) {
      throw new StagnationError(
        "Repeated assistant text detected during streaming",
        iteration + 1,
        "no_progress"
      );
    }

    const state = parser.drain();
    let assistantText = state.content;
    lastActivityTime = Date.now();

    // If no API tool calls, check for XML-style tool calls or termination
    if (state.toolCalls.length === 0) {
      const text = assistantText.trim();

      // Check for XML-style tool calls (common with qwen models)
      if (text) {
        const xmlCalls = extractXmlToolCalls(text);
        if (xmlCalls.length > 0) {
          // Treat XML tool calls as if they were API tool calls
          state.toolCalls = xmlCalls;
          assistantText = stripXmlToolCalls(text);
          // Fall through to the tool call processing below
        } else {
          // No tool calls at all — try to accept as JSON
          if (state.thinking) {
            emit({ kind: "thinking", text: state.thinking });
          }

          if (assistantText) {
            emit({ kind: "text", text: assistantText });
          }

          const jsonCalls = extractJsonToolCalls(text);
          if (jsonCalls.length > 0) {
            state.toolCalls = jsonCalls;
            assistantText = "";
          } else {
          const jsonResult = extractJson(text);
          if (jsonResult && !requiresExplicitFinish(config.role)) {
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
          const forcedToolNudge = buildToolOnlyNudge("text");
          messages.push({
            role: "user",
            content: forcedToolNudge,
          });
          emit({ kind: "status", text: `Stall recovery nudge injected:\n${forcedToolNudge}` });
          continue;
        }
      }
      }

      // Empty response — force a tool call
      if (state.toolCalls.length > 0) {
        // XML extraction succeeded above; continue to normal tool handling below.
      } else if (iteration === 0) {
        messages.push({ role: "assistant", content: null });
        const emptyStartNudge = buildToolOnlyNudge("empty");
        messages.push({
          role: "user",
          content: emptyStartNudge,
        });
        emit({ kind: "status", text: `Stall recovery nudge injected:\n${emptyStartNudge}` });
        continue;
      }

      if (state.toolCalls.length === 0) {
        // Progressive stall recovery for empty/no-tool-call responses
        const kind: StallKind = assistantText ? "no_tool_calls" : "empty_response";
        stallState = recordStall(stallState, kind);
        const level = computeStallLevel(kind, stallState.counts[kind], numCtx);
        const action = getRecoveryAction(kind, level, config.role, iteration, maxIterations);

        if (action.forceXmlMode) {
          stallState = { ...stallState, toolModeOverride: "xml" };
        }

        if (action.forceFinish || level === "forced") {
          throw new StagnationError(
            `Stall recovery forced finish: ${kind} at ${level} level (${stallState.counts[kind]} occurrences)`,
            iteration + 1,
            "stall_recovery_forced"
          );
        }

        const nudgeMessage = config.continuation?.enabled ? buildToolOnlyNudge("recovery") : action.nudgeMessage;
        messages.push({ role: "assistant", content: state.content || "" });
        messages.push({ role: "user", content: nudgeMessage });
        emit({ kind: "status", text: `Stall recovery nudge injected:\n${nudgeMessage}` });
        emit({ kind: "text", text: `[stall-recovery] ${kind} at ${level} level, nudging...` });
        continue;
      }
    }

    if (state.thinking) {
      emit({ kind: "thinking", text: state.thinking });
    }

    lastActivityTime = Date.now();

    if (assistantText.trim()) {
      emit({ kind: "text", text: assistantText });
    }

    // Process tool calls
    const assistantToolCalls: OpenAIToolCall[] = [];
    const toolResults: ChatMessage[] = [];
    let recoveryTriggered = false;

    for (const completeCall of state.toolCalls) {
      // Role-based tool access control
      if (!allowedToolSet.has(completeCall.name)) {
        const errorMsg = `Unauthorized tool: ${completeCall.name}. Your current ${config.continuation?.enabled ? `phase (${config.continuation.phase})` : `role (${config.role})`} is only allowed to use: ${effectiveAllowedTools.join(", ")}`;
        emit({ kind: "tool_error", call: { id: completeCall.id, name: completeCall.name, args: {} }, error: errorMsg });

        assistantToolCalls.push({
          id: completeCall.id,
          type: "function",
          function: { name: completeCall.name, arguments: completeCall.arguments },
        });
        toolResults.push({
          role: "tool",
          content: `Error: ${errorMsg}`,
          tool_call_id: completeCall.id,
        });
        continue;
      }

      // Validate and repair
      const inferCtx = {
        recentPaths: history.getRecentPaths(),
        lastReadPath: history.getLastReadPath(),
      };
      const validated = validateAndRepair(
        { name: completeCall.name, arguments: completeCall.arguments },
        toolSchemaMap,
        history,
        config.allowedPaths ?? ["*"],
        inferCtx
      );

      if ("kind" in validated) {
        // Error — StagnationError or ToolValidationError
        if (validated instanceof StagnationError) {
          throw validated;
        }

        // ToolValidationError — check for duplicate failed validation before feeding back
        let rawArgs: Record<string, unknown> = {};
        try { rawArgs = JSON.parse(completeCall.arguments); } catch {}
        const rawHash = stableStringify(rawArgs);

        if (isCallBanned(completeCall.name, rawArgs, dupRecoveryState)) {
          const bannedMsg = `This exact call (${completeCall.name}) is BANNED because it previously failed validation with the same arguments. Fix the parameters.`;
          emit({ kind: "tool_error", call: { id: completeCall.id, name: completeCall.name, args: {} }, error: bannedMsg });
          history.record(completeCall.name, rawArgs, true, bannedMsg);
          assistantToolCalls.push({
            id: completeCall.id, type: "function",
            function: { name: completeCall.name, arguments: completeCall.arguments },
          });
          toolResults.push({ role: "tool", content: `Error: ${bannedMsg}`, tool_call_id: completeCall.id });
          continue;
        }

        const dupCheck = checkDuplicateCall(completeCall.name, rawArgs, history, dupRecoveryState);
        if (dupCheck.isDuplicate && dupCheck.bannedSignature && dupRecoveryState.recoveryCount < 2) {
          console.log(`  [DUPLICATE-RECOVERY] ${completeCall.name} repeated validation error — compacting and restarting`);
          emit({
            kind: "duplicate_recovery",
            bannedCall: `${completeCall.name}(${completeCall.arguments.slice(0, 80)})`,
            recoveryCount: dupRecoveryState.recoveryCount + 1,
          });
          const recoveryPrompt = await performDuplicateRecovery(
            messages, systemPrompt, dupCheck.bannedSignature, numCtx, baseURL, config.model,
          );
          dupRecoveryState = {
            bannedSignatures: [...dupRecoveryState.bannedSignatures, dupCheck.bannedSignature],
            recoveryCount: dupRecoveryState.recoveryCount + 1,
            postRecoveryCallCount: 0, isInRecovery: true, hasMadeProgress: false,
          };
          persistDuplicateRecoveryState(duplicateRecoverySessionKey, dupRecoveryState);
          messages.length = 0;
          messages.push({ role: "system", content: systemPrompt }, { role: "user", content: recoveryPrompt });
          stallState = createStallState();
          emit({ kind: "text", text: `[duplicate-recovery] Restart #${dupRecoveryState.recoveryCount}: validation-error loop, banned ${completeCall.name}` });
          recoveryTriggered = true;
          break;
        }

        // ToolValidationError — feed error back to model
        const toolCall: ToolCall = {
          id: completeCall.id,
          name: completeCall.name,
          args: {},
        };
        emit({ kind: "tool_error", call: toolCall, error: validated.message });
        history.record(completeCall.name, rawArgs, true, validated.message);

        console.log(`  [ERROR] ${completeCall.name}: ${validated.message}`);

        assistantToolCalls.push({
          id: completeCall.id,
          type: "function",
          function: {
            name: completeCall.name,
            arguments: completeCall.arguments,
          },
        });

        let hintSuffix = validated.remediation ? ` Hint: ${validated.remediation}` : "";
        if (ctx.db && ctx.ragIndexId) {
          try {
            const { buildToolingContext } = await import("../rag/context-builder.ts");
            const repairHint = await buildToolingContext({
              role: config.role || "builder",
              availableTools: [], // We only want repair hints here
              db: ctx.db,
              indexId: ctx.ragIndexId,
              includeRepair: true,
              maxTokens: 500,
            });
            if (repairHint) {
              hintSuffix += `\n\n${repairHint}`;
            }
          } catch (err) {
            console.warn(`[Harness] Failed to fetch repair hint: ${err}`);
          }
        }

        toolResults.push({
          role: "tool",
          content: `Error: ${validated.message}${hintSuffix}`,
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

        console.log(`  [FINISH] ${summary}`);

        return {
          text: result,
          toolCalls: collectedToolCalls,
          iterations: iteration + 1,
          usage: state.usage,
        };
      }

      // Check for finish_looplet
      if (validated.name === "finish_looplet") {
        const summary = typeof validated.args.summary === "string" ? validated.args.summary : "";
        const phaseComplete = typeof validated.args.phaseComplete === "boolean" ? validated.args.phaseComplete : false;
        const requestedNextPhase = typeof validated.args.requestedNextPhase === "string" ? validated.args.requestedNextPhase : undefined;
        const evidenceUpdates = Array.isArray(validated.args.evidenceUpdates) ? validated.args.evidenceUpdates : [];
        const ticketUpdates = Array.isArray(validated.args.ticketUpdates) ? validated.args.ticketUpdates : [];
        const finalCandidate = validated.args.finalCandidate;

        const loopletResult = JSON.stringify({
          phaseComplete,
          requestedNextPhase,
          evidenceUpdates,
          ticketUpdates,
          finalCandidate,
        });

        collectedToolCalls.push(toolCall);
        emit({ kind: "tool_call", call: toolCall });
        emit({ kind: "tool_result", result: { callId: completeCall.id, name: "finish_looplet", output: summary } });
        emit({ kind: "complete", result: loopletResult, iterations: iteration + 1 });

        console.log(`  [FINISH_LOOPLET] ${summary} (phaseComplete=${phaseComplete})`);

        return {
          text: loopletResult,
          toolCalls: collectedToolCalls,
          iterations: iteration + 1,
          usage: state.usage,
        };
      }

      // ── Duplicate recovery: check for banned or duplicate failed calls ──
      if (isCallBanned(validated.name, validated.args, dupRecoveryState)) {
        const bannedMsg = `This exact call (${validated.name} with these arguments) is BANNED because it previously failed with the same arguments. You must use different arguments or a completely different approach. Do NOT repeat this call.`;
        emit({ kind: "tool_error", call: toolCall, error: bannedMsg });
        history.record(validated.name, validated.args, true, bannedMsg);

        assistantToolCalls.push({
          id: completeCall.id,
          type: "function",
          function: { name: validated.name, arguments: JSON.stringify(validated.args) },
        });
        toolResults.push({
          role: "tool",
          content: `Error: ${bannedMsg}`,
          tool_call_id: completeCall.id,
        });
        continue;
      }

      const dupCheck = checkDuplicateCall(validated.name, validated.args, history, dupRecoveryState);
      if (dupCheck.isDuplicate && dupCheck.bannedSignature && dupRecoveryState.recoveryCount < 2) {
        console.log(`  [DUPLICATE-RECOVERY] ${validated.name} repeated after error — compacting and restarting (recovery #${dupRecoveryState.recoveryCount + 1})`);
        emit({
          kind: "duplicate_recovery",
          bannedCall: `${validated.name}(${JSON.stringify(validated.args).slice(0, 80)})`,
          recoveryCount: dupRecoveryState.recoveryCount + 1,
        });

        const recoveryPrompt = await performDuplicateRecovery(
          messages, systemPrompt, dupCheck.bannedSignature, numCtx, baseURL, config.model,
        );

        dupRecoveryState = {
          bannedSignatures: [...dupRecoveryState.bannedSignatures, dupCheck.bannedSignature],
          recoveryCount: dupRecoveryState.recoveryCount + 1,
          postRecoveryCallCount: 0,
          isInRecovery: true,
          hasMadeProgress: false,
        };
        persistDuplicateRecoveryState(duplicateRecoverySessionKey, dupRecoveryState);

        // Clear messages and inject recovery context
        messages.length = 0;
        messages.push(
          { role: "system", content: systemPrompt },
          { role: "user", content: recoveryPrompt },
        );

        // Reset stall state since we have a fresh context
        stallState = createStallState();

        emit({ kind: "text", text: `[duplicate-recovery] Restart #${dupRecoveryState.recoveryCount}: compacted context, banned ${validated.name}` });

        recoveryTriggered = true;
        break;
      }

      // Execute tool
      emit({ kind: "tool_call", call: toolCall });
      collectedToolCalls.push(toolCall);

      console.log(`  [TOOL] ${validated.name}(${JSON.stringify(validated.args).slice(0, 100)})`);

      const result = await executeToolCall(toolCall, ctx);
      const resultError = result.isError ? result.output.slice(0, 200) : undefined;
      history.record(validated.name, validated.args, result.isError ?? false, resultError);

      // Reset stall counters on successful tool execution
      if (!result.isError) {
        stallState = resetStallCounters(stallState);
      }

      // Call afterToolResult hook if continuation is enabled
      if (config.continuation?.enabled && config.continuation.afterToolResult) {
        try {
          const update = await config.continuation.afterToolResult({
            role: config.role ?? "",
            phase: config.continuation.phase,
            toolName: validated.name,
            args: validated.args,
            resultText: result.output,
            state: config.continuation.state,
          });

          if (update.shouldEndLooplet) {
            // Return early with continuation state
            return {
              text: JSON.stringify(update.state),
              toolCalls: collectedToolCalls,
              iterations: iteration + 1,
              usage: state.usage,
            };
          }

          if (update.nudge) {
            messages.push({ role: "user", content: update.nudge });
            emit({ kind: "status", text: `Continuation nudge: ${update.nudge}` });
          }
        } catch (err) {
          console.warn(`[Harness] afterToolResult hook failed: ${err}`);
        }
      }

      // Post-recovery progress tracking
      if (dupRecoveryState.isInRecovery) {
        dupRecoveryState = recordPostRecoveryProgress(dupRecoveryState, result.isError ?? false);
        if (!result.isError) {
          dupRecoveryState = { ...dupRecoveryState, hasMadeProgress: true };
        }
        persistDuplicateRecoveryState(duplicateRecoverySessionKey, dupRecoveryState);
        if (shouldForceFinishAfterRecovery(dupRecoveryState)) {
          const recoveryNudge = config.continuation?.enabled
            ? buildToolOnlyNudge("recovery")
            : "[SYSTEM] No progress after recovery. You MUST call the finish tool NOW with whatever you have.";
          messages.push({
            role: "user",
            content: recoveryNudge,
          });
          emit({ kind: "text", text: `[duplicate-recovery] No progress after 3 calls post-recovery, forcing a valid phase tool...` });
        }
      }

      emit({ kind: "tool_result", result });

      console.log(`  [RESULT] ${validated.name}: ${result.output.slice(0, 100)}${result.output.length > 100 ? '...' : ''}`);

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

    // If recovery was triggered, skip appending and continue to next iteration
    if (recoveryTriggered) {
      continue;
    }

    // Append assistant message with tool calls
    messages.push({
      role: "assistant",
      content: assistantText || "",
      tool_calls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
    });

    // Append tool results
    for (const tr of toolResults) {
      messages.push(tr);
    }
    lastActivityTime = Date.now();
  }

  // Max iterations reached
  throw new StagnationError(
    `Maximum iterations (${maxIterations}) reached without completion`,
    maxIterations,
    "max_iterations"
  );
}

function requiresExplicitFinish(role?: string): boolean {
  return role === "builder"
    || role === "reviewer"
    || role === "tester"
    || role === "epicDecoder"
    || role === "epicReviewer"
    || role === "playTester"
    || role === "explorer"
    || role === "coder";
}

async function readStreamChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new LoopTimeoutError(
        `Model stream produced no chunks for ${timeoutMs}ms`,
        timeoutMs,
        timeoutMs,
      ));
      setTimeout(onTimeout, 0);
    }, timeoutMs);
  });

  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildPhaseAwareToolOnlyNudge(
  config: MediatedHarnessConfig,
  effectiveAllowedTools: string[],
  reason: "text" | "empty" | "recovery",
): string {
  const allowedTools = effectiveAllowedTools.length > 0
    ? effectiveAllowedTools
    : config.continuation?.allowedToolsOverride ?? [];
  const toolList = allowedTools.length > 0 ? allowedTools.join(", ") : "the provided tools";
  const canFinishLooplet = allowedTools.includes("finish_looplet");
  const canFinish = allowedTools.includes("finish");
  const completionTool = canFinishLooplet
    ? "finish_looplet"
    : canFinish
      ? "finish"
      : null;
  const reasonLine = reason === "empty"
    ? "No output was produced."
    : reason === "recovery"
      ? "Recovery needs one concrete tool call now."
      : "You produced text without using the tool interface.";

  if (config.continuation?.enabled) {
    return [
      "continue",
      "",
      `${reasonLine} STOP writing prose. Use a tool call only.`,
      `Current phase: ${config.continuation.phase}.`,
      `Allowed tools now: ${toolList}.`,
      completionTool
        ? `If this phase is complete, call ${completionTool} with valid JSON arguments.`
        : "Call the next allowed tool with valid JSON arguments.",
      "Do not narrate the plan. Do not write markdown. Make exactly one valid tool call.",
    ].join("\n");
  }

  return [
    "continue",
    "",
    `${reasonLine} STOP writing prose. Use tool calls only.`,
    canFinish
      ? "If you are done, call the finish tool with summary and result parameters."
      : `Call one of these tools now: ${toolList}.`,
    "Do not write any more text.",
  ].join("\n");
}

function buildPostCompactionResumePrompt(role?: string): string {
  if (role === "coder") {
    return [
      "[SYSTEM] Context compacted. Resume from compacted history and git state.",
      "",
      "1. Call git_diff to see current changes on disk.",
      "2. Read only the file you need to edit next.",
      "3. Make the edit, then call finish with the result JSON.",
      "Do NOT restart exploration. Do NOT search for context files.",
    ].join("\n");
  }

  if (role === "epicDecoder") {
    return [
      "[SYSTEM] Context compacted. Resume from compacted history.",
      "Call finish_looplet with ticketUpdates or evidenceUpdates, or call finish with the GoalDecomposition JSON.",
      "Do NOT re-read files already in compacted history.",
    ].join("\n");
  }

  if (role === "builder") {
    return [
      "[SYSTEM] Context compacted. Resume from compacted history and git state.",
      "Call git_diff to check progress, then continue with the next edit or call finish.",
      "Do NOT restart exploration.",
    ].join("\n");
  }

  if (role === "reviewer") {
    return [
      "[SYSTEM] Context compacted. Resume from compacted history.",
      "Produce your verdict now. Call finish with {\"approved\":true/false,\"blockers\":[],\"suggestions\":[],\"riskLevel\":\"low\"}.",
    ].join("\n");
  }

  if (role === "explorer") {
    return [
      "[SYSTEM] Context compacted. Resume from compacted history.",
      "Answer the next open question or finalize the explorer packet. Call finish with the JSON result.",
      "Do NOT re-read files already in compacted history.",
    ].join("\n");
  }

  return [
    "[SYSTEM] Context compacted. Resume from compacted history.",
    "Call the next tool or finish with your result. Do not restart.",
  ].join("\n");
}

// ─── Budget nudge builders ──────────────────────────────────────────────────

function buildBudgetNudge(role: string | undefined, iteration: number, maxIterations: number, fraction: number): string | null {
  if (!role) return null;
  const pct = Math.round(fraction * 100);

  if (role === "explorer") {
    return `[BUDGET ${pct}%] Iteration ${iteration + 1}/${maxIterations}. Start wrapping up. When you call finish, "result" must be raw JSON:\n{"summary":"...","relevantFiles":["..."],"recommendedFilesForCoding":["..."],"keyPatterns":"...","unresolvedBlockers":"..."}\nNo markdown, no code fences.`;
  }

  if (role === "epicDecoder") {
    return `[BUDGET ${pct}%] Iteration ${iteration + 1}/${maxIterations}. If you have ticket skeletons, call finish_looplet with ticketUpdates. If all phases are done, call finish with the GoalDecomposition JSON.`;
  }

  if (role === "builder" || role === "coder") {
    return `[BUDGET ${pct}%] Iteration ${iteration + 1}/${maxIterations}. If you have made changes, verify them and call finish with the result JSON.`;
  }

  if (role === "reviewer") {
    return `[BUDGET ${pct}%] Iteration ${iteration + 1}/${maxIterations}. Produce your verdict now. Call finish with {"approved":true/false,"blockers":[...],"suggestions":[...],"riskLevel":"low|medium|high"}`;
  }

  return `[BUDGET ${pct}%] Iteration ${iteration + 1}/${maxIterations}. Start wrapping up. Call finish or finish_looplet with your result.`;
}

function buildConvergenceNudge(role: string | undefined, iteration: number, maxIterations: number): string | null {
  if (!role) return null;

  if (role === "explorer") {
    return `[BUDGET 80%] Iteration ${iteration + 1}/${maxIterations}. STOP exploring. Call finish NOW with result as raw JSON:\n{"summary":"...","relevantFiles":["..."],"recommendedFilesForCoding":["..."],"keyPatterns":"...","unresolvedBlockers":"none"}\nNo markdown fences.`;
  }

  if (role === "epicDecoder") {
    return `[BUDGET 80%] Iteration ${iteration + 1}/${maxIterations}. STOP iterating. Call finish with the GoalDecomposition JSON NOW:\n{"summary":"...","tickets":[{"id":"...","title":"...","description":"...","acceptanceCriteria":["..."],"dependencies":[],"priority":"high|medium|low"}]}`;
  }

  if (role === "builder" || role === "coder") {
    return `[BUDGET 80%] Iteration ${iteration + 1}/${maxIterations}. STOP editing. Call finish NOW with your result JSON.`;
  }

  if (role === "reviewer") {
    return `[BUDGET 80%] Iteration ${iteration + 1}/${maxIterations}. Call finish NOW with verdict JSON: {"approved":true/false,"blockers":[],"suggestions":[],"riskLevel":"low"}`;
  }

  if (role === "epicReviewer") {
    return `[BUDGET 80%] Iteration ${iteration + 1}/${maxIterations}. Produce epic verdict now. Call finish with {"verdict":"approved|needs_followups|failed","summary":"...","followupTickets":[]}`;
  }

  if (role === "tester") {
    return `[BUDGET 80%] Iteration ${iteration + 1}/${maxIterations}. Produce test summary now. Call finish with the test result JSON.`;
  }

  return `[BUDGET 80%] Iteration ${iteration + 1}/${maxIterations}. Call finish or finish_looplet NOW.`;
}

// ─── JSON extraction from text ──────────────────────────────────────────────

function createTextSpiralGuard(): { feed(text: string): boolean } {
  let visibleText = "";
  return {
    feed(text: string): boolean {
      visibleText = (visibleText + text).slice(-12_000);
      const paragraphs = visibleText
        .split(/\n\s*\n+/)
        .map(normalizeSpiralText)
        .filter((paragraph) => paragraph.length >= 80);

      if (paragraphs.length < 4) return false;

      for (let blockSize = 1; blockSize <= 4; blockSize++) {
        if (paragraphs.length < blockSize * 4) continue;
        const lastBlock = paragraphs.slice(-blockSize).join("\n");
        let repeated = 1;
        for (let end = paragraphs.length - blockSize; end >= blockSize; end -= blockSize) {
          const candidate = paragraphs.slice(end - blockSize, end).join("\n");
          if (candidate !== lastBlock) break;
          repeated++;
        }
        if (repeated >= 4) return true;
      }
      return false;
    },
  };
}

function normalizeSpiralText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\[[^\]]+\]\s*/g, "")
    .trim()
    .toLowerCase();
}

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

// ─── XML and Python-style tool call extraction ──────────────────────────────

function extractXmlToolCalls(text: string): CompleteToolCall[] {
  const calls: CompleteToolCall[] = [];

  // 1. Stage 1: Find "Anchors" (XML tags that signal a tool call)
  // Matches <tag=val>, <tag name=val>, or <tool_name>
  // Extremely permissive closing tag support to handle GLM quirks
  const anchorRegex = /<(function|invoke|function_call|call_tool|tool_name|[\w_-]+)(?:[=\s](?:name|tool_name)="?([\w_-]+)"?|="?([\w_-]+)"?)?([\s\S]*?)>([\s\S]*?)(?:<\/\1(?:=[^>]+)?>|<\/\1>|<\/function>|<\/invoke>|$)/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(text)) !== null) {
    const tagName = match[1].toLowerCase();
    const attrName = (match[2] || match[3] || "").toLowerCase();
    const body = match[5].trim();

    let fnName = "";
    let fnBody = body;

    // Resolve the intended function name
    if (KNOWN_TOOL_NAMES.has(attrName)) {
      fnName = attrName;
    } else if (KNOWN_TOOL_NAMES.has(tagName)) {
      fnName = tagName;
    } else {
      // Handles content-as-name (e.g. <function>read_file</function>)
      const firstWord = body.split(/[<\s\n]/)[0].trim().toLowerCase();
      if (KNOWN_TOOL_NAMES.has(firstWord)) {
        fnName = firstWord;
        fnBody = body.substring(fnName.length).trim();
      }
    }

    if (!fnName) continue;

    // Resolve Arguments
    const args: Record<string, unknown> = {};

    // Support sequential fragments: look ahead in text if body is short
    let searchSpace = fnBody;
    if (fnBody.length < 50) {
      searchSpace += "\n" + text.substring(match.index + match[0].length, match.index + match[0].length + 400);
    }

    // A. Sub-tag extraction (<parameter>, <arg>, <path>, etc.)
    const argRegex = /<(parameter|arg|argument|args|arguments|path|pattern|name|[\w_-]+)(?:[=\s]name="?([\w_-]+)"?|="?([\w_-]+)"?)?>([\s\S]*?)<\/\1>/gi;
    let argMatch: RegExpExecArray | null;
    while ((argMatch = argRegex.exec(searchSpace)) !== null) {
      const pTagName = argMatch[1].toLowerCase();
      const pAttrName = argMatch[2] || argMatch[3];
      const pVal = argMatch[4].trim();

      if (KNOWN_TOOL_NAMES.has(pTagName) && pTagName !== fnName) continue;

      const pName = pAttrName || (["parameter", "arg", "argument", "args", "arguments"].includes(pTagName) ? null : pTagName);

      if (pName) {
        args[pName] = parseXmlParameterValue(fnName, pName, pVal);
      } else {
        // Robust KV split: handles "path>val", "path:val", "path=val"
        const kvMatch = /^([\w_-]+)[:=>]([\s\S]*)$/.exec(pVal);
        if (kvMatch) {
          const key = kvMatch[1], val = kvMatch[2].trim();
          args[key] = parseXmlParameterValue(fnName, key, val);
        } else {
          // Positional mapping
          if (["read_file", "list_dir"].includes(fnName)) args["path"] = pVal;
          else if (["glob_files", "grep_files"].includes(fnName)) args["pattern"] = pVal;
          else if (fnName === "run_command") args["name"] = pVal;
          else if (["web_search", "semantic_search"].includes(fnName)) args["query"] = pVal;
        }
      }
    }

    // B. Bare JSON inside search space
    if (Object.keys(args).length === 0) {
      const jsonMatch = /\{[\s\S]*?\}/.exec(searchSpace);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0].replace(/'/g, '"'));
          if (typeof parsed === "object" && parsed !== null) Object.assign(args, parsed);
        } catch {}
      }
    }

    // C. Attribute-based arguments
    const attributes = match[4] ?? "";
    const argsAttrMatch = /(?:args|arguments|parameters)=(?:'([^']+)'|"([^"]+)")/.exec(attributes);
    if (argsAttrMatch) {
      try {
        const decoded = (argsAttrMatch[1] || argsAttrMatch[2]).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        Object.assign(args, JSON.parse(decoded));
      } catch {}
    }

    calls.push({ id: "unified_" + calls.length, name: fnName, arguments: JSON.stringify(args) });
    anchorRegex.lastIndex = match.index + match[0].length;
  }

  // 2. Python-style Fallback (Only if Stage 1 found nothing)
  if (calls.length === 0) {
    const pyRegex = /([\w_-]+)\(([\s\S]*?)\)/g;
    let pyMatch: RegExpExecArray | null;
    while ((pyMatch = pyRegex.exec(text)) !== null) {
      const name = pyMatch[1].toLowerCase();
      if (!KNOWN_TOOL_NAMES.has(name)) continue;
      const pyBody = pyMatch[2].trim();
      const pyArgs: Record<string, unknown> = {};
      if (pyBody && !pyBody.includes("=") && !pyBody.includes(":")) {
        if (["read_file", "list_dir"].includes(name)) pyArgs["path"] = pyBody.replace(/^["']|["']$/g, "");
      } else {
        const argMatchRegex = /([\w_-]+)\s*[:=]\s*("[^"]*"|'[^']*'|[^,)]+)/g;
        let am: RegExpExecArray | null;
        while ((am = argMatchRegex.exec(pyBody)) !== null) {
          const k = am[1], v = am[2].trim().replace(/^["']|["']$/g, "");
          try { pyArgs[k] = JSON.parse(v); } catch { pyArgs[k] = v; }
        }
      }
      calls.push({ id: "py_" + calls.length, name, arguments: JSON.stringify(pyArgs) });
    }
  }

  return calls;
}

function stripXmlToolCalls(text: string): string {
  return text
    .replace(/<(function|invoke|function_call|call_tool|tool_name|[\w_-]+)(?:[\s=][^>]*)?>[\s\S]*?(?:<\/\1(?:=[^>]+)?>|<\/function>|<\/invoke>|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJsonToolCalls(text: string): CompleteToolCall[] {
  const normalizeArgs = (raw: unknown): Record<string, unknown> | null => {
    if (raw === undefined || raw === null) return {};
    if (typeof raw === "string") {
      try {
        const parsedArgs = JSON.parse(raw);
        if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
          return parsedArgs as Record<string, unknown>;
        }
      } catch {
        return null;
      }
      return null;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return null;
  };

  const toCall = (entry: unknown, idx: number): CompleteToolCall | null => {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const fn = (record.function && typeof record.function === "object")
      ? (record.function as Record<string, unknown>)
      : undefined;

    const nameCandidate =
      (typeof record.tool_name === "string" ? record.tool_name : "") ||
      (typeof record.name === "string" ? record.name : "") ||
      (typeof fn?.name === "string" ? fn.name : "");
    const name = nameCandidate.trim();
    if (!name || !KNOWN_TOOL_NAMES.has(name)) return null;

    const argsRaw = record.arguments ?? record.args ?? fn?.arguments ?? {};
    const args = normalizeArgs(argsRaw);
    if (!args) return null;

    return {
      id: `json_${idx}`,
      name,
      arguments: JSON.stringify(args),
    };
  };

  const calls: CompleteToolCall[] = [];

  const addFromParsed = (parsed: unknown): void => {
    let entries: unknown[] = [];
    if (Array.isArray(parsed)) {
      entries = parsed;
    } else if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      entries = Array.isArray(record.tool_calls) ? record.tool_calls : [parsed];
    }

    for (const entry of entries) {
      const call = toCall(entry, calls.length);
      if (call) calls.push(call);
    }
  };

  const direct = extractJson(text);
  if (direct) {
    addFromParsed(direct);
  }

  if (calls.length === 0) {
    const snippets = extractTopLevelJsonObjects(text);
    for (const snippet of snippets) {
      try {
        addFromParsed(JSON.parse(snippet));
      } catch {
        // Ignore malformed snippets
      }
    }
  }

  return calls;
}

function extractTopLevelJsonObjects(text: string): string[] {
  const snippets: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
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
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        snippets.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return snippets;
}

function parseXmlParameterValue(toolName: string, paramName: string, rawValue: string): unknown {
  const value = rawValue.trim();

  // finish.result is intentionally a JSON string payload, not an object
  if (toolName === "finish" && (paramName === "result" || paramName === "summary")) {
    return value;
  }

  if (!value) {
    return value;
  }

  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);

  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]")) ||
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    try {
      return JSON.parse(value.replace(/^'([\s\S]*)'$/, '"$1"'));
    } catch {
      return value;
    }
  }

  return value;
}

// ─── Ollama message conversion ────────────────────────────────────────────────

function convertToOllamaMessage(msg: ChatMessage): Record<string, unknown> {
  if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls.map(tc => ({
        function: {
          name: tc.function.name,
          arguments: parseArgsToObject(tc.function.arguments),
        },
      })),
    };
  }

  if (msg.role === "tool") {
    return {
      role: "tool",
      content: msg.content ?? "",
      tool_call_id: msg.tool_call_id,
    };
  }

  return {
    role: msg.role,
    content: msg.content ?? "",
  };
}

function parseArgsToObject(argsStr: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return {};
}

// ─── Backend fetch helpers ────────────────────────────────────────────────────

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

function appendAnthropicBlocks(
  messages: AnthropicMessage[],
  role: "user" | "assistant",
  blocks: AnthropicContentBlock[],
): void {
  if (blocks.length === 0) return;
  const last = messages[messages.length - 1];
  if (last?.role === role) {
    last.content.push(...blocks);
    return;
  }
  messages.push({ role, content: [...blocks] });
}

function convertToAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parseArgsToObject(tc.function.arguments),
          });
        }
      }
      appendAnthropicBlocks(anthropicMessages, "assistant", blocks);
      continue;
    }

    if (msg.role === "tool") {
      appendAnthropicBlocks(anthropicMessages, "user", [{
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "tool_call_unknown",
        content: msg.content ?? "",
        ...(msg.content?.startsWith("Error:") ? { is_error: true } : {}),
      }]);
      continue;
    }

    if (msg.content) {
      appendAnthropicBlocks(anthropicMessages, "user", [{ type: "text", text: msg.content }]);
    }
  }

  return anthropicMessages;
}

async function fetchOllama(
  baseURL: string,
  model: string,
  messages: ChatMessage[],
  tools: any[],
  toolMode: string,
  temperature: number,
  topP: number,
  topK: number,
  numCtx: number,
  noThink?: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${baseURL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      messages: messages.map(convertToOllamaMessage),
      ...(toolMode === "native" ? {
        tools: tools.map(t => ({
          type: t.type,
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          },
        })),
      } : {}),
      stream: true,
      think: noThink ? false : undefined,
      options: { temperature, top_p: topP, top_k: topK, num_ctx: numCtx, num_gpu: -1 },
    }),
  });
}

async function fetchAnthropic(
  baseURL: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: any[],
  toolMode: string,
  systemPrompt: string,
  _numCtx: number,
  signal?: AbortSignal,
): Promise<Response> {
  const anthropicMessages = convertToAnthropicMessages(messages);
  const anthropicTools = toolMode === "native" ? tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  })) : undefined;

  return fetch(`${baseURL}/v1/messages`, {
    method: "POST",
    signal,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      stream: true,
      system: systemPrompt,
      messages: anthropicMessages,
      ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
    }),
  });
}

async function fetchOpenRouter(
  baseURL: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: any[],
  toolMode: string,
  temperature: number,
  topP: number,
  _topK: number,
  _numCtx: number,
  signal?: AbortSignal,
): Promise<Response> {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const body = {
    model,
    messages: [{ role: "user", content: "Hello" }],
    stream: true
  };

  return fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/google/gemini-cli",
      "X-Title": "Gemini CLI Integration Test"
    },
    body: JSON.stringify(body),
  });
}
