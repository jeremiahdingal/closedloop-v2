import React from "react";
import { AgentEvent, AgentModelInfo, AgentStreamStatus } from "../types.ts";
import { formatTime } from "../utils.ts";

export function AgentModal(props: {
  role: string;
  items: AgentEvent[];
  open: boolean;
  onClose: () => void;
  modelInfo?: AgentModelInfo;
  onModelChange?: (adapterId: string) => void;
  status?: AgentStreamStatus;
}) {
  if (!props.open) return null;
  const info = props.modelInfo;
  const safeAdapters = info?.adapters ?? [];
  const hasMultipleAdapters = safeAdapters.length > 1;
  const currentDesc =
    safeAdapters.find((a) => a.id === (info?.currentModel ?? ""))?.description ?? "";

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-left">
            <span>📁</span>
            <div className="modal-header-title-wrap">
              <h2>Live Agent Stream - {props.role}</h2>
              <span className={`agent-stream-status status-${props.status || "idle"}`}>
                {props.status || "idle"}
              </span>
            </div>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={props.onClose}>
              ×
            </button>
          </div>
        </div>
        {info && safeAdapters.length > 0 && (
          <div className="modal-model-bar">
            <label className="model-bar-label">
              <span className="model-bar-icon">⚙️</span>
              Model:
            </label>
            <select
              className={`model-bar-select ${!info.switchable ? "disabled" : ""}`}
              value={info.currentModel}
              disabled={!info.switchable}
              onChange={(e) => props.onModelChange?.(e.target.value)}
            >
              {safeAdapters.map((adapter) => (
                <option key={adapter.id} value={adapter.id}>
                  {adapter.label}
                </option>
              ))}
            </select>
            {!info.switchable && (
              <span className="model-bar-lock" title="Model is fixed for this agent">
                🔒
              </span>
            )}
            {info.switchable && hasMultipleAdapters && (
              <span className="model-bar-hint" title={currentDesc}>
                {info.currentModel === "codex-cli" ? "📡 workspace-aware" : "🧠 pure LLM"}
              </span>
            )}
          </div>
        )}
        <div className="modal-stream-list">
          {props.items.length ? (
            props.items.map((item) => (
              <div className="modal-stream-item" key={item.id}>
                <div className="modal-stream-meta">
                  <span className={`pill pill-${item.payload?.streamKind || "raw"}`}>
                    {item.payload?.streamKind || "raw"}
                  </span>
                  <span className="modal-stream-time">{formatTime(item.created_at)}</span>
                </div>
                <pre>{item.payload?.content || item.message}</pre>
              </div>
            ))
          ) : (
            <p className="modal-empty">No stream output yet.</p>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={props.onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
