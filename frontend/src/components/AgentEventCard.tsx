import React from "react";
import { AgentEvent } from "../types.ts";
import { formatTime, normalizeAgentRole } from "../utils.ts";

const ROLE_ICONS: Record<string, string> = {
  builder: "🔨",
  reviewer: "🔍",
  tester: "🧪",
  epicDecoder: "🗺",
  epicReviewer: "📋",
  doctor: "🩺",
  system: "⚙️",
  playWriter: "✍️",
  playTester: "🎭",
};
const SOURCE_SHORT: Record<string, string> = {
  "mediated-harness": "harness",
  opencode: "oc",
  orchestrator: "orch",
};
const KIND_LABEL: Record<string, string> = {
  tool_call: "tool",
  assistant: "text",
  thinking: "think",
  status: "status",
  stderr: "err",
  stdout: "out",
  raw: "raw",
  system: "sys",
};

export function AgentEventCard({ event }: { event: AgentEvent }) {
  const p = event.payload;
  if (!p) return null;
  const role = normalizeAgentRole(p.agentRole);
  const icon = ROLE_ICONS[role] ?? "🤖";
  const source = SOURCE_SHORT[p.source] ?? p.source;
  const kind = p.streamKind || "raw";
  const kindLabel = KIND_LABEL[kind] ?? kind;
  const model = p.metadata?.model as string | undefined;
  const toolName = p.metadata?.toolName as string | undefined;
  const isToolCall = kind === "tool_call";
  const isError = kind === "stderr";
  const isThinking = kind === "thinking";

  // For tool calls: show name prominently + args below
  let mainContent: React.ReactNode;
  if (isToolCall && toolName) {
    const raw = p.content;
    const parenIdx = raw.indexOf("(");
    const argsStr = parenIdx >= 0 ? raw.slice(parenIdx + 1, -1) : "";
    mainContent = (
      <div className="tev-tool-body">
        <span className="tev-tool-name">🔧 {toolName}</span>
        {argsStr && <pre className="tev-tool-args">{argsStr}</pre>}
      </div>
    );
  } else {
    mainContent = <pre className="tev-text-content">{p.content || "..."}</pre>;
  }

  return (
    <div className={`ticket-event-item tev-kind-${kind}`}>
      <div className="tev-header">
        <span className="tev-time">{formatTime(event.created_at)}</span>
        <span className="tev-role">
          {icon} {role}
        </span>
        <span className="tev-source">{source}</span>
        <span className={`tev-kind tev-kind-pill-${kind}`}>{kindLabel}</span>
        {model && <span className="tev-model">{model}</span>}
        {isError && <span className="tev-err-flag">⚠</span>}
        {isThinking && <span className="tev-think-flag">💭</span>}
      </div>
      <div className="tev-body">{mainContent}</div>
    </div>
  );
}
