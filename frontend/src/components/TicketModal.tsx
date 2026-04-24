import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentEvent, Run, Ticket, TicketDiffResponse } from "../types.ts";
import {
  diffLineClass,
  fetchJson,
  normalizeCompareUrl,
  normalizeDisplayedTicketId,
  parseUnifiedDiff,
  truncateId,
} from "../utils.ts";
import { AgentEventCard } from "./AgentEventCard.tsx";

export function TicketModal(props: {
  ticket: Ticket;
  events: AgentEvent[];
  runs: Run[];
  open: boolean;
  onClose: () => void;
  onCancel: () => void;
  onRerun: () => void;
  onForceRerunInPlace: () => void;
  onRerunDirect: () => void;
  onForceRescue: () => void;
  onDelete: () => void;
  actionBusy: boolean;
}) {
  if (!props.open) return null;
  const ticketRun =
    props.runs.find((run) => run.id === props.ticket.currentRunId) ?? null;
  const hasCurrentRunId = Boolean(props.ticket.currentRunId);
  const ticketEvents = props.events.filter(
    (e) =>
      e.ticket_id === props.ticket.id ||
      (hasCurrentRunId && e.run_id === props.ticket.currentRunId)
  );
  const feedEndRef = useRef<HTMLDivElement>(null);
  const [ticketDiff, setTicketDiff] = useState<TicketDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [expandedDiffFiles, setExpandedDiffFiles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [ticketEvents.length]);

  useEffect(() => {
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    setExpandedDiffFiles({});
    fetchJson<TicketDiffResponse>(`/api/tickets/${encodeURIComponent(props.ticket.id)}/diff`)
      .then((payload) => {
        if (!cancelled) setTicketDiff(payload);
      })
      .catch((error) => {
        if (!cancelled) {
          setTicketDiff(null);
          setDiffError((error as Error).message);
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.ticket.id]);

  const parsedDiffFiles = useMemo(
    () => parseUnifiedDiff(ticketDiff?.diff ?? ""),
    [ticketDiff?.diff]
  );
  const fileRows = parsedDiffFiles.length
    ? parsedDiffFiles.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
      }))
    : props.ticket.diffFiles ?? [];
  const totals = fileRows.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 }
  );

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal ticket-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-left">
            <span>🎫</span>
            <div className="modal-header-title-wrap">
              <h2>{props.ticket.title}</h2>
              <span className={`pill pill-${props.ticket.status}`}>{props.ticket.status}</span>
            </div>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={props.onClose}>
              ×
            </button>
          </div>
        </div>

        {/* ── Two-column body ── */}
        <div className="ticket-modal-body">
          {/* Left column — ticket details */}
          <div className="ticket-modal-left">
            <div className="ticket-detail-header">
              <span className="ticket-detail-id">{normalizeDisplayedTicketId(props.ticket.id)}</span>
              {props.ticket.priority && (
                <span className={`priority-${props.ticket.priority}`}>{props.ticket.priority}</span>
              )}
            </div>

            {props.ticket.description ? (
              <div className="ticket-detail-message">
                <span className="detail-label">Description</span>
                <div className="plan-md-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.ticket.description}</ReactMarkdown>
                </div>
              </div>
            ) : null}

            <div className="ticket-detail-grid">
              <div className="detail-section">
                <span className="detail-label">Status</span>
                <span className="detail-value">{props.ticket.status}</span>
              </div>
              <div className="detail-section">
                <span className="detail-label">Priority</span>
                <span className="detail-value">{props.ticket.priority || "—"}</span>
              </div>
              <div className="detail-section">
                <span className="detail-label">Current Node</span>
                <span className="detail-value">{props.ticket.currentNode || "queued"}</span>
              </div>
              <div className="detail-section">
                <span className="detail-label">Epic ID</span>
                <span className="detail-value">{truncateId(props.ticket.epicId)}</span>
              </div>
              <div className="detail-section">
                <span className="detail-label">Current Run</span>
                <span className="detail-value">
                  {ticketRun ? truncateId(ticketRun.id) : "none"}
                </span>
              </div>
              <div className="detail-section">
                <span className="detail-label">Run Status</span>
                <span className="detail-value">
                  {ticketRun
                    ? `${ticketRun.status} · ${ticketRun.currentNode ?? "queued"}`
                    : "no active run"}
                </span>
              </div>
              <div className="detail-section">
                <span className="detail-label">Dependencies</span>
                <span className="detail-value">
                  {props.ticket.dependencies.length > 0
                    ? props.ticket.dependencies.map((d) => d.split("__").pop()).join(", ")
                    : "none"}
                </span>
              </div>
            </div>

            {(fileRows.length > 0 || diffLoading || diffError) && (
              <div className="pr-changes-card">
                <div className="pr-changes-header">
                  <span className="pr-changes-icon">📄</span>
                  <span className="pr-changes-title">Changes</span>
                  {ticketDiff?.artifactName && (
                    <span className="pr-changes-source" title={ticketDiff.createdAt ?? undefined}>
                      {ticketDiff.artifactName}
                    </span>
                  )}
                </div>
                {diffLoading && <div className="pr-diff-loading">Loading diff snippet…</div>}
                {diffError && (
                  <div className="pr-diff-error">Unable to load diff snippet: {diffError}</div>
                )}
                {fileRows.length > 0 && (
                  <>
                    <div className="pr-files">
                      {fileRows.map((file, idx) => {
                        const parsedFile = parsedDiffFiles.find((entry) => entry.path === file.path);
                        const key = `${file.path}-${idx}`;
                        const expanded = Boolean(expandedDiffFiles[key]);
                        return (
                          <div key={key} className="pr-file-with-snippet">
                            <button
                              type="button"
                              className="pr-file-row pr-file-row-button"
                              onClick={() =>
                                setExpandedDiffFiles((prev) => ({ ...prev, [key]: !expanded }))
                              }
                            >
                              <span className="pr-file-name">{file.path}</span>
                              <span className="pr-file-stats">
                                <span className="pr-add">+{file.additions}</span>
                                <span className="pr-del">-{file.deletions}</span>
                              </span>
                            </button>
                            {expanded && parsedFile && parsedFile.hunks.length > 0 && (
                              <div className="pr-file-snippets">
                                {parsedFile.hunks.slice(0, 3).map((hunk, hunkIdx) => (
                                  <div className="pr-file-hunk" key={`${key}-hunk-${hunkIdx}`}>
                                    <div className="pr-file-hunk-header">{hunk.header}</div>
                                    <div className="pr-file-hunk-body">
                                      {hunk.lines.slice(0, 32).map((line, lineIdx) => (
                                        <div
                                          className={`pr-diff-line ${diffLineClass(line)}`}
                                          key={`${key}-hunk-${hunkIdx}-line-${lineIdx}`}
                                        >
                                          {line || " "}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="pr-changes-footer">
                      {totals.additions} additions, {totals.deletions} deletions
                    </div>
                  </>
                )}
              </div>
            )}

            {props.ticket.prUrl ? (
              <div className="pr-link-card">
                <div className="pr-link-header">
                  <span className="pr-link-icon">🔗</span>
                  <span className="pr-link-title">Pull Request</span>
                </div>
                <a
                  href={normalizeCompareUrl(props.ticket.prUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pr-url"
                >
                  {normalizeCompareUrl(props.ticket.prUrl)}
                </a>
              </div>
            ) : null}

            {props.ticket.lastMessage && (
              <div className="ticket-detail-message">
                <span className="detail-label">Last Message</span>
                <div className="plan-md-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.ticket.lastMessage}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>

          {/* Right column — agent events */}
          <div className="ticket-modal-right">
            <div className="ticket-events-header">
              <span className="detail-label">Agent Events</span>
              <span className="ticket-events-count">{ticketEvents.length}</span>
            </div>
            <div className="ticket-events-feed">
              {ticketEvents.length ? (
                ticketEvents.map((event) => <AgentEventCard key={event.id} event={event} />)
              ) : (
                <p className="no-events">No events yet.</p>
              )}
              <div ref={feedEndRef} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-modal-cancel" onClick={props.onCancel} disabled={props.actionBusy}>
            ⏹ Stop
          </button>
          <button className="btn btn-modal-rerun" onClick={props.onRerun} disabled={props.actionBusy}>
            ▶ Rerun
          </button>
          <button
            className="btn btn-modal-force"
            onClick={props.onForceRerunInPlace}
            disabled={props.actionBusy}
          >
            🔄 Force In-Place
          </button>
          <button
            className="btn btn-modal-direct"
            onClick={props.onRerunDirect}
            disabled={props.actionBusy}
          >
            Skip to Coder
          </button>
          <button
            className="btn btn-modal-rescue"
            onClick={props.onForceRescue}
            disabled={props.actionBusy}
          >
            🚑 Rescue Reviewer
          </button>
          <button className="btn btn-modal-delete" onClick={props.onDelete} disabled={props.actionBusy}>
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
