import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentEvent, Epic, Ticket } from "../types";
import { headingSlug, nodeText } from "../utils";

const mdComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 id={headingSlug(nodeText(children))}>{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 id={headingSlug(nodeText(children))}>{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 id={headingSlug(nodeText(children))}>{children}</h3>
  ),
};

export function EpicModal(props: {
  epic: Epic;
  open: boolean;
  onClose: () => void;
  onRetry: () => void;
  onReview: () => void;
  onPlayLoop: () => void;
  onCancel: () => void;
  onDelete: () => void;
  actionBusy: boolean;
  epicEvents: AgentEvent[];
  epicTickets: Ticket[];
}) {
  const headings = useMemo(() => {
    const result: Array<{ id: string; text: string; level: number }> = [];
    for (const event of props.epicEvents) {
      if (
        !event.payload ||
        (event.payload.streamKind !== "assistant" && event.payload.streamKind !== "thinking")
      )
        continue;
      const clean = (event.payload.content || "").replace(/<FINAL_JSON>[\s\S]*?<\/FINAL_JSON>/g, "");
      for (const m of clean.matchAll(/^(#{1,3})\s+(.+)$/gm)) {
        const text = m[2].trim();
        result.push({ id: headingSlug(text), text, level: m[1].length });
      }
    }
    return result;
  }, [props.epicEvents]);

  function scrollToSection(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (!props.open) return null;

  const planEvents = props.epicEvents.filter((e) => e.payload?.agentRole === "planAnalysis");
  const activityEvents = props.epicEvents.filter(
    (e) => e.payload?.agentRole !== "planAnalysis" && e.ticket_id === null
  );

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal epic-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div className="modal-header-left">
            <span>📂</span>
            <div className="modal-header-title-wrap">
              <h2>{props.epic.title}</h2>
              <span className={`pill pill-${props.epic.status}`}>{props.epic.status}</span>
            </div>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={props.onClose}>
              ×
            </button>
          </div>
        </div>

        {/* Two-column body — reuses planning-modal layout classes */}
        <div className="planning-modal-body">
          {/* Sidebar */}
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
            {props.epicTickets.length > 0 && (
              <div className="plan-nav-group">
                <div className="plan-nav-group-label">Tickets · {props.epicTickets.length}</div>
                {props.epicTickets.map((t, i) => (
                  <div className="plan-nav-ticket" key={t.id}>
                    <span className="plan-nav-ticket-num">{i + 1}</span>
                    <div className="plan-nav-ticket-body">
                      <div className="plan-nav-ticket-title">{t.title}</div>
                      <span
                        className={`pill pill-${t.status} plan-nav-ticket-priority`}
                        style={{ fontSize: "0.65rem" }}
                      >
                        {t.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="plan-nav-group">
              <div className="plan-nav-group-label">Details</div>
              <div className="epic-sidebar-meta">
                {[
                  ["ID", props.epic.id],
                  ["Dir", props.epic.targetDir],
                  ["Branch", props.epic.targetBranch || "—"],
                  ["Created", new Date(props.epic.createdAt).toLocaleString()],
                  ["Updated", new Date(props.epic.updatedAt).toLocaleString()],
                ].map(([label, value]) => (
                  <div className="epic-meta-row" key={label}>
                    <span className="epic-meta-label">{label}</span>
                    <span className="epic-meta-value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Main content */}
          <div className="planning-modal-main">
            <div className="modal-stream-list">
              {/* Description */}
              <div className="epic-main-section">
                <div className="epic-main-section-label">Description</div>
                <div className="plan-md-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.epic.goalText}</ReactMarkdown>
                </div>
              </div>

              {/* Plan Analysis (from Plan Mode) */}
              {planEvents.length > 0 && (
                <div className="epic-main-section">
                  <div className="epic-main-section-label">Plan Analysis</div>
                  {planEvents.map((event) => (
                    <div
                      className={`modal-stream-item plan-stream-item plan-stream-${
                        event.payload?.streamKind || "raw"
                      }`}
                      key={event.id}
                    >
                      <div className="modal-stream-meta">
                        <span className={`pill pill-${event.payload?.streamKind || "raw"}`}>
                          {event.payload?.streamKind || "raw"}
                        </span>
                        <span className="modal-stream-time">
                          {event.payload?.source || "planner"}
                        </span>
                      </div>
                      {event.payload?.streamKind === "assistant" ||
                      event.payload?.streamKind === "thinking" ? (
                        <div className="plan-md-content">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                            {(event.payload.content || "")
                              .replace(/<FINAL_JSON>[\s\S]*?<\/FINAL_JSON>/g, "")
                              .trim()}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <pre className="plan-plain-text">{event.payload?.content}</pre>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Epic-level Activity */}
              {activityEvents.length > 0 && (
                <div className="epic-main-section">
                  <div className="epic-main-section-label">Epic Activity</div>
                  {activityEvents.map((event) => (
                    <div
                      className={`modal-stream-item plan-stream-item plan-stream-${
                        event.payload?.streamKind || "raw"
                      }`}
                      key={event.id}
                    >
                      <div className="modal-stream-meta">
                        <span className={`pill pill-${event.payload?.agentRole || "system"}`}>
                          {event.payload?.agentRole || "system"}
                        </span>
                        <span className={`pill pill-${event.payload?.streamKind || "raw"}`}>
                          {event.payload?.streamKind || "raw"}
                        </span>
                        <span className="modal-stream-time">
                          {new Date(event.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                      {event.payload?.streamKind === "assistant" ||
                      event.payload?.streamKind === "thinking" ? (
                        <div className="plan-md-content">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                            {(event.payload.content || "")
                              .replace(/<FINAL_JSON>[\s\S]*?<\/FINAL_JSON>/g, "")
                              .trim()}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <pre className="plan-plain-text">{event.payload?.content}</pre>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {planEvents.length === 0 && activityEvents.length === 0 && (
                <p className="modal-empty" style={{ marginTop: "1rem" }}>
                  No epic activity yet.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          {props.epic.status === "failed" && (
            <button className="btn btn-modal-retry" onClick={props.onRetry} disabled={props.actionBusy}>
              ▶ Retry Epic
            </button>
          )}
          <button className="btn btn-modal-review" onClick={props.onReview} disabled={props.actionBusy}>
            🔍 Review
          </button>
          <button className="btn" onClick={props.onPlayLoop} disabled={props.actionBusy}>
            🧪 Play Loop
          </button>
          <button
            className="btn btn-modal-cancel"
            onClick={props.onCancel}
            disabled={props.actionBusy}
          >
            ⏹ Cancel
          </button>
          <button
            className="btn btn-modal-delete"
            onClick={props.onDelete}
            disabled={props.actionBusy}
          >
            🗑 Delete
          </button>
          <button className="btn btn-modal-ok" onClick={props.onClose}>
            ✓ Close
          </button>
        </div>
      </div>
    </div>
  );
}
