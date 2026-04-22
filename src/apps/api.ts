import { GoalRunner } from "../orchestration/goal-runner.ts";
import { createGateway } from "../orchestration/models.ts";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { bootstrap } from "./bootstrap.ts";
import { loadConfig, updateAgentModel } from "../config.ts";
import type { 
  AgentRole, 
  AgentStreamPayload, 
  GoalDecomposition, 
  DirectChatSessionRecord, 
  DirectChatMessageRecord 
} from "../types.ts";
import { runPlanDecoder, extractPlanFromStream, planNeedsClarification } from "../orchestration/plan-runner.ts";
import { randomId } from "../utils.ts";
import { git } from "../bridge/git.ts";
import { runMediatedLoop, resolveModelContextWindow } from "../mediated-agent-harness/loop.ts";
import { buildToolingContext } from "../rag/context-builder.ts";
import { getAvailableToolsList } from "../mediated-agent-harness/tools.ts";
import { EventEmitter } from "node:events";
import type { ChatMessage } from "../mediated-agent-harness/types.ts";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function summarizeConversation(model: string, messages: ChatMessage[]): Promise<string> {
  const { adapter, model: rawModel } = parseAdapter(model);
  const builderModel = rawModel || adapter;
  const actualModel = builderModel.startsWith("mediated:") ? builderModel.slice(9) : builderModel;
  
  const baseURL = "http://localhost:11434/v1"; 
  
  const prompt = `Please summarize the following conversation history between a User and a Local Builder. 
Focus on:
1. The main goal of the session.
2. Important facts discovered about the repository.
3. Actions already taken (files read, edited, commands run).
4. Decisions made and constraints identified.
5. Current expected next steps.

Format as a concise structured memory block.

CONVERSATION TO SUMMARIZE:
${messages.map(m => `[${m.role.toUpperCase()}] ${m.content || (m.tool_calls ? "Called tools: " + m.tool_calls.map(tc => tc.function.name).join(", ") : "")}`).join("\n\n")}
`;

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: actualModel,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        temperature: 0.3,
      })
    });
    if (!response.ok) throw new Error(`Summary failed: ${response.status}`);
    const data: any = await response.json();
    return data.choices[0].message.content;
  } catch (err) {
    console.error("Auto-compression summary failed:", err);
    return "Summarization failed. Previous history omitted due to context limits.";
  }
}

function findLastIndex<T>(array: T[], predicate: (value: T) => boolean): number {
  for (let i = array.length - 1; i >= 0; i--) {
    if (predicate(array[i])) return i;
  }
  return -1;
}

async function buildDirectChatContext(
  model: string,
  dbMessages: DirectChatMessageRecord[],
  options: { maxTurnsVerbatim?: number; compressionThreshold?: number } = {}
): Promise<{
  messages: ChatMessage[];
  didCompress: boolean;
  usedSummary: boolean;
  truncatedEntries: number;
  estimatedTokens: number;
}> {
  const { adapter, model: rawModel } = parseAdapter(model);
  const builderModel = rawModel || adapter;
  const actualModel = builderModel.startsWith("mediated:") ? builderModel.slice(9) : builderModel;
  const windowSize = resolveModelContextWindow(actualModel);
  const threshold = options.compressionThreshold ?? 0.75;
  const budget = Math.floor(windowSize * threshold);
  
  const systemIdentity: ChatMessage = {
    role: "system",
    content: "You are the Local Builder. Help the user with their coding task in the current repository. Use the tools available to inspect and modify code."
  };

  // 1. Initial Mapping
  let messages: ChatMessage[] = dbMessages.map(m => {
    if (m.role === "assistant" && m.toolCallsJson) {
      const calls = JSON.parse(m.toolCallsJson) as any[];
      return {
        role: "assistant" as const,
        content: m.content || null,
        tool_calls: calls.map(tc => {
          let argsStr = "";
          if (tc.function?.arguments) {
            argsStr = typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          } else if (tc.arguments) {
            argsStr = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments);
          } else if (tc.args) {
            argsStr = JSON.stringify(tc.args);
          }

          return {
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function?.name || tc.name || "unknown",
              arguments: argsStr
            }
          };
        })
      };
    }
    if (m.role === "tool") {
      let callId = "";
      if (m.toolResultsJson) {
        const res = JSON.parse(m.toolResultsJson);
        callId = res.callId || res.tool_call_id || "";
      }
      return {
        role: "tool" as const,
        content: m.content,
        tool_call_id: callId
      };
    }
    return {
      role: m.role as any,
      content: m.content,
    };
  });

  // Ensure system identity is at the start if not already there (manual compression might have saved it)
  if (messages.length === 0 || messages[0].content !== systemIdentity.content) {
    messages.unshift(systemIdentity);
  }

  let currentTokens = estimateTokens(JSON.stringify(messages));
  
  if (currentTokens <= budget) {
    return { messages, didCompress: false, usedSummary: false, truncatedEntries: 0, estimatedTokens: currentTokens };
  }

  // 2. Hybrid Compression Step 1: Truncate large payloads
  let truncatedEntries = 0;
  for (const m of messages) {
    if (m.role === "tool" && m.content && m.content.length > 2000) {
      const originalLen = m.content.length;
      m.content = m.content.substring(0, 1000) + `\n\n... [TRUNCATED from ${originalLen} chars] ...\n\n` + m.content.substring(originalLen - 500);
      truncatedEntries++;
    }
    if (m.role === "assistant" && m.content && m.content.length > 4000) {
       const originalLen = m.content.length;
       m.content = m.content.substring(0, 2000) + `\n\n... [TRUNCATED from ${originalLen} chars] ...\n\n` + m.content.substring(originalLen - 1000);
       truncatedEntries++;
    }
  }

  currentTokens = estimateTokens(JSON.stringify(messages));
  if (currentTokens <= budget) {
    return { messages, didCompress: true, usedSummary: false, truncatedEntries, estimatedTokens: currentTokens };
  }

  // 3. Hybrid Compression Step 2: Summarization
  // We keep the system identity and the last N messages.
  // We MUST NOT break a tool call/result pair.
  const keepRawCount = 8; 
  let splitIdx = Math.max(1, messages.length - keepRawCount);
  
  // If we split at a tool message, we must include its preceding assistant message.
  // Better: find the first non-tool message at or before splitIdx.
  while (splitIdx > 1 && messages[splitIdx].role === "tool") {
    splitIdx--;
  }
  // Now if messages[splitIdx] is an assistant message with tool calls, 
  // we should probably keep it raw too if we are keeping its tools.
  // Actually, the above loop ensures we don't START the raw section with a tool message.
  
  const toSummarize = messages.slice(1, splitIdx);
  const toKeepRaw = messages.slice(splitIdx);
  
  if (toSummarize.length === 0) {
     return { messages, didCompress: true, usedSummary: false, truncatedEntries, estimatedTokens: currentTokens };
  }

  const summary = await summarizeConversation(model, toSummarize);
  
  const finalMessages: ChatMessage[] = [systemIdentity];
  finalMessages.push({
    role: "system",
    content: `CONVERSATION SUMMARY & MEMORY:\n${summary}\n\nThe above is a summary of the earlier part of this session. Use it as context for the current state of the task.`
  });
  finalMessages.push(...toKeepRaw);

  return { 
    messages: finalMessages, 
    didCompress: true, 
    usedSummary: true, 
    truncatedEntries, 
    estimatedTokens: estimateTokens(JSON.stringify(finalMessages)) 
  };
}

