import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentEvent } from "../types.ts";
import { formatTime, normalizeAgentRole } from "../utils.ts";

const ROLE_ICONS: Record<string, string> = {
  builder: "🔨",
  explorer: "🧭",
  coder: "💻",
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
  tool_result: "result",
  assistant: "text",
  thinking: "think",
  status: "status",
  stderr: "err",
  stdout: "out",
  raw: "raw",
  system: "sys",
  error: "err",
};

/** Detect if content looks like it contains markdown with code blocks */
function hasCodeBlocks(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /^\s{2,}\S/m.test(text);
}

/** Render tool result content with markdown support */
function ToolResultContent({ content, isError }: { content: string; isError?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const isLong = content.length > 600;
  const displayContent = expanded ? content : content.slice(0, 600);
  const hasMd = hasCodeBlocks(content) || content.includes("**") || content.includes("##") || content.includes("- [");

  if (hasMd) {
    return (
      <div className={`tev-tool-result ${isError ? "tev-tool-result-error" : ""}`}>
        <div className="tev-tool-result-md markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {displayContent + (isLong && !expanded ? "\n\n..." : "")}
          </ReactMarkdown>
        </div>
        {isLong && (
          <button className="tev-tool-result-toggle" onClick={() => setExpanded(!expanded)}>
            {expanded ? "▲ Show less" : `▼ Show all (${content.length.toLocaleString()} chars)`}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`tev-tool-result ${isError ? "tev-tool-result-error" : ""}`}>
      <pre className="tev-tool-result-pre">{displayContent}{isLong && !expanded ? "\n..." : ""}</pre>
      {isLong && (
        <button className="tev-tool-result-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? "▲ Show less" : `▼ Show all (${content.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

/** Render a unified-diff-style view with red (removed) / green (added) lines */
function DiffBlock({ search, replace }: { search: string; replace: string }) {
  const searchLines = search.split("\n");
  const replaceLines = replace.split("\n");

  return (
    <div className="tev-diff-block">
      <div className="tev-diff-section tev-diff-removed">
        {searchLines.map((line, i) => (
          <div key={`s-${i}`} className="tev-diff-line">
            <span className="tev-diff-marker">-</span>
            <span className="tev-diff-text">{line}</span>
          </div>
        ))}
      </div>
      <div className="tev-diff-section tev-diff-added">
        {replaceLines.map((line, i) => (
          <div key={`r-${i}`} className="tev-diff-line">
            <span className="tev-diff-marker">+</span>
            <span className="tev-diff-text">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Expandable operation item with diff view */
function ExpandableOp({ op, index }: { op: any; index: number }) {
  const [expanded, setExpanded] = React.useState(false);

  const kindLabel: Record<string, string> = {
    search_replace: "search_replace",
    create_file: "create_file",
    append_file: "append_file",
    delete_file: "delete_file",
    rename_file: "rename_file",
  };

  const hasDiffContent =
    (op.kind === "search_replace" && op.search && op.replace) ||
    (op.kind === "create_file" && op.content) ||
    (op.kind === "append_file" && op.content);

  const acTag = op.ac ? (
    <span className="tev-op-ac" title={`Maps to: ${op.ac}`}>{op.ac}</span>
  ) : null;

  return (
    <div className={`tev-operation-item ${expanded ? "tev-op-expanded" : ""}`}>
      <div
        className="tev-op-header"
        onClick={() => hasDiffContent && setExpanded(!expanded)}
        style={{ cursor: hasDiffContent ? "pointer" : "default" }}
      >
        <span className="tev-op-kind">{kindLabel[op.kind] || op.kind}</span>
        <span className="tev-op-path">{op.path}</span>
        {acTag}
        {hasDiffContent && (
          <span className="tev-op-expand-icon">{expanded ? "▼" : "▶"}</span>
        )}
      </div>

      {expanded && (
        <div className="tev-op-detail">
          {op.kind === "search_replace" && (
            <DiffBlock search={op.search || ""} replace={op.replace || ""} />
          )}
          {op.kind === "create_file" && (
            <div className="tev-diff-block">
              <div className="tev-diff-section tev-diff-added">
                {(op.content || "").split("\n").map((line: string, i: number) => (
                  <div key={i} className="tev-diff-line">
                    <span className="tev-diff-marker">+</span>
                    <span className="tev-diff-text">{line}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {op.kind === "append_file" && (
            <div className="tev-diff-block">
              <div className="tev-diff-section tev-diff-added">
                {(op.content || "").split("\n").map((line: string, i: number) => (
                  <div key={i} className="tev-diff-line">
                    <span className="tev-diff-marker">+</span>
                    <span className="tev-diff-text">{line}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {op.kind === "delete_file" && (
            <div className="tev-op-reason">
              {op.reason || "File deleted"}
            </div>
          )}
          {op.kind === "rename_file" && (
            <div className="tev-op-reason">
              Rename to: {op.newPath || op.destination || "?"}
              {op.reason && <><br />Reason: {op.reason}</>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const isToolResult = kind === "tool_result";
  const isError = kind === "stderr" || (p.metadata?.isError as boolean);
  const isThinking = kind === "thinking";
  const isSystem = kind === "system";
  const isText = kind === "assistant" || kind === "raw" || kind === "system";

  const renderCoderPayload = (content: string) => {
    if (!content || !content.includes("{")) return null;
    
    try {
      let raw = content.trim();
      
      const startIdx = raw.indexOf("{");
      const endIdx = raw.lastIndexOf("}");
      
      if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
        raw = raw.slice(startIdx, endIdx + 1);
      }

      const data = JSON.parse(raw);
      
      if (!data || typeof data !== "object" || (!data.summary && !data.operations)) return null;

      const summary = (data.summary || "") as string;
      const files = (data.intendedFiles || []) as string[];
      const ops = (data.operations || []) as any[];
      const blockers = (data.unresolvedBlockers || []) as string[];

      return (
        <div className="tev-coder-payload">
          {summary && (
            <div className="tev-coder-summary markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {summary}
              </ReactMarkdown>
            </div>
          )}

          {blockers.length > 0 && (
            <div className="tev-coder-section">
              <span className="tev-coder-section-label" style={{ color: "#d73a49" }}>Blockers</span>
              <div className="tev-coder-files">
                {blockers.map((b, i) => (
                  <span key={i} className="tev-coder-file-pill" style={{ background: "#fff0f0", color: "#b00", borderColor: "#f99" }}>
                    {b}
                  </span>
                ))}
              </div>
            </div>
          )}

          {files.length > 0 && (
            <div className="tev-coder-section">
              <span className="tev-coder-section-label">Intended Files</span>
              <div className="tev-coder-files">
                {files.map((f, i) => (
                  <span key={i} className="tev-coder-file-pill">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {ops.length > 0 && (
            <div className="tev-coder-section">
              <span className="tev-coder-section-label">Operations</span>
              <div className="tev-coder-operations">
                {ops.map((op, i) => (
                  <ExpandableOp key={i} op={op} index={i} />
                ))}
              </div>
            </div>
          )}
        </div>
      );
    } catch (e) {
      return null;
    }
  };

  // Render tool result content
  let mainContent: React.ReactNode;
  if (isToolResult) {
    const resultContent = p.content || "";
    const resultIsError = (p.metadata?.isError as boolean) || false;
    mainContent = (
      <div className="tev-tool-result-body">
        <span className="tev-tool-result-name">📤 {toolName || "result"}</span>
        <ToolResultContent content={resultContent} isError={resultIsError} />
      </div>
    );
  } else if (isToolCall && toolName) {
    const raw = p.content;
    const parenIdx = raw.indexOf("(");
    let argsStr = parenIdx >= 0 ? raw.slice(parenIdx + 1, -1) : "";
    
    try {
      if (argsStr.trim().startsWith("{") || argsStr.trim().startsWith("[")) {
        const parsed = JSON.parse(argsStr);
        argsStr = JSON.stringify(parsed, null, 2);
      }
    } catch (e) {
      // Fallback to raw string
    }

    mainContent = (
      <div className="tev-tool-body">
        <span className="tev-tool-name">🔧 {toolName}</span>
        {argsStr && <pre className="tev-tool-args">{argsStr}</pre>}
      </div>
    );
  } else if (isText) {
    const coderView = role === "coder" ? renderCoderPayload(p.content) : null;
    mainContent = coderView ? (
      coderView
    ) : (
      <div className="tev-text-content markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {p.content || "..."}
        </ReactMarkdown>
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
