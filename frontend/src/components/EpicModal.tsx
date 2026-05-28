import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentEvent, Epic, EpicMergeStatus, Ticket } from "../types.ts";
import { headingSlug, nodeText } from "../utils.ts";

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
  onRedecode: () => void;
  onRetry: () => void;
  onReview: () => void;
  onPlayLoop: () => void;
  onMergeToMain: () => void;
  onMarkDone: () => void;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  actionBusy: boolean;
  mergeStatus: EpicMergeStatus | null;
  mergeStatusLoading: boolean;
  epicEvents: AgentEvent[];
  epicTickets: Ticket[];
}) {
  const headings = useMemo(() => {
    const result: Array<{ id: string; text: string; level: number }> = [];
    for (const event of props.epicEvents) {
      if (
        !event.payload ||
        (event.payload.streamKind !== "assistant" && event.payload.streamKind !== "thinking")
      ) continue;
      const clean = (event.payload.content || "").replace(/<FINAL_JSON>[\s\S]*?<\/FINAL_JSON>/g, "");
      for (const match of clean.matchAll(/^(#{1,3})\s+(.+)$/gm)) {
        const text = match[2].trim();
        result.push({ id: headingSlug(text), text, level: match[1].length });
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
        <div className="modal-header">
          <div className="modal-header-left">
            <span>[Epic]</span>
            <div className="modal-header-title-wrap">
              <h2>{props.epic.title}</h2>
              <span className={`pill pill-${props.epic.status}`}>{props.epic.status}</span>
            </div>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={props.onClose}>
              X
            </button>
          </div>
        </div>

        <div className="planning-modal-body">
          <div className="planning-modal-sidebar">
            {headings.length > 0 && (
              <div className="plan-nav-group">
                <div className="plan-nav-group-label">Contents</div>
                {headings.map((heading) => (
                  <button
                    key={heading.id + heading.text}
                    className={`plan-nav-item plan-nav-h${heading.level}`}
                    onClick={() => scrollToSection(heading.id)}
                    title={heading.text}
                  >
                    {heading.text}
                  </button>
                ))}
              </div>
            )}
            {props.epicTickets.length > 0 && (
              <div className="plan-nav-group">
                <div className="plan-nav-group-label">Tickets · {props.epicTickets.length}</div>
                {props.epicTickets.map((ticket, index) => (
                  <div className="plan-nav-ticket" key={ticket.id}>
                    <span className="plan-nav-ticket-num">{index + 1}</span>
                    <div className="plan-nav-ticket-body">
                      <div className="plan-nav-ticket-title">{ticket.title}</div>
                      <span
                        className={`pill pill-${ticket.status} plan-nav-ticket-priority`}
                        style={{ fontSize: "0.65rem" }}
                      >
                        {ticket.status}
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
                  ["Branch", props.epic.targetBranch || "-"],
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
            {props.epic.status === "done" && (
              <div className="plan-nav-group">
                <div className="plan-nav-group-label">Merge to Main</div>
                <div className="epic-sidebar-meta">
                  <div className="epic-meta-row">
                    <span className="epic-meta-label">Status</span>
                    <span className="epic-meta-value">
                      {props.mergeStatusLoading
                        ? "Checking..."
                        : props.mergeStatus?.canMerge
                        ? "Ready"
                        : props.mergeStatus?.message || "Unavailable"}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="planning-modal-main">
            <div className="modal-stream-list">
              <div className="epic-main-section">
                <div className="epic-main-section-label">Description</div>
                <div className="plan-md-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.epic.goalText}</ReactMarkdown>
                </div>
              </div>

              {planEvents.length > 0 && (
                <div className="epic-main-section">
                  <div className="epic-main-section-label">Plan Analysis</div>
                  {planEvents.map((event) => (
                    <div
                      className={`modal-stream-item plan-stream-item plan-stream-${event.payload?.streamKind || "raw"}`}
                      key={event.id}
                    >
                      <div className="modal-stream-meta">
                        <span className={`pill pill-${event.payload?.streamKind || "raw"}`}>
                          {event.payload?.streamKind || "raw"}
                        </span>
                        <span className="modal-stream-time">{event.payload?.source || "planner"}</span>
                      </div>
                      {event.payload?.streamKind === "assistant" || event.payload?.streamKind === "thinking" ? (
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

              {activityEvents.length > 0 && (
                <div className="epic-main-section">
                  <div className="epic-main-section-label">Epic Activity</div>
                  {activityEvents.map((event) => (
                    <div
                      className={`modal-stream-item plan-stream-item plan-stream-${event.payload?.streamKind || "raw"}`}
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
                      {event.payload?.streamKind === "assistant" || event.payload?.streamKind === "thinking" ? (
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

        <div className="modal-footer">
          <button className="btn btn-modal-retry" onClick={props.onRedecode} disabled={props.actionBusy}>
            Re-decode Epic
          </button>
          {["failed", "escalated", "executing"].includes(props.epic.status) && (
            <button className="btn btn-modal-retry" onClick={props.onRetry} disabled={props.actionBusy}>
              Retry Epic
            </button>
          )}
          <button className="btn btn-modal-review" onClick={props.onReview} disabled={props.actionBusy}>
            Review
          </button>
          {props.epic.status === "done" && props.mergeStatus?.canMerge && (
            <button className="btn btn-modal-review" onClick={props.onMergeToMain} disabled={props.actionBusy || props.mergeStatusLoading}>
              Merge to main
            </button>
          )}
          {props.epic.status !== "done" && (
            <button className="btn btn-modal-rescue" onClick={props.onMarkDone} disabled={props.actionBusy}>
              Force Done
            </button>
          )}
          <button className="btn" onClick={props.onPlayLoop} disabled={props.actionBusy}>
            Play Loop
          </button>
          {props.epic.status === "paused" ? (
            <button className="btn" onClick={props.onResume} disabled={props.actionBusy}>
              Resume
            </button>
          ) : ["executing", "planning", "reviewing"].includes(props.epic.status) ? (
            <button className="btn" onClick={props.onPause} disabled={props.actionBusy}>
              Pause
            </button>
          ) : null}
          <button className="btn btn-modal-cancel" onClick={props.onCancel} disabled={props.actionBusy}>
            Cancel
          </button>
          <button className="btn btn-modal-delete" onClick={props.onDelete} disabled={props.actionBusy}>
            Delete
          </button>
          <button className="btn btn-modal-ok" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