// ---------------------------------------------------------------------------
// In-memory plan session store (ephemeral - lost on server restart, by design)
// ---------------------------------------------------------------------------
type PlanSession = {
  id: string;
  epicTitle: string;
  epicDescription: string;
  targetDir: string;
  targetBranch: string | null;
  userMessages: string[];
  latestPlan: GoalDecomposition | null;
  status: "running" | "idle" | "error";
  streamChunks: AgentStreamPayload[];
  textChunks: string[];       // raw assistant text for FINAL_JSON detection
  pendingMessages: string[];  // queued while decoder is running
};

const planSessions = new Map<string, PlanSession>();
const chatEmitters = new Map<string, EventEmitter>();

async function runDirectChat(sessionId: string, db: any) {
  const session = db.getDirectChatSession(sessionId);
  if (!session) return;

  let emitter = chatEmitters.get(sessionId);
  if (!emitter) {
    emitter = new EventEmitter();
    chatEmitters.set(sessionId, emitter);
  }

  try {
    const dbMessages = db.listDirectChatMessages(sessionId);
    const context = await buildDirectChatContext(session.model, dbMessages);
    
    if (context.didCompress) {
      emitter.emit("event", { 
        kind: "status", 
        message: context.usedSummary 
          ? "Context window reached. Summarized older history." 
          : `Oversized payloads truncated (${context.truncatedEntries} entries).` 
      });
    }

    const chatMessages = context.messages;

    const repoRoot = session.targetDir;
    if (session.branchName) {
      await git(repoRoot, ["checkout", "-b", session.branchName]).catch(() => git(repoRoot, ["checkout", session.branchName])).catch(() => {});
    }

    const { adapter, model } = parseAdapter(session.model);
    const builderModel = model || adapter;

    if (adapter === "gemini-cli" || adapter === "qwen-cli" || adapter === "codex-cli") {
      // Create a virtual model config for the gateway
      const virtualModels: any = {
        builder: session.model,
        epicDecoder: session.model,
        epicReviewer: session.model
      };
      const gateway = createGateway(virtualModels);
      // Concatenate all messages into a single prompt for the CLI
      const fullPrompt = chatMessages.map(m => `[${m.role.toUpperCase()}] ${m.content || (m.tool_calls ? "Called tools: " + m.tool_calls.map(tc => tc.function.name).join(", ") : "")}`).join("\n\n");
      
      const onStream = (event: AgentStreamPayload) => {
        emitter!.emit("event", {
          kind: event.streamKind === "thinking" ? "thinking" : "text",
          text: event.content,
          content: event.content, // Ensure both text and content are set for compatibility
          metadata: event.metadata
        });
      };

      const result = await gateway.runBuilderInWorkspace!({
        cwd: repoRoot,
        prompt: fullPrompt,
        runId: sessionId,
        onStream: (event) => {
          onStream(event);
        }
      });

      db.appendDirectChatMessage({
        sessionId,
        role: "assistant",
        content: result.rawOutput,
        toolCallsJson: null,
        toolResultsJson: null
      });

      emitter.emit("event", {
        kind: "complete",
        result: result.rawOutput
      });
      return;
    }

    const toolContext = {
      cwd: repoRoot,
      workspaceId: sessionId,
      allowedPaths: ["*"],
      db,
      readFiles: async (paths: string[]) => {
        const res: Record<string, string> = {};
        for (const p of paths) {
          const full = path.resolve(repoRoot, p);
          res[p] = await readFile(full, "utf8").catch(() => "");
        }
        return res;
      },
      writeFiles: async (files: { path: string; content: string }[]) => {
        for (const f of files) {
          const full = path.resolve(repoRoot, f.path);
          await writeFile(full, f.content);
        }
      },
      gitDiff: async () => {
        const r = await git(repoRoot, ["diff", "main"]);
        return r.stdout;
      },
      gitStatus: async () => {
        const r = await git(repoRoot, ["status"]);
        return r.stdout;
      },
      runNamedCommand: async (name: string) => {
        return { stdout: "Command execution not fully implemented in direct chat.", stderr: "", exitCode: 0 };
      },
      saveArtifact: async () => "not_supported"
    };

    await runMediatedLoop({
      systemPrompt: "You are the Local Builder. Help the user with their coding task in the current repository. Use the tools available to inspect and modify code.",
      userPrompt: "",
      messages: chatMessages,
      config: {
        model: builderModel.startsWith("mediated:") ? builderModel.slice(9) : builderModel,
        cwd: repoRoot,
        role: "builder",
        onEvent: (event) => {
          emitter!.emit("event", event);
          if (event.kind === "complete") {
            db.appendDirectChatMessage({
              sessionId,
              role: "assistant",
              content: event.result,
              toolCallsJson: null,
              toolResultsJson: null
            });
          } else if (event.kind === "tool_result") {
            db.appendDirectChatMessage({
              sessionId,
              role: "tool",
              content: event.result.output,
              toolCallsJson: null,
              toolResultsJson: JSON.stringify(event.result)
            });
          } else if (event.kind === "tool_call") {
            db.appendDirectChatMessage({
              sessionId,
              role: "assistant",
              content: "",
              toolCallsJson: JSON.stringify([event.call]),
              toolResultsJson: null
            });
          }
        }
      },
      toolContext: toolContext as any
    });
  } catch (err) {
    emitter.emit("event", { kind: "error", error: String(err) });
  } finally {
    emitter.emit("done");
  }
}

// Fire off plan decoder asynchronously
async function runSession(sess: PlanSession, db: any, goalRunner: any) {
  if (sess.status === "idle" && sess.pendingMessages.length === 0) {
    // Already finished and nothing new to do
    return;
  }

  try {
    const gateway = (goalRunner as any).gateway;
    const result = await runPlanDecoder({
      cwd: sess.targetDir,
      epicTitle: sess.epicTitle,
      epicDescription: sess.epicDescription,
      userMessages: sess.userMessages,
      sessionId: sess.id,
      db,
      gateway,
      onStream: (event: AgentStreamPayload) => {
        sess.streamChunks.push(event);
        if (event.streamKind === "assistant" && event.content) {
          sess.textChunks.push(event.content);
          const plan = extractPlanFromStream(sess.textChunks);
          if (plan) sess.latestPlan = plan;
        }
      },
    });
    // Ollama fallback: onStream was never called - push rawText as a stream chunk
    if (!sess.latestPlan) {
      sess.latestPlan = result.plan;
      if (result.rawText) {
        sess.streamChunks.push({
          agentRole: "epicDecoder",
          source: "orchestrator",
          streamKind: "assistant",
          content: result.rawText,
          sequence: sess.streamChunks.length,
        });
      }
    }
  } catch (err) {
    console.error(`[PlanSession] Session ${sess.id} failed:`, err);
    sess.streamChunks.push({
      agentRole: "epicDecoder",
      source: "orchestrator",
      streamKind: "stderr",
      content: `Plan decoder error: ${err instanceof Error ? err.message : String(err)}`,
      sequence: sess.streamChunks.length,
    });
    sess.status = "error";
    return;
  }
  
  sess.status = "idle";
  if (sess.pendingMessages.length > 0) {
    console.log(`[PlanSession] Session ${sess.id} has ${sess.pendingMessages.length} pending messages. Re-running...`);
    sess.userMessages.push(...sess.pendingMessages);
    sess.pendingMessages = [];
    sess.textChunks = [];
    sess.latestPlan = null;
    sess.streamChunks.push({ 
      agentRole: "epicDecoder", 
      source: "orchestrator", 
      streamKind: "plan_cleared", 
      content: "", 
      sequence: sess.streamChunks.length 
    });
    sess.status = "running";
    // Recurse to handle pending messages
    void runSession(sess, db, goalRunner);
  }
}

