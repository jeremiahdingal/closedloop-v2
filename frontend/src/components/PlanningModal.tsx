import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GoalDecomposition } from "../types";
import { fetchJson, headingSlug, nodeText } from "../utils";

const mdComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => <h1 id={headingSlug(nodeText(children))}>{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 id={headingSlug(nodeText(children))}>{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 id={headingSlug(nodeText(children))}>{children}</h3>,
};

export function PlanningModal(props: {
  sessionId: string;
  epicTitle: string;
  initialBranch?: string;
  open: boolean;
  onClose: () => void;
  onApproved: (epicId: string) => void;
}) {
  const [streamItems, setStreamItems] = useState<
    Array<{ id: number; agentRole: string; streamKind: string; content: string; source: string }>
  >([]);
  const [sessionStatus, setSessionStatus] = useState<"running" | "idle" | "error">("running");
  const [latestPlan, setLatestPlan] = useState<GoalDecomposition | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [planBranch, setPlanBranch] = useState(props.initialBranch ?? "");
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);
  const [showRawOutput, setShowRawOutput] = useState(false);
  const terminalRef = useRef<HTMLPreElement>(null);
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);
  const afterIndexRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  const reasoningText = useMemo(() => {
    return streamItems
      .map((item) => {
        const clean = item.content.replace(/<FINAL_JSON>[\s\S]*?<\/FINAL_JSON>/g, "");
        if (!clean.trim()) return "";
        if (item.streamKind === "thinking") return `[thinking]\n${clean}`;
        if (item.streamKind === "stderr") return `[stderr] ${clean}`;
        if (item.streamKind === "status") return `[•] ${clean}`;
        return clean;
      })
      .filter(Boolean)
      .join("");
  }, [streamItems]);

  useEffect(() => {
    if (!latestPlan && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [reasoningText, latestPlan]);

  useEffect(() => {
    if (latestPlan && mainAreaRef.current) {
      mainAreaRef.current.scrollTop = 0;
    }
  }, [latestPlan]);

  const headings = useMemo(() => {
    const result: Array<{ id: string; text: string; level: number }> = [];
    for (const item of streamItems) {
      if (item.streamKind !== "assistant" && item.streamKind !== "thinking") continue;
      const clean = item.content.replace(/<FINAL_JSON>[\s\S]*?<\/FINAL_JSON>/g, "");
      for (const m of clean.matchAll(/^(#{1,3})\s+(.+)$/gm)) {
        const text = m[2].trim();
        result.push({ id: headingSlug(text), text, level: m[1].length });
      }
    }
    return result;
  }, [streamItems]);

  function scrollToSection(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  useEffect(() => {
    if (!props.open) return;
    const es = new EventSource(`/api/plan-session/${encodeURIComponent(props.sessionId)}/stream`);
    esRef.current = es;
    es.addEventListener("agent", (e) => {
      const data = JSON.parse(e.data);
      afterIndexRef.current = data.id + 1;
      if (data.streamKind === "plan_cleared") {
        setLatestPlan(null);
        setStreamItems([]);
        setShowRawOutput(false);
        return;
      }
      setStreamItems((prev) => [...prev, data]);
    });
    es.addEventListener("session_status", (e) => {
      const data = JSON.parse(e.data);
      setSessionStatus(data.status);
    });
    es.addEventListener("plan_ready", (e) => {
      setLatestPlan(JSON.parse(e.data));
    });
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [props.open, props.sessionId]);

  async function sendMessage() {
    if (!messageInput.trim()) return;
    setSending(true);
    try {
      await fetchJson(`/api/plan-session/${encodeURIComponent(props.sessionId)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: messageInput.trim() }),
      });
      setMessageInput("");
      setSessionStatus("running");
    } catch (err) {
      toast.error(`Failed to send: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  async function approvePlan() {
    setApproving(true);
    try {
      const result = await fetchJson<{ epicId: string; runId: string }>(
        `/api/plan-session/${encodeURIComponent(props.sessionId)}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetBranch: planBranch.trim() || undefined }),
        }
      );
      toast.success(`Epic created and queued: ${result.epicId}`);
      props.onApproved(result.epicId);
    } catch (err) {
      toast.error(`Approval failed: ${(err as Error).message}`);
    } finally {
      setApproving(false);
    }
  }

  if (!props.open) return null;
  const canApprove = latestPlan !== null && sessionStatus !== "running";

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal planning-modal" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="modal-header">
          <div className="modal-header-left">
            <span>📐</span>
            <div className="modal-header-title-wrap">
              <h2>Plan Mode — {props.epicTitle}</h2>
              <span className={`plan-status-badge status-${sessionStatus}`}>
                {sessionStatus === "running"
                  ? "⏳ planning..."
                  : sessionStatus === "idle"
                  ? latestPlan
                    ? "✅ plan ready"
                    : "💬 awaiting input"
                  : "⚠️ error"}
              </span>
            </div>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={props.onClose}>
              ×
            </button>
          </div>
        </div>

        {/* ── Two-column body ── */}
        <div className="planning-modal-body">
          {/* Sidebar nav */}
          <div className="planning-modal-sidebar">
            {headings.length > 0 && (
              <div className="plan-nav-group">
                <div className="plan-nav-group-label">Contents</div>
                {headings.map((h) => (
                  <button
                    key={h.id + h.text}
                    className={`plan-nav-item plan-nav-h${h.level}`}
                    onClick={() => scrollToSection(h.id)}
                    title={h.text}
                  >
                    {h.text}
                  </button>
                ))}
              </div>
            )}
            {latestPlan && (
              <div className="plan-nav-group">
                <div className="plan-nav-group-label">Plan · {latestPlan.tickets.length} tickets</div>
                <div className="plan-nav-summary">{latestPlan.summary}</div>
                {latestPlan.tickets.map((t, i) => (
                  <div className="plan-nav-ticket" key={t.id}>
                    <span className="plan-nav-ticket-num">{i + 1}</span>
                    <div className="plan-nav-ticket-body">
                      <div className="plan-nav-ticket-title">{t.title}</div>
                      <span className={`priority-${t.priority} plan-nav-ticket-priority`}>
                        {t.priority}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {headings.length === 0 && !latestPlan && (
              <div className="plan-nav-empty">Waiting for analysis...</div>
            )}
          </div>

          {/* Main stream — Phase 1: terminal; Phase 2: structured plan */}
          <div className="planning-modal-main" ref={mainAreaRef}>
            {latestPlan === null ? (
              /* Phase 1: raw terminal output while planner is running */
              <div className="plan-terminal-wrap">
                <div className="plan-terminal-header">
                  <span className="plan-terminal-title">◉ Planner output</span>
                  <span className="plan-terminal-chars">{reasoningText.length} chars</span>
                </div>
                <pre className="plan-terminal-output" ref={terminalRef}>
                  {reasoningText || "Planner is exploring the repository…"}
                  {sessionStatus === "running" && <span className="plan-terminal-cursor"> ▌</span>}
                </pre>
              </div>
            ) : (
              /* Phase 2: structured plan + optional raw toggle */
              <>
                <div className="plan-phase2-toolbar">
                  <button className="btn plan-raw-toggle" onClick={() => setShowRawOutput((v) => !v)}>
                    {showRawOutput ? "📋 Show Analysis" : "📟 Show Raw Output"}
                  </button>
                </div>
                {showRawOutput ? (
                  <div className="plan-terminal-wrap plan-terminal-wrap--inline">
                    <pre className="plan-terminal-output plan-terminal-output--inline">
                      {reasoningText || "(no raw output captured)"}
                    </pre>
                  </div>
                ) : (
                  <div className="modal-stream-list">
                    {streamItems.length ? (
                      streamItems.map((item) => (
                        <div
                          className={`modal-stream-item plan-stream-item plan-stream-${
                            item.streamKind || "raw"
                          }`}
                          key={item.id}
                        >
                          <div className="modal-stream-meta">
                            <span className={`pill pill-${item.streamKind || "raw"}`}>
                              {item.streamKind || "raw"}
                            </span>
                            <span className="modal-stream-time">{item.source}</span>
                          </div>
                          {item.streamKind === "assistant" || item.streamKind === "thinking" ? (
                            <div className="plan-md-content">
                              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                                {item.content
                                  .replace(/<FINAL_JSON>[\s\S]*?<\/FINAL_JSON>/g, "")
                                  .trim()}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <pre className="plan-plain-text">{item.content}</pre>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="modal-empty">No analysis items.</p>
                    )}
                    <div ref={streamEndRef} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Input bar ── */}
        <div className="planning-modal-input-bar">
          <input
            className="planning-modal-input"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="Add context or answer questions from the planner..."
            disabled={sending}
          />
          <button
            className="btn"
            onClick={() => void sendMessage()}
            disabled={sending || !messageInput.trim()}
          >
            {sending ? "⏳" : "Send"}
          </button>
        </div>
        <div className="planning-modal-branch-bar">
          <label className="plan-branch-label">🌿 Target branch</label>
          <input
            className="plan-branch-input"
            value={planBranch}
            onChange={(e) => setPlanBranch(e.target.value)}
            placeholder="Optional: branch name to create/checkout (e.g. feature/my-epic)"
          />
        </div>
        <div className="modal-footer">
          <button
            className="btn plan-approve-btn"
            onClick={() => void approvePlan()}
            disabled={!canApprove || approving}
          >
            {approving ? "⏳ Creating epic..." : "✅ Approve Plan"}
          </button>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
