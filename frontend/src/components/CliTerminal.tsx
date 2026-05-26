import React from "react";
import { AgentEvent, AgentStreamStatus } from "../types.ts";

type CliTerminalProps = {
  events: AgentEvent[];
  status?: AgentStreamStatus;
};

function CliThinkingLine({ content }: { content: string }) {
  const [open, setOpen] = React.useState(false);
  const isLong = content.length > 300;
  return (
    <div className="cli-line cli-line-thinking">
      <button className="cli-thinking-toggle" onClick={() => setOpen(!open)}>
        <span>{open ? "▼" : "▶"}</span>
        <span>{open ? "hide thinking" : `thinking${isLong ? ` (${content.length.toLocaleString()} chars)` : ""}`}</span>
      </button>
      {open && (
        <div className="cli-thinking-content">{content}</div>
      )}
    </div>
  );
}

function CliToolCallLine({ content, metadata }: { content: string; metadata?: Record<string, unknown> }) {
  const toolName = typeof metadata?.toolName === "string" ? metadata.toolName : "";
  const parenIdx = content.indexOf("(");
  let args = parenIdx >= 0 ? content.slice(parenIdx + 1, -1) : content;
  try {
    if (args.trim().startsWith("{") || args.trim().startsWith("[")) {
      args = JSON.stringify(JSON.parse(args), null, 2);
    }
  } catch { /* raw */ }
  const name = toolName || (parenIdx >= 0 ? content.slice(0, parenIdx) : "tool");
  return (
    <div className="cli-line cli-line-prompt">
      <span className="cli-prompt-dollar">$</span>
      <span className="cli-tool-name">{name}</span>
      {args && <pre className="cli-tool-args">{args.slice(0, 500)}</pre>}
    </div>
  );
}

function CliToolResultLine({ content, metadata }: { content: string; metadata?: Record<string, unknown> }) {
  const isError = metadata?.isError as boolean;
  const toolName = typeof metadata?.toolName === "string" ? metadata.toolName : "";
  const [expanded, setExpanded] = React.useState(false);
  const isLong = content.length > 600;
  const display = expanded ? content : content.slice(0, 600);
  return (
    <div className={`cli-line cli-line-tool-result ${isError ? "cli-line-error" : ""}`}>
      {toolName && <span className="cli-result-name">{toolName}</span>}
      <pre className="cli-result-content">{display}{isLong && !expanded ? "\n..." : ""}</pre>
      {isLong && (
        <button className="cli-expand-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? "▲ less" : `▼ all (${content.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

function CliLine({ event }: { event: AgentEvent }) {
  const p = event.payload;
  if (!p) return null;
  const kind = p.streamKind || "raw";
  const content = p.content || "";
  const meta = p.metadata ?? {};
  const cliEvent = typeof meta.cliEvent === "string" ? meta.cliEvent : "";

  // CLI system events (init, task_*, api_retry, result)
  if (kind === "status" && cliEvent) {
    if (cliEvent === "result") {
      const success = meta.success !== false;
      return (
        <div className={`cli-line cli-line-result ${success ? "" : "cli-line-error"}`}>
          {content}
        </div>
      );
    }
    if (cliEvent === "api_retry") {
      return <div className="cli-line cli-line-api-retry">{content}</div>;
    }
    if (cliEvent === "task_started") {
      return <div className="cli-line cli-line-task">{content}</div>;
    }
    if (cliEvent === "task_notification") {
      const status = typeof meta.status === "string" ? meta.status : "";
      const isFail = status === "failed";
      return <div className={`cli-line cli-line-task ${isFail ? "cli-line-error" : ""}`}>{content}</div>;
    }
    if (cliEvent === "init") {
      return <div className="cli-line cli-line-system">{content}</div>;
    }
    return <div className="cli-line cli-line-system">{content}</div>;
  }

  if (kind === "tool_call") {
    return <CliToolCallLine content={content} metadata={meta} />;
  }
  if (kind === "tool_result" || kind === "tool_error") {
    return <CliToolResultLine content={content} metadata={meta} />;
  }
  if (kind === "thinking" || kind === "streaming_thinking") {
    return <CliThinkingLine content={content} />;
  }
  if (kind === "stderr") {
    return <div className="cli-line cli-line-error">{content}</div>;
  }
  if (kind === "system") {
    if (content.startsWith("--- PROMPT ---")) {
      return <div className="cli-line cli-line-system cli-line-prompt-block">{content.split("\n").slice(0, 3).join("\n")}</div>;
    }
    return <div className="cli-line cli-line-system">{content}</div>;
  }
  if (kind === "status" && !cliEvent) {
    // Skip raw JSON blobs that look like CLI events
    if (content.startsWith("{")) return null;
    return <div className="cli-line cli-line-system">{content}</div>;
  }

  // assistant / text
  return <div className="cli-line cli-line-text">{content}</div>;
}

export function CliTerminal({ events, status }: CliTerminalProps) {
  const feedEndRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [events.length]);

  return (
    <div className="cli-terminal">
      <div className="cli-terminal-header">
        <span className="cli-terminal-title">CLI Output</span>
        <span className={`cli-terminal-status cli-status-${status ?? "idle"}`}>
          {status ?? "idle"}
        </span>
      </div>
      <div className="cli-terminal-body">
        {events.length === 0 && (
          <div className="cli-line cli-line-empty">Waiting for CLI output...</div>
        )}
        {events.map((event) => (
          <CliLine key={event.id} event={event} />
        ))}
        <div ref={feedEndRef} />
      </div>
    </div>
  );
}