type ModelAdapterOption = {
  id: string;
  label: string;
  description: string;
};

type AgentModelInfo = {
  currentModel: string;
  adapters: ModelAdapterOption[];
  switchable: boolean;
};

const SWITCHABLE_ADAPTORS: Record<string, ModelAdapterOption[]> = {
  epicDecoder: [
    { id: "gemini-cli", label: "Gemini CLI", description: "Workspace-aware local Gemini CLI execution" },
    { id: "qwen-cli", label: "Qwen CLI", description: "Workspace-aware local Qwen CLI execution" },
    { id: "mediated:qwen3.5:27b", label: "Mediated (qwen3.5:27b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware, bash + file tools via ChatGPT subscription" },
    { id: "opencode:qwen3-coder:30b", label: "OpenCode (qwen3-coder:30b)", description: "Workspace-aware, bash + file tools via OpenCode CLI" },
    { id: "ollama", label: "Ollama (Fallback)", description: "Pure LLM via local Ollama, no workspace tools" },
    { id: "gemma4:26b", label: "Ollama (gemma4:26b)", description: "Pure LLM via local Ollama, no workspace tools" },
    { id: "zai:glm-5.1", label: "Z AI (glm-5.1)", description: "Cloud AI via Z.ai Anthropic-compatible API" },
  ],
  epicReviewer: [
    { id: "gemini-cli", label: "Gemini CLI", description: "Workspace-aware local Gemini CLI execution" },
    { id: "qwen-cli", label: "Qwen CLI", description: "Workspace-aware local Qwen CLI execution" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware local Codex CLI execution" },
    { id: "mediated:qwen3.5:27b", label: "Mediated (qwen3.5:27b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:gemma4:26b", label: "Mediated (gemma4:26b)", description: "Local tool execution via Ollama + harness" },
    { id: "opencode:qwen3-coder:30b", label: "OpenCode (qwen3-coder:30b)", description: "Workspace-aware, bash + file tools via OpenCode CLI" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware, bash + file tools via ChatGPT subscription" },
    { id: "zai:glm-5.1", label: "Z AI (glm-5.1)", description: "Cloud AI via Z.ai Anthropic-compatible API" },
  ],
  reviewer: [
    { id: "mediated:qwen3.5:27b", label: "Mediated (qwen3.5:27b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3.5:9b", label: "Mediated (qwen3.5:9b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:gemma4:e4b", label: "Mediated (gemma4:e4b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "qwen3:14b", label: "Ollama (qwen3:14b)", description: "Pure LLM via local Ollama, no workspace tools" },
    { id: "qwen3.5:9b", label: "Ollama (qwen3.5:9b)", description: "Pure LLM via local Ollama, no workspace tools" },
    { id: "glm-4.7-flash:q4_K_M", label: "Ollama (glm-4.7-flash)", description: "Pure LLM via local Ollama, no workspace tools" },
    { id: "gemma4:26b", label: "Ollama (gemma4:26b)", description: "Pure LLM via local Ollama, no workspace tools" },
    { id: "zai:glm-5.1", label: "Z AI (glm-5.1)", description: "Cloud AI via Z.ai Anthropic-compatible API" },
  ],
  tester: [
    { id: "skip", label: "Skip Tester", description: "Bypass tester step and mark tests as skipped" },
    { id: "mediated:gemma4:e4b", label: "Mediated (gemma4:e4b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:gemma4:26b", label: "Mediated (gemma4:26b)", description: "Local tool execution via Ollama + harness" }
  ],
  builder: [
    { id: "gemini-cli", label: "Gemini CLI", description: "Workspace-aware local Gemini CLI execution" },
    { id: "qwen-cli", label: "Qwen CLI", description: "Workspace-aware local Qwen CLI execution" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware local Codex CLI execution" },
    { id: "mediated:qwen3.5:9b", label: "Mediated (qwen3.5:9b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:gemma4:e4b", label: "Mediated (gemma4:e4b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3.5:27b", label: "Mediated (qwen3.5:27b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3:14b", label: "Mediated (qwen3:14b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen2.5-coder:14b", label: "Mediated (qwen2.5-coder:14b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen2.5-coder:7b", label: "Mediated (qwen2.5-coder:7b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:devstral-small-2:24b", label: "Mediated (devstral-small-2:24b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:gemma4:26b", label: "Mediated (gemma4:26b)", description: "Local tool execution via Ollama + harness" }
  ],
  coder: [
    { id: "gemini-cli", label: "Gemini CLI", description: "Workspace-aware local Gemini CLI execution" },
    { id: "qwen-cli", label: "Qwen CLI", description: "Workspace-aware local Qwen CLI execution" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware local Codex CLI execution" },
    { id: "zai:glm-5.1", label: "Z AI (glm-5.1)", description: "Cloud AI via Z.ai Anthropic-compatible API" },
    { id: "opencode:qwen3-coder:30b", label: "OpenCode (qwen3-coder:30b)", description: "Workspace-aware, bash + file tools via OpenCode CLI" },
    { id: "mediated:qwen3.5:27b", label: "Mediated (qwen3.5:27b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:gemma4:26b", label: "Mediated (gemma4:26b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:devstral-small-2:24b", label: "Mediated (devstral-small-2:24b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:gemma4:e4b", label: "Mediated (gemma4:e4b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3:14b", label: "Mediated (qwen3:14b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen2.5-coder:14b", label: "Mediated (qwen2.5-coder:14b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen2.5-coder:7b", label: "Mediated (qwen2.5-coder:7b)", description: "Local tool execution via Ollama + harness" },
    { id: "qwen3-coder:30b", label: "Ollama (qwen3-coder:30b)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen3-coder:30b-32k", label: "Ollama (qwen3-coder:30b-32k)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen3.5:27b", label: "Ollama (qwen3.5:27b)", description: "Direct Ollama call - no workspace tools" },
    { id: "gemma4:31b", label: "Ollama (gemma4:31b)", description: "Direct Ollama call - no workspace tools" },
    { id: "gemma4:26b", label: "Ollama (gemma4:26b)", description: "Direct Ollama call - no workspace tools" },
    { id: "gemma4:26b-a4b-it-q4_K_M", label: "Ollama (gemma4:26b-a4b-it-q4_K_M)", description: "Direct Ollama call - no workspace tools" },
    { id: "glm-4.7-flash-32k:latest", label: "Ollama (glm-4.7-flash-32k)", description: "Direct Ollama call - no workspace tools" },
    { id: "nemotron-3-nano:30b", label: "Ollama (nemotron-3-nano:30b)", description: "Direct Ollama call - no workspace tools" },
    { id: "gemopus-no-vision:latest", label: "Ollama (gemopus-no-vision)", description: "Direct Ollama call - no workspace tools" },
    { id: "gemopus-test:latest", label: "Ollama (gemopus-test)", description: "Direct Ollama call - no workspace tools" },
    { id: "hf.co/Jackrong/Gemopus-4-26B-A4B-it-GGUF:q4_K_M", label: "Ollama (Gemopus-4-26B-A4B-it (q4_K_M))", description: "Direct Ollama call - no workspace tools" },
    { id: "codestral:latest", label: "Ollama (codestral)", description: "Direct Ollama call - no workspace tools" },
    { id: "magistral:latest", label: "Ollama (magistral)", description: "Direct Ollama call - no workspace tools" },
    { id: "devstral-small-2:24b", label: "Ollama (devstral-small-2:24b)", description: "Direct Ollama call - no workspace tools" },
    { id: "deepcoder:14b", label: "Ollama (deepcoder:14b)", description: "Direct Ollama call - no workspace tools" },
    { id: "deepseek-r1:14b", label: "Ollama (deepseek-r1:14b)", description: "Direct Ollama call - no workspace tools" },
    { id: "phi4-reasoning:14b", label: "Ollama (phi4-reasoning:14b)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen3:14b", label: "Ollama (qwen3:14b)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen2.5-coder:14b", label: "Ollama (qwen2.5-coder:14b)", description: "Direct Ollama call - no workspace tools" },
    { id: "gemma4:e4b", label: "Ollama (gemma4:e4b)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen3.5:9b-32k", label: "Ollama (qwen3.5:9b-32k)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen3.5:9b", label: "Ollama (qwen3.5:9b)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen3.5:latest", label: "Ollama (qwen3.5:latest)", description: "Direct Ollama call - no workspace tools" },
    { id: "glm-4.7-flash:latest", label: "Ollama (glm-4.7-flash)", description: "Direct Ollama call - no workspace tools" },
    { id: "glm-4.7-flash:q4_K_M", label: "Ollama (glm-4.7-flash:q4_K_M)", description: "Direct Ollama call - no workspace tools" },
    { id: "llama3.2-vision:11b", label: "Ollama (llama3.2-vision:11b)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen3-vl:8b", label: "Ollama (qwen3-vl:8b)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen3:8b", label: "Ollama (qwen3:8b)", description: "Direct Ollama call - no workspace tools" },
    { id: "deepseek-r1:8b", label: "Ollama (deepseek-r1:8b)", description: "Direct Ollama call - no workspace tools" },
    { id: "gemma3:12b", label: "Ollama (gemma3:12b)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen2.5-coder:7b", label: "Ollama (qwen2.5-coder:7b)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen2.5:7b", label: "Ollama (qwen2.5:7b)", description: "Direct Ollama call - no workspace tools" },
    { id: "nemotron-mini:latest", label: "Ollama (nemotron-mini)", description: "Direct Ollama call - no workspace tools" },
    { id: "nemotron-3-nano:4b", label: "Ollama (nemotron-3-nano:4b)", description: "Direct Ollama call - no workspace tools" },
    { id: "qwen3:4b", label: "Ollama (qwen3:4b)", description: "Direct Ollama call - no workspace tools" }
  ],
  playWriter: [
    { id: "gemini-cli", label: "Gemini CLI", description: "Workspace-aware local Gemini CLI execution" },
    { id: "qwen-cli", label: "Qwen CLI", description: "Workspace-aware local Qwen CLI execution" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware, bash + file tools via ChatGPT subscription" }
  ],
  playTester: [
    { id: "mediated:qwen3:4b", label: "Mediated (qwen3:4b)", description: "Runs Playwright MCP tools via local Ollama" },
    { id: "mediated:qwen3.5:27b", label: "Mediated (qwen3.5:27b)", description: "Runs Playwright MCP tools via local Ollama" },
    { id: "mediated:qwen3.5:9b", label: "Mediated (qwen3.5:9b)", description: "Runs Playwright MCP tools via local Ollama" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Runs Playwright MCP tools via local Ollama" }
  ]
};

function parseAdapter(raw: string): { adapter: string; model: string } {
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) {
    return { adapter: raw.slice(0, colonIdx), model: raw.slice(colonIdx + 1) };
  }
  return { adapter: raw, model: "" };
}

function getAgentModelsConfig(): Record<string, AgentModelInfo> {
  const models = loadConfig().models;
  const result: Record<string, AgentModelInfo> = {};
  for (const [role, rawModel] of Object.entries(models)) {
    const { adapter, model } = parseAdapter(rawModel);
    const switchableOptions = SWITCHABLE_ADAPTORS[role];
    const adapters: ModelAdapterOption[] = switchableOptions
      ? switchableOptions.map((opt) => {
          if (opt.id === "opencode" && model) {
            return { id: `opencode:${model}`, label: `OpenCode (${model})`, description: opt.description };
          }
          return opt;
        })
      : [{ id: rawModel, label: rawModel, description: "Configured adapter" }];
    if (!adapters.some((opt) => opt.id === rawModel)) {
      adapters.unshift({
        id: rawModel,
        label: inferModelLabel(rawModel),
        description: "Configured model"
      });
    }
    result[role] = {
      currentModel: rawModel,
      adapters,
      switchable: Boolean(switchableOptions)
    };
  }
  return result;
}

function inferModelLabel(rawModel: string): string {
  if (rawModel.startsWith("mediated:")) return `Mediated (${rawModel.slice("mediated:".length)})`;
  if (rawModel.startsWith("opencode:")) return `OpenCode (${rawModel.slice("opencode:".length)})`;
  if (rawModel === "gemini-cli") return "Gemini CLI";
  if (rawModel === "qwen-cli") return "Qwen CLI";
  if (rawModel.startsWith("zai:")) return `Z AI (${rawModel.slice(4)})`;
  if (rawModel === "codex-cli") return "Codex CLI";
  if (rawModel === "skip") return "Skip Tester";
  return `Ollama (${rawModel})`;
}

function isAgentRole(value: string): value is AgentRole {
  return ["epicDecoder", "builder", "reviewer", "tester", "epicReviewer", "playWriter", "playTester", "doctor", "system", "coder"].includes(value);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function writeSseEvent(res: http.ServerResponse, event: string, data: unknown, id?: number | string) {
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function resolveSseCursor(input: {
  searchParam?: string | null;
  lastEventIdHeader?: string | string[] | undefined;
  defaultValue?: number;
}): number {
  const defaultValue = input.defaultValue ?? 0;
  const fromQuery = Number(input.searchParam ?? "");
  if (Number.isFinite(fromQuery) && fromQuery >= 0) return fromQuery;

  const headerValue = Array.isArray(input.lastEventIdHeader)
    ? input.lastEventIdHeader[0]
    : input.lastEventIdHeader;
  const fromHeader = Number(headerValue ?? "");
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader + 1;

  return defaultValue;
}

async function main() {
  const { config, db, goalRunner, lifecycle, ticketRunner } = await bootstrap();
  const server = http.createServer(async (req, res) => {
    try {
      setCors(res);
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (!req.url) return json(res, 400, { error: "missing_url" });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === "/health") return json(res, 200, { ok: true, dryRun: config.dryRun, useLangGraph: config.useLangGraph });
      if (url.pathname === "/api/epics" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const epics = db.listEpics({ limit, offset });
        const total = db.countEpics();
        return json(res, 200, { epics, total, limit, offset });
      }
      if (url.pathname === "/api/tickets" && req.method === "GET") return json(res, 200, db.listTickets(url.searchParams.get("epicId") || undefined));
      if (url.pathname === "/api/runs" && req.method === "GET") return json(res, 200, db.listRuns());
      if (url.pathname === "/api/jobs" && req.method === "GET") return json(res, 200, db.listJobs());
      if (url.pathname === "/api/events" && req.method === "GET") return json(res, 200, db.listEvents());
      if (url.pathname === "/api/artifacts" && req.method === "GET") {
        return json(res, 200, db.listArtifacts(url.searchParams.get("ticketId") || undefined));
      }
      if (url.pathname === "/api/agent-events" && req.method === "GET") {
        const afterId = Number(url.searchParams.get("afterId") || 0);
        return json(res, 200, db.listEventsAfterId(afterId, {
          kind: "agent_stream",
          runId: url.searchParams.get("runId") || undefined,
          ticketId: url.searchParams.get("ticketId") || undefined,
          limit: Number(url.searchParams.get("limit") || 500),
          newest: !url.searchParams.get("afterId")
        }));
      }
      if (url.pathname === "/api/agent-stream" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        let afterId = Number(url.searchParams.get("afterId") || 0);
        const runId = url.searchParams.get("runId") || undefined;
        const ticketId = url.searchParams.get("ticketId") || undefined;
        let closed = false;
        req.on("close", () => {
          closed = true;
        });
        writeSseEvent(res, "ready", { ok: true, afterId });
        const pump = () => {
          if (closed) return;
          const rows = db.listEventsAfterId(afterId, { kind: "agent_stream", runId, ticketId, limit: 200 });
          for (const row of rows as any[]) {
            afterId = Number(row.id);
            writeSseEvent(res, "agent", row, row.id as number);
          }
          res.write(`: heartbeat ${Date.now()}\n\n`);
          setTimeout(pump, 1000);
        };
        pump();
        return;
      }
      if (url.pathname === "/api/epics" && req.method === "POST") {
        const body = await readBody(req);
        const epic = GoalRunner.createEpic(db, {
          title: String(body.title || "Untitled epic"),
          goalText: String(body.goalText || ""),
          targetDir: String(body.targetDir || process.cwd()),
          targetBranch: body.targetBranch ? String(body.targetBranch) : undefined
        });
        const runId = await goalRunner.enqueueGoal(epic.id);
        return json(res, 201, { epic, runId });
      }
      const cancelEpicMatch = /^\/api\/epics\/([^/]+)\/cancel$/.exec(url.pathname);
      if (cancelEpicMatch && req.method === "POST") {
        const summary = await lifecycle.cancelEpic(decodeURIComponent(cancelEpicMatch[1]));
        return json(res, 200, { ok: true, ...summary });
      }
      const doneEpicMatch = /^\/api\/epics\/([^/]+)\/done$/.exec(url.pathname);
      if (doneEpicMatch && req.method === "POST") {
        const id = decodeURIComponent(doneEpicMatch[1]);
        db.updateEpicStatus(id, "done");
        return json(res, 200, { ok: true });
      }      const reviewEpicMatch = /^\/api\/epics\/([^/]+)\/review$/.exec(url.pathname);
      if (reviewEpicMatch && req.method === "POST") {
        const epicId = decodeURIComponent(reviewEpicMatch[1]);
        const epic = db.getEpic(epicId);
        if (!epic) return json(res, 404, { error: "epic_not_found" });

        // If epic is already approved/completed, do not queue another review run.
        if (epic.status === "done") {
          return json(res, 200, {
            ok: true,
            epicId,
            skipped: true,
            reason: "already_approved",
            message: "Epic is already approved (status=done)."
          });
        }

        // Dedupe manual/active review runs for the same epic.
        const activeReviewRun = db
          .listRunsForEpic(epicId)
          .find((run) => {
            if (run.status !== "queued" && run.status !== "running" && run.status !== "waiting") return false;
            const node = String(run.currentNode ?? "").toLowerCase();
            if (!node.includes("review")) return false;

            // If it's over 15 minutes old and stalled, allow a new one
            const heartbeatAtMs = run.heartbeatAt ? new Date(run.heartbeatAt).getTime() : 0;
            const stalledForMs = heartbeatAtMs > 0 ? Date.now() - heartbeatAtMs : Number.MAX_SAFE_INTEGER;
            if (stalledForMs > 15 * 60 * 1000) return false;

            return true;
          });
        if (activeReviewRun) {
          return json(res, 200, {
            ok: true,
            epicId,
            runId: activeReviewRun.id,
            deduped: true,
            message: "Review is already queued/running for this epic."
          });
        }

        const runId = await goalRunner.enqueueManualReview(epicId);
        return json(res, 200, { ok: true, epicId, runId });
      }
      const playLoopEpicMatch = /^\/api\/epics\/([^/]+)\/play-loop$/.exec(url.pathname);
      if (playLoopEpicMatch && req.method === "POST") {
        const epicId = decodeURIComponent(playLoopEpicMatch[1]);
        const epic = db.getEpic(epicId);
        if (!epic) return json(res, 404, { error: "epic_not_found" });
        const runId = await goalRunner.enqueueManualPlayLoop(epicId);
        return json(res, 200, { ok: true, epicId, runId });
      }
      const retryEpicMatch = /^\/api\/epics\/([^/]+)\/retry$/.exec(url.pathname);
      if (retryEpicMatch && req.method === "POST") {
        const epicId = decodeURIComponent(retryEpicMatch[1]);
        const epic = db.getEpic(epicId);
        if (!epic) return json(res, 404, { error: "epic_not_found" });
        db.updateEpicStatus(epicId, "executing");
        const runId = await goalRunner.enqueueGoal(epicId);
        return json(res, 200, { ok: true, epicId, runId });
      }
      const deleteEpicMatch = /^\/api\/epics\/([^/]+)$/.exec(url.pathname);
      if (deleteEpicMatch && req.method === "DELETE") {
        const summary = await lifecycle.deleteEpic(decodeURIComponent(deleteEpicMatch[1]));
        return json(res, 200, { ok: true, ...summary });
      }
      const cancelTicketMatch = /^\/api\/tickets\/([^/]+)\/cancel$/.exec(url.pathname);
      const ticketDiffMatch = /^\/api\/tickets\/([^/]+)\/diff$/.exec(url.pathname);
      if (ticketDiffMatch && req.method === "GET") {
        const ticketId = decodeURIComponent(ticketDiffMatch[1]);
        const artifacts = db.listArtifacts(ticketId);
        const diffArtifact = artifacts.find((artifact) => String(artifact.kind ?? "") === "diff");
        if (!diffArtifact) {
          return json(res, 200, { ticketId, diff: "", artifactName: null, createdAt: null });
        }
        const diffPath = String(diffArtifact.path ?? "");
        const diff = diffPath ? await readFile(diffPath, "utf8").catch(() => "") : "";
        return json(res, 200, {
          ticketId,
          diff,
          artifactName: String(diffArtifact.name ?? ""),
          createdAt: String(diffArtifact.created_at ?? "")
        });
      }
      if (cancelTicketMatch && req.method === "POST") {
        const summary = await lifecycle.cancelTicket(decodeURIComponent(cancelTicketMatch[1]));
        return json(res, 200, { ok: true, ...summary });
      }
      const rerunTicketMatch = /^\/api\/tickets\/([^/]+)\/rerun$/.exec(url.pathname);
      if (rerunTicketMatch && req.method === "POST") {
        const ticketId = decodeURIComponent(rerunTicketMatch[1]);
        const body = await readBody(req);
        const cancelActive = body?.cancelActive !== false;
        const ticket = db.getTicket(ticketId);
        if (!ticket) return json(res, 404, { error: "ticket_not_found" });
        const activeRuns = db
          .listRunsForTicket(ticket.id)
          .filter((run) => run.status === "queued" || run.status === "running" || run.status === "waiting");
        if (activeRuns.length && !cancelActive) {
          return json(res, 409, { error: "ticket_has_active_run", activeRunIds: activeRuns.map((run) => run.id) });
        }
        if (activeRuns.length) {
          await lifecycle.cancelTicket(ticket.id);
        }
        const runId = await ticketRunner.start(ticket.id, ticket.epicId);
        db.recordEvent({
          aggregateType: "ticket",
          aggregateId: ticket.id,
          runId,
          ticketId: ticket.id,
          kind: "ticket_rerun_queued",
          message: "Ticket rerun queued.",
          payload: { ticketId: ticket.id, runId, cancelledPreviousRuns: activeRuns.map((run) => run.id) }
        });
        return json(res, 200, { ok: true, runId, ticketId: ticket.id });
      }
      const forceRerunInPlaceMatch = /^\/api\/tickets\/([^/]+)\/force-rerun-in-place$/.exec(url.pathname);
      if (forceRerunInPlaceMatch && req.method === "POST") {
        const ticketId = decodeURIComponent(forceRerunInPlaceMatch[1]);
        const ticket = db.getTicket(ticketId);
        if (!ticket) return json(res, 404, { error: "ticket_not_found" });
        if (!ticket.currentRunId) {
          return json(res, 409, { error: "ticket_has_no_current_run", message: "Ticket has no current run to reuse." });
        }
        const run = db.getRun(ticket.currentRunId);
        if (!run) return json(res, 404, { error: "run_not_found", runId: ticket.currentRunId });
        if (run.kind !== "ticket") {
          return json(res, 409, { error: "invalid_run_kind", message: "Only ticket runs can be force-rerun in place." });
        }

        // Supersede stale/duplicate active jobs for this run before enqueuing a new one.
        const supersededJobIds: string[] = [];
        for (const job of db.listJobRecords()) {
          const payload = (job.payload ?? {}) as Record<string, unknown>;
          if (job.kind !== "run_ticket") continue;
          if (String(payload.runId ?? "") !== run.id) continue;
          if (job.status !== "queued" && job.status !== "running") continue;
          db.failJob(job.id, "Superseded by force rerun in place.", false);
          supersededJobIds.push(job.id);
        }

        const timestamp = new Date().toISOString();
        const reason = "Force rerun requested by user (in place).";
        db.updateRun({
          runId: run.id,
          status: "queued",
          currentNode: "recovery",
          heartbeatAt: timestamp,
          lastMessage: reason,
          errorText: null,
          attempt: run.attempt + 1
        });
        db.updateTicketRunState({
          ticketId: ticket.id,
          status: "queued",
          currentRunId: run.id,
          currentNode: "recovery",
          lastHeartbeatAt: timestamp,
          lastMessage: reason
        });
        db.enqueueJob("run_ticket", { ticketId: ticket.id, epicId: ticket.epicId, runId: run.id });
        db.recordEvent({
          aggregateType: "ticket",
          aggregateId: ticket.id,
          runId: run.id,
          ticketId: ticket.id,
          kind: "ticket_force_rerun_in_place",
          message: reason,
          payload: {
            ticketId: ticket.id,
            runId: run.id,
            priorStatus: run.status,
            priorNode: run.currentNode,
            supersededJobIds
          }
        });
        return json(res, 200, { ok: true, runId: run.id, ticketId: ticket.id, supersededJobIds });
      }
      const forceRescueMatch = /^\/api\/tickets\/([^/]+)\/force-rescue$/.exec(url.pathname);
      if (forceRescueMatch && req.method === "POST") {
        const ticketId = decodeURIComponent(forceRescueMatch[1]);
        const body = await readBody(req);
        const minStaleMsRaw = Number(body?.minStaleMs ?? 60_000);
        const minStaleMs = Number.isFinite(minStaleMsRaw) && minStaleMsRaw >= 0 ? minStaleMsRaw : 60_000;
        const requireReviewerNode = body?.requireReviewerNode !== false;

        const ticket = db.getTicket(ticketId);
        if (!ticket) return json(res, 404, { error: "ticket_not_found" });
        if (!ticket.currentRunId) {
          return json(res, 409, { error: "ticket_has_no_current_run", message: "Ticket has no current run to rescue." });
        }
        const run = db.getRun(ticket.currentRunId);
        if (!run) return json(res, 404, { error: "run_not_found", runId: ticket.currentRunId });
        if (run.kind !== "ticket") {
          return json(res, 409, { error: "invalid_run_kind", message: "Only ticket runs can be rescued." });
        }

        const node = String(run.currentNode ?? "").toLowerCase();
        if (requireReviewerNode && !node.includes("review")) {
          return json(res, 409, {
            error: "run_not_in_reviewer",
            message: "Force rescue is only allowed when current node is reviewer.",
            currentNode: run.currentNode
          });
        }

        const heartbeatAtMs = run.heartbeatAt ? new Date(run.heartbeatAt).getTime() : 0;
        const stalledForMs = heartbeatAtMs > 0 ? Math.max(0, Date.now() - heartbeatAtMs) : Number.MAX_SAFE_INTEGER;
        if (stalledForMs < minStaleMs) {
          return json(res, 409, {
            error: "run_not_stale_enough",
            message: `Run heartbeat is still fresh (${stalledForMs}ms < ${minStaleMs}ms).`,
            stalledForMs,
            minStaleMs
          });
        }

        const supersededJobIds: string[] = [];
        for (const job of db.listJobRecords()) {
          const payload = (job.payload ?? {}) as Record<string, unknown>;
          if (job.kind !== "run_ticket") continue;
          if (String(payload.runId ?? "") !== run.id) continue;
          if (job.status !== "queued" && job.status !== "running") continue;
          db.failJob(job.id, "Superseded by manual force rescue.", false);
          supersededJobIds.push(job.id);
        }

        const timestamp = new Date().toISOString();
        const reason = `Doctor forced rescue for ticket ${ticket.id} at ${run.currentNode ?? "unknown node"}.`;
        db.updateRun({
          runId: run.id,
          status: "queued",
          currentNode: "recovery",
          heartbeatAt: timestamp,
          lastMessage: reason,
          errorText: null,
          attempt: run.attempt + 1
        });
        db.updateTicketRunState({
          ticketId: ticket.id,
          status: "queued",
          currentRunId: run.id,
          currentNode: "recovery",
          lastHeartbeatAt: timestamp,
          lastMessage: reason
        });
        db.enqueueJob("run_ticket", { ticketId: ticket.id, epicId: ticket.epicId, runId: run.id });
        db.recordEvent({
          aggregateType: "ticket",
          aggregateId: ticket.id,
          runId: run.id,
          ticketId: ticket.id,
          kind: "agent_stream",
          message: "doctor:assistant",
          payload: {
            agentRole: "doctor",
            source: "orchestrator",
            streamKind: "assistant",
            content: reason,
            runId: run.id,
            ticketId: ticket.id,
            epicId: ticket.epicId,
            done: true
          }
        });
        db.recordEvent({
          aggregateType: "ticket",
          aggregateId: ticket.id,
          runId: run.id,
          ticketId: ticket.id,
          kind: "ticket_force_rescue",
          message: reason,
          payload: {
            ticketId: ticket.id,
            runId: run.id,
            priorStatus: run.status,
            priorNode: run.currentNode,
            stalledForMs,
            minStaleMs,
            supersededJobIds
          }
        });
        return json(res, 200, { ok: true, runId: run.id, ticketId: ticket.id, stalledForMs, supersededJobIds });
      }
      const deleteTicketMatch = /^\/api\/tickets\/([^/]+)$/.exec(url.pathname);
      if (deleteTicketMatch && req.method === "DELETE") {
        const summary = await lifecycle.deleteTicket(decodeURIComponent(deleteTicketMatch[1]));
        return json(res, 200, { ok: true, ...summary });
      }
      if (url.pathname === "/api/config" && req.method === "GET") {
        const configPath = path.join(process.cwd(), "config", "workspace.json");
        const wsConfig = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : {};
        const repoRoot = typeof wsConfig.targetDir === "string" ? wsConfig.targetDir : process.cwd();
        const currentBranch = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
          .then(r => r.stdout.trim())
          .catch(() => null);
        return json(res, 200, { 
          targetDir: repoRoot,
          ...wsConfig, 
          currentBranch, 
          models: getAgentModelsConfig() 
        });
      }
      if (url.pathname === "/api/models" && req.method === "GET") {
        return json(res, 200, getAgentModelsConfig());
      }
      if (url.pathname === "/api/models" && req.method === "PUT") {
        const body = await readBody(req);
        const role = String(body.role || "");
        const model = String(body.model || "").trim();
        if (!isAgentRole(role)) return json(res, 400, { error: "invalid_role" });
        if (!model) return json(res, 400, { error: "missing_model" });
        updateAgentModel(role, model);
        return json(res, 200, { ok: true, models: getAgentModelsConfig() });
      }
      if (url.pathname === "/api/config" && req.method === "PUT") {
        const body = await readBody(req);
        const configPath = path.join(process.cwd(), "config", "workspace.json");
        const content = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : {};
        Object.assign(content, body);
        await writeFile(configPath, JSON.stringify(content, null, 2));
        return json(res, 200, content);
      }

        // Fire off plan decoder asynchronously
        async function runSession(sess: PlanSession) {
          try {
            const gateway = (goalRunner as any).gateway;
            const result = await runPlanDecoder({
              cwd: sess.targetDir,
              epicTitle: sess.epicTitle,
              epicDescription: sess.epicDescription,
              userMessages: sess.userMessages,
              sessionId: sess.id,
              db,
              gateway,
              onStream: (event: AgentStreamPayload) => {
                sess.streamChunks.push(event);
                if (event.streamKind === "assistant" && event.content) {
                  sess.textChunks.push(event.content);
                  const plan = extractPlanFromStream(sess.textChunks);
                  if (plan) sess.latestPlan = plan;
                }
              },
            });
            // Ollama fallback: onStream was never called - push rawText as a stream chunk
            if (!sess.latestPlan) {
              sess.latestPlan = result.plan;
              if (result.rawText) {
                sess.streamChunks.push({
                  agentRole: "epicDecoder",
                  source: "orchestrator",
                  streamKind: "assistant",
                  content: result.rawText,
                  sequence: sess.streamChunks.length,
                });
              }
            }
          } catch (err) {
            console.error(`[PlanSession] Session ${sess.id} failed:`, err);
            sess.streamChunks.push({
              agentRole: "epicDecoder",
              source: "orchestrator",
              streamKind: "stderr",
              content: `Plan decoder error: ${err instanceof Error ? err.message : String(err)}`,
              sequence: sess.streamChunks.length,
            });
            sess.status = "error";
            return;
          }
          
          sess.status = "idle";
          if (sess.pendingMessages.length > 0) {
            console.log(`[PlanSession] Session ${sess.id} has ${sess.pendingMessages.length} pending messages. Re-running...`);
            sess.userMessages.push(...sess.pendingMessages);
            sess.pendingMessages = [];
            sess.textChunks = [];
            sess.latestPlan = null;
            sess.streamChunks.push({ 
              agentRole: "epicDecoder", 
              source: "orchestrator", 
              streamKind: "plan_cleared", 
              content: "", 
              sequence: sess.streamChunks.length 
            });
            sess.status = "running";
            void runSession(sess);
          }
        }

        if (url.pathname === "/api/plan-session" && req.method === "POST") {
          const body = await readBody(req);
          const epicTitle = String(body.epicTitle || "Untitled Plan");
          const epicDescription = String(body.epicDescription || "");
          const targetDir = String(body.targetDir || process.cwd());

          const targetBranch = body.targetBranch ? String(body.targetBranch) : null;
          const sessionId = randomId("plan");
          const session: PlanSession = {
            id: sessionId,
            epicTitle,
            epicDescription,
            targetDir,
            targetBranch,
            userMessages: [],
            latestPlan: null,
            status: "running",
            streamChunks: [],
            textChunks: [],
            pendingMessages: [],
          };
          planSessions.set(sessionId, session);
          void runSession(session);
          return json(res, 201, { sessionId });
        }

      const planStreamMatch = /^\/api\/plan-session\/([^/]+)\/stream$/.exec(url.pathname);
      if (planStreamMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(planStreamMatch[1]);
        const session = planSessions.get(sessionId);
        if (!session) return json(res, 404, { error: "plan_session_not_found" });

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        let afterIndex = resolveSseCursor({
          searchParam: url.searchParams.get("afterIndex"),
          lastEventIdHeader: req.headers["last-event-id"],
          defaultValue: 0
        });
        let closed = false;
        req.on("close", () => { closed = true; });
        writeSseEvent(res, "ready", { ok: true, afterIndex, status: session.status });
        const pump = () => {
          if (closed) return;
          const chunks = session.streamChunks;
          while (afterIndex < chunks.length) {
            const chunk = chunks[afterIndex];
            writeSseEvent(res, "agent", { ...chunk, id: afterIndex }, afterIndex);
            afterIndex++;
          }
          writeSseEvent(res, "session_status", {
            status: session.status,
            hasPlan: session.latestPlan !== null,
            awaitingClarification: planNeedsClarification(session.latestPlan)
          });
          if (session.latestPlan) {
            writeSseEvent(res, "plan_ready", session.latestPlan);
          }
          res.write(`: heartbeat ${Date.now()}\n\n`);
          setTimeout(pump, 800);
        };
        pump();
        return;
      }

      const planMessageMatch = /^\/api\/plan-session\/([^/]+)\/message$/.exec(url.pathname);
      if (planMessageMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(planMessageMatch[1]);
        const session = planSessions.get(sessionId);
        if (!session) return json(res, 404, { error: "plan_session_not_found" });
        const body = await readBody(req);
        const message = String(body.message || "").trim();
        if (!message) return json(res, 400, { error: "empty_message" });

        if (session.status === "running") {
          session.pendingMessages.push(message);
          return json(res, 200, { ok: true, queued: true });
        }
        // Re-run with new message
        session.userMessages.push(message);
        session.textChunks = [];
        session.streamChunks.push({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "plan_cleared", content: "", sequence: session.streamChunks.length });
        session.latestPlan = null;
        session.status = "running";
        void runSession(session);
        return json(res, 200, { ok: true, restarted: true });
      }

      const planApproveMatch = /^\/api\/plan-session\/([^/]+)\/approve$/.exec(url.pathname);
      if (planApproveMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(planApproveMatch[1]);
        const session = planSessions.get(sessionId);
        if (!session) return json(res, 404, { error: "plan_session_not_found" });
        if (!session.latestPlan) return json(res, 409, { error: "no_plan_ready", message: "The planner has not produced a plan yet." });
        if (planNeedsClarification(session.latestPlan)) {
          return json(res, 409, {
            error: "clarification_required",
            message: "The planner is waiting for clarification before the plan can be approved."
          });
        }
        if (session.latestPlan.tickets.length === 0) {
          return json(res, 409, {
            error: "empty_plan",
            message: "The planner has not produced any tickets yet."
          });
        }

        const approveBody = await readBody(req);
        // Allow approve-time override; fall back to branch set at session creation
        const resolvedBranch = (approveBody.targetBranch ? String(approveBody.targetBranch) : null) ?? session.targetBranch ?? undefined;

        const epic = GoalRunner.createEpic(db, {
          title: session.epicTitle,
          goalText: session.epicDescription,
          targetDir: session.targetDir,
          targetBranch: resolvedBranch || undefined,
        });
        const runId = await goalRunner.approveFromPlan(epic.id, session.latestPlan);
        // Persist plan analysis stream as agent_stream events so the epic modal can display them
        for (const chunk of session.streamChunks) {
          if (!chunk.content) continue;
          db.recordEvent({
            aggregateType: "epic",
            aggregateId: epic.id,
            runId: null,
            ticketId: null,
            kind: "agent_stream",
            message: `planAnalysis:${chunk.streamKind || "assistant"}`,
            payload: { ...chunk, agentRole: "planAnalysis", epicId: epic.id, runId: null, ticketId: null } as any,
          });
        }
        planSessions.delete(sessionId);
        return json(res, 201, { epicId: epic.id, runId });
      }

      // Direct Chat Routes
      if (url.pathname === "/api/direct-chats" && req.method === "GET") {
        return json(res, 200, db.listDirectChatSessions());
      }
      if (url.pathname === "/api/direct-chats" && req.method === "POST") {
        const body = await readBody(req);
        const session = db.createDirectChatSession({
          id: randomId("chat"),
          title: String(body.title || "New Chat"),
          targetDir: String(body.targetDir || process.cwd()),
          branchName: String(body.branchName || "main"),
          model: String(body.model || "")
        });
        return json(res, 201, session);
      }
      const chatMessagesMatch = /^\/api\/direct-chats\/([^/]+)\/messages$/.exec(url.pathname);
      if (chatMessagesMatch && req.method === "GET") {
        return json(res, 200, db.listDirectChatMessages(decodeURIComponent(chatMessagesMatch[1])));
      }
      if (chatMessagesMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(chatMessagesMatch[1]);
        const body = await readBody(req);
        const msg = db.appendDirectChatMessage({
          sessionId,
          role: "user",
          content: String(body.content || ""),
          toolCallsJson: null,
          toolResultsJson: null
        });
        void runDirectChat(sessionId, db);
        return json(res, 201, msg);
      }
      const chatStreamMatch = /^\/api\/direct-chats\/([^/]+)\/stream$/.exec(url.pathname);
      if (chatStreamMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(chatStreamMatch[1]);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        let emitter = chatEmitters.get(sessionId);
        if (!emitter) {
          emitter = new EventEmitter();
          chatEmitters.set(sessionId, emitter);
        }
        const onEvent = (event: any) => writeSseEvent(res, "agent", event);
        emitter.on("event", onEvent);
        req.on("close", () => {
          emitter.off("event", onEvent);
        });
        writeSseEvent(res, "ready", { ok: true });
        return;
      }
      const chatDiffMatch = /^\/api\/direct-chats\/([^/]+)\/diff$/.exec(url.pathname);
      if (chatDiffMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(chatDiffMatch[1]);
        const session = db.getDirectChatSession(sessionId);
        if (!session) return json(res, 404, { error: "chat_not_found" });
        const diff = await git(session.targetDir, ["diff", "main"]).then(r => r.stdout).catch(() => "");
        return json(res, 200, { diff });
      }
      const chatDeleteMatch = /^\/api\/direct-chats\/([^/]+)$/.exec(url.pathname);
      if (chatDeleteMatch && req.method === "DELETE") {
        const sessionId = decodeURIComponent(chatDeleteMatch[1]);
        db.deleteDirectChatSession(sessionId);
        return json(res, 200, { ok: true });
      }
      const chatCompressMatch = /^\/api\/direct-chats\/([^/]+)\/compress$/.exec(url.pathname);
      if (chatCompressMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(chatCompressMatch[1]);
        const session = db.getDirectChatSession(sessionId);
        if (!session) return json(res, 404, { error: "chat_not_found" });

        const messages = db.listDirectChatMessages(sessionId);
        const context = await buildDirectChatContext(session.model, messages, { compressionThreshold: 0.1 }); // Force compression
        
        if (context.didCompress) {
          db.clearDirectChatMessages(sessionId);
          for (const m of context.messages) {
            db.appendDirectChatMessage({
              sessionId,
              role: m.role,
              content: m.content || "",
              toolCallsJson: m.tool_calls ? JSON.stringify(m.tool_calls.map(tc => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments
              }))) : null,
              toolResultsJson: m.role === "tool" ? JSON.stringify({ callId: m.tool_call_id, output: m.content }) : null
            });
          }
        }
        return json(res, 200, { ok: true, didCompress: context.didCompress });
      }

      const builtIndex = path.join(config.uiDistDir, "index.html");
      if (req.method === "GET" && !url.pathname.startsWith("/api")) {
        const filePath = existsSync(builtIndex)
          ? path.join(config.uiDistDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1))
          : path.join(config.publicDir, "index.html");
        try {
          const html = await readFile(filePath, "utf8");
          res.setHeader("content-type", filePath.endsWith(".js") ? "application/javascript" : filePath.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
          res.end(html);
          return;
        } catch {
          if (existsSync(builtIndex)) {
            const html = await readFile(builtIndex, "utf8");
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(html);
            return;
          }
        }
      }
      // ─── Tetris Score API ───
      if (url.pathname === "/api/tetris/scores" && req.method === "GET") {
        return json(res, 200, db.getTetrisHighScores(10));
      }
      if (url.pathname === "/api/tetris/scores" && req.method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body.name !== "string" || typeof body.score !== "number") {
          return json(res, 400, { error: "name (string) and score (number) required" });
        }
        db.addTetrisScore(body.name.slice(0, 3).toUpperCase(), body.score, body.level || 0, body.lines || 0);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/tetris/scores" && req.method === "DELETE") {
        db.clearTetrisScores();
        return json(res, 200, { ok: true });
      }

      // ─── Pac-Man Score API ───
      if (url.pathname === "/api/pacman/scores" && req.method === "GET") {
        return json(res, 200, db.getPacmanHighScores(10));
      }
      if (url.pathname === "/api/pacman/scores" && req.method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body.name !== "string" || typeof body.score !== "number") {
          return json(res, 400, { error: "name (string) and score (number) required" });
        }
        db.addPacmanScore(body.name.slice(0, 3).toUpperCase(), body.score, body.level || 0);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/pacman/scores" && req.method === "DELETE") {
        db.clearPacmanScores();
        return json(res, 200, { ok: true });
      }

      json(res, 404, { error: "not_found" });
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
    }
  });

  server.listen(config.apiPort, () => {
    console.log(`API listening on http://127.0.0.1:${config.apiPort}`);
  });
}

void main();
