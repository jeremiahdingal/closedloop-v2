import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import "./styles.css";

type Epic = { id: string; title: string; goalText: string; targetDir: string; targetBranch: string | null; status: string; createdAt: string; updatedAt: string };
type Ticket = { id: string; epicId: string; title: string; description: string; status: string; currentNode: string | null; lastMessage: string | null; priority: string; dependencies: string[]; currentRunId: string | null; diffFiles?: { path: string; additions: number; deletions: number }[]; prUrl?: string | null };
type Run = { id: string; kind: string; status: string; currentNode: string | null; ticketId: string | null; epicId: string | null; lastMessage: string | null; heartbeatAt: string | null };
type AgentEvent = { id: number; created_at: string; message: string; run_id: string | null; ticket_id: string | null; payload: { agentRole: string; streamKind: string; content: string; source: string; done?: boolean; runId?: string | null; ticketId?: string | null; epicId?: string | null } | null };
type ModelAdapterOption = { id: string; label: string; description: string };
type AgentModelInfo = { currentModel: string; adapters: ModelAdapterOption[]; switchable: boolean };
type AgentModelsConfig = Record<string, AgentModelInfo>;

type Dashboard = { epics: Epic[]; tickets: Ticket[]; runs: Run[]; agentEvents: AgentEvent[] };

const WORKSPACES_DIR = "/data/workspaces";

const LIVE_THRESHOLD_MS = 5000;
const RUNNING_THRESHOLD_MS = 15_000;

type AgentStreamStatus = "idle" | "running" | "stalled" | "completed";

function normalizeAgentRole(role: string | null | undefined): string {
  if (role === "goalDecomposer") return "epicDecoder";
  if (role === "goalReviewer") return "epicReviewer";
  return role || "unknown";
}

function isRunActiveForRole(role: string, run: Run): boolean {
  if (run.status !== "running") return false;
  const node = (run.currentNode || "").toLowerCase();
  if (role === "system") return true;
  if (role === "builder") return run.kind === "ticket" && (node === "builder" || node.includes("build"));
  if (role === "reviewer") return run.kind === "ticket" && (node === "reviewer" || node.includes("review"));
  if (role === "tester") return run.kind === "ticket" && (node === "tester" || node.includes("test"));
  if (role === "doctor") return run.kind === "ticket" && (node === "doctor" || node.includes("classify") || node === "error");
  if (role === "epicDecoder") return run.kind === "epic" && node.includes("decompose");
  if (role === "epicReviewer") return run.kind === "epic" && (node.includes("goal_review") || node.includes("review"));
  return false;
}

function isCompletedEvent(event: AgentEvent | undefined): boolean {
  if (!event?.payload) return false;
  if (event.payload.done) return true;
  if (event.payload.streamKind !== "status") return false;
  return /(completed|failed|done|succeeded|approved)/i.test(event.payload.content || "");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

function confirmToast(input: {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  durationMs?: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const id = toast(input.title, {
      description: input.description,
      duration: input.durationMs ?? 12_000,
      action: {
        label: input.confirmLabel ?? "Confirm",
        onClick: () => {
          settled = true;
          resolve(true);
        }
      },
      cancel: {
        label: input.cancelLabel ?? "Cancel",
        onClick: () => {
          settled = true;
          resolve(false);
        }
      },
      onDismiss: () => {
        if (!settled) resolve(false);
      }
    });
    void id;
  });
}

const AGENT_GLYPHS: Record<string, string> = {
  system: "🖥️",
  builder: "🔨",
  reviewer: "🔍",
  tester: "🧪",
  epicDecoder: "🧬",
  epicReviewer: "🔎",
  doctor: "🩺",
  planner: "📐",
  unknown: "❓"
};

const truncateId = (id: string) => id.slice(0, 14) + "…";

const formatTime = (dateStr: string | null) => {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

function normalizeCompareUrl(url: string): string {
  // Backward compatibility: old links were saved as "...origin/<branch>".
  return url.replace("...origin/", "...");
}

function normalizeTicketTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function ticketStatusScore(status: string): number {
  if (status === "approved") return 6;
  if (status === "testing") return 5;
  if (status === "reviewing") return 4;
  if (status === "building") return 3;
  if (status === "queued") return 2;
  if (status === "escalated") return 1;
  if (status === "failed") return 0;
  return 0;
}

type GoalDecomposition = { summary: string; tickets: Array<{ id: string; title: string; description: string; acceptanceCriteria: string[]; dependencies: string[]; allowedPaths: string[]; priority: string }> };

function PlanningModal(props: { sessionId: string; epicTitle: string; open: boolean; onClose: () => void; onApproved: (epicId: string) => void }) {
  const [streamItems, setStreamItems] = useState<Array<{ id: number; agentRole: string; streamKind: string; content: string; source: string }>>([]);
  const [sessionStatus, setSessionStatus] = useState<"running" | "idle" | "error">("running");
  const [latestPlan, setLatestPlan] = useState<GoalDecomposition | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);
  const streamEndRef = useRef<HTMLDivElement>(null);
  const afterIndexRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!props.open) return;
    const es = new EventSource(`/api/plan-session/${encodeURIComponent(props.sessionId)}/stream`);
    esRef.current = es;
    es.addEventListener("agent", (e) => {
      const data = JSON.parse(e.data);
      afterIndexRef.current = data.id + 1;
      setStreamItems((prev) => [...prev, data]);
      setTimeout(() => streamEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    });
    es.addEventListener("session_status", (e) => {
      const data = JSON.parse(e.data);
      setSessionStatus(data.status);
    });
    es.addEventListener("plan_ready", (e) => {
      setLatestPlan(JSON.parse(e.data));
    });
    return () => { es.close(); esRef.current = null; };
  }, [props.open, props.sessionId]);

  async function sendMessage() {
    if (!messageInput.trim()) return;
    setSending(true);
    try {
      await fetchJson(`/api/plan-session/${encodeURIComponent(props.sessionId)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: messageInput.trim() })
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
      const result = await fetchJson<{ epicId: string; runId: string }>(`/api/plan-session/${encodeURIComponent(props.sessionId)}/approve`, { method: "POST" });
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
        <div className="modal-header">
          <div className="modal-header-left">
            <span>📐</span>
            <div className="modal-header-title-wrap">
              <h2>Plan Mode — {props.epicTitle}</h2>
              <span className={`plan-status-badge status-${sessionStatus}`}>
                {sessionStatus === "running" ? "⏳ planning..." : sessionStatus === "idle" ? (latestPlan ? "✅ plan ready" : "💬 awaiting input") : "⚠️ error"}
              </span>
            </div>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={props.onClose}>×</button>
          </div>
        </div>
        <div className="modal-stream-list">
          {streamItems.length ? streamItems.map((item) => (
            <div className="modal-stream-item" key={item.id}>
              <div className="modal-stream-meta">
                <span className={`pill pill-${item.streamKind || "raw"}`}>{item.streamKind || "raw"}</span>
                <span className="modal-stream-time">{item.source}</span>
              </div>
              <pre>{item.content}</pre>
            </div>
          )) : <p className="modal-empty">Planner is exploring the repository...</p>}
          <div ref={streamEndRef} />
        </div>
        {latestPlan && (
          <div className="plan-preview">
            <strong>Plan: {latestPlan.summary}</strong>
            <ul>{latestPlan.tickets.map((t) => <li key={t.id}><strong>{t.title}</strong> — {t.description.slice(0, 80)}{t.description.length > 80 ? "…" : ""}</li>)}</ul>
          </div>
        )}
        <div className="planning-modal-input-bar">
          <input
            className="planning-modal-input"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
            placeholder="Add context or answer questions from the planner..."
            disabled={sending}
          />
          <button className="btn" onClick={() => void sendMessage()} disabled={sending || !messageInput.trim()}>
            {sending ? "⏳" : "Send"}
          </button>
        </div>
        <div className="modal-footer">
          <button className="btn plan-approve-btn" onClick={() => void approvePlan()} disabled={!canApprove || approving}>
            {approving ? "⏳ Creating epic..." : "✅ Approve Plan"}
          </button>
          <button className="btn" onClick={props.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function AgentModal(props: { role: string; items: AgentEvent[]; open: boolean; onClose: () => void; modelInfo?: AgentModelInfo; onModelChange?: (adapterId: string) => void; status?: AgentStreamStatus }) {
  if (!props.open) return null;
  const info = props.modelInfo;
  const safeAdapters = info?.adapters ?? [];
  const hasMultipleAdapters = safeAdapters.length > 1;
  const currentDesc = safeAdapters.find(a => a.id === (info?.currentModel ?? ""))?.description ?? "";
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-left">
            <span>📁</span>
            <div className="modal-header-title-wrap">
              <h2>Live Agent Stream - {props.role}</h2>
              <span className={`agent-stream-status status-${props.status || "idle"}`}>{props.status || "idle"}</span>
            </div>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={props.onClose}>×</button>
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
              <span className="model-bar-lock" title="Model is fixed for this agent">🔒</span>
            )}
            {info.switchable && hasMultipleAdapters && (
              <span className="model-bar-hint" title={currentDesc}>
                {info.currentModel === "codex-cli" ? "📡 workspace-aware" : "🧠 pure LLM"}
              </span>
            )}
          </div>
        )}
        <div className="modal-stream-list">
                {props.items.length ? props.items.map((item) => (
            <div className="modal-stream-item" key={item.id}>
              <div className="modal-stream-meta">
                <span className={`pill pill-${item.payload?.streamKind || "raw"}`}>{item.payload?.streamKind || "raw"}</span>
                <span className="modal-stream-time">{formatTime(item.created_at)}</span>
              </div>
              <pre>{item.payload?.content || item.message}</pre>
            </div>
          )) : <p className="modal-empty">No stream output yet.</p>}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={props.onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

function TicketModal(props: { ticket: Ticket; events: AgentEvent[]; runs: Run[]; open: boolean; onClose: () => void; onCancel: () => void; onRerun: () => void; onForceRerunInPlace: () => void; onForceRescue: () => void; onDelete: () => void; actionBusy: boolean }) {
  if (!props.open) return null;
  const ticketRun = props.runs.find((run) => run.id === props.ticket.currentRunId) ?? null;
  const ticketEvents = props.events.filter((e) => e.ticket_id === props.ticket.id || e.run_id === props.ticket.currentRunId);
  const streamScope = props.ticket.currentRunId ? "ticket + current run" : "ticket only";
  
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal ticket-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-left">
            <span>🎫</span>
            <h2>Ticket Details</h2>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={props.onClose}>×</button>
          </div>
        </div>
        <div className="modal-body">
          <div className="ticket-detail-header">
            <span className="ticket-detail-id">{props.ticket.id}</span>
            <span className={`pill pill-${props.ticket.status}`}>{props.ticket.status}</span>
            {props.ticket.priority && <span className={`priority-${props.ticket.priority}`}>{props.ticket.priority}</span>}
          </div>
          <h3 className="ticket-detail-title">{props.ticket.title}</h3>
          {props.ticket.description ? (
            <div className="ticket-detail-message">
              <span className="detail-label">Description</span>
              <p className="detail-message">{props.ticket.description}</p>
            </div>
          ) : null}
          <div className="ticket-detail-message">
            <span className="detail-label">Stream Scope</span>
            <p className="detail-message">
              This view shows {streamScope} agent events for the selected ticket. Epic-level runs appear in the Recent Runs panel, not here.
            </p>
          </div>
          
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
              <span className="detail-value">{ticketRun ? truncateId(ticketRun.id) : "none"}</span>
            </div>
            <div className="detail-section">
              <span className="detail-label">Run Status</span>
              <span className="detail-value">{ticketRun ? `${ticketRun.status} · ${ticketRun.currentNode ?? "queued"}` : "no active run"}</span>
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

          {(props.ticket.diffFiles?.length ?? 0) > 0 && (
            <div className="pr-changes-card">
              <div className="pr-changes-header">
                <span className="pr-changes-icon">📄</span>
                <span className="pr-changes-title">Changes</span>
              </div>
              <div className="pr-files">
                {props.ticket.diffFiles!.map((file, idx) => (
                  <div key={idx} className="pr-file-row">
                    <span className="pr-file-name">{file.path}</span>
                    <span className="pr-file-stats">
                      <span className="pr-add">+{file.additions}</span>
                      <span className="pr-del">-{file.deletions}</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="pr-changes-footer">
                {props.ticket.diffFiles!.reduce((sum, f) => sum + f.additions, 0)} additions, {props.ticket.diffFiles!.reduce((sum, f) => sum + f.deletions, 0)} deletions
              </div>
            </div>
          )}

          {props.ticket.prUrl ? (
            <div className="pr-link-card">
              <div className="pr-link-header">
                <span className="pr-link-icon">🔗</span>
                <span className="pr-link-title">Pull Request</span>
              </div>
              <a href={normalizeCompareUrl(props.ticket.prUrl)} target="_blank" rel="noopener noreferrer" className="pr-url">
                {normalizeCompareUrl(props.ticket.prUrl)}
              </a>
            </div>
          ) : null}
          
          {props.ticket.lastMessage && (
            <div className="ticket-detail-message">
              <span className="detail-label">Last Message</span>
              <p className="detail-message">{props.ticket.lastMessage}</p>
            </div>
          )}
          
          <div className="ticket-events-section">
            <span className="detail-label">Agent Events ({ticketEvents.length})</span>
            <div className="ticket-events-list">
              {ticketEvents.length ? ticketEvents.slice(-10).map((event) => (
                <div className="ticket-event-item" key={event.id}>
                  <span className="event-time">{formatTime(event.created_at)}</span>
                  <span className="event-role">{normalizeAgentRole(event.payload?.agentRole)}</span>
                  <span className="event-content">{event.payload?.content || event.message || "..."}</span>
                </div>
              )) : <p className="no-events">No events yet.</p>}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={props.onCancel} disabled={props.actionBusy}>Cancel Ticket</button>
          <button className="btn" onClick={props.onRerun} disabled={props.actionBusy}>Rerun Ticket</button>
          <button className="btn" onClick={props.onForceRerunInPlace} disabled={props.actionBusy}>Force Rerun In Place</button>
          <button className="btn" onClick={props.onForceRescue} disabled={props.actionBusy}>Force Rescue Reviewer</button>
          <button className="btn mini-btn mini-btn-danger" onClick={props.onDelete} disabled={props.actionBusy}>Delete Ticket</button>
          <button className="btn" onClick={props.onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

function EpicModal(props: { epic: Epic; open: boolean; onClose: () => void; onReview: () => void; onCancel: () => void; onDelete: () => void; actionBusy: boolean }) {
  if (!props.open) return null;
  
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal epic-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-left">
            <span>📂</span>
            <h2>Epic Details</h2>
          </div>
          <div className="win-titlebar-buttons">
            <button className="win-btn-box" onClick={props.onClose}>×</button>
          </div>
        </div>
        <div className="modal-body">
          <div className="epic-detail-header">
            <span className="epic-detail-id">{props.epic.id}</span>
            <span className={`pill pill-${props.epic.status}`}>{props.epic.status}</span>
          </div>
          <h3 className="epic-detail-title">{props.epic.title}</h3>
          
          <div className="epic-detail-section">
            <span className="detail-label">Description</span>
            <div className="epic-description"><ReactMarkdown>{props.epic.goalText}</ReactMarkdown></div>
          </div>
          
          <div className="epic-detail-grid">
            <div className="detail-section">
              <span className="detail-label">Target Dir</span>
              <span className="detail-value">{props.epic.targetDir}</span>
            </div>
            <div className="detail-section">
              <span className="detail-label">Target Branch</span>
              <span className="detail-value">{props.epic.targetBranch || "—"}</span>
            </div>
            <div className="detail-section">
              <span className="detail-label">Created</span>
              <span className="detail-value">{new Date(props.epic.createdAt).toLocaleString()}</span>
            </div>
            <div className="detail-section">
              <span className="detail-label">Updated</span>
              <span className="detail-value">{new Date(props.epic.updatedAt).toLocaleString()}</span>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={props.onReview} disabled={props.actionBusy}>Review</button>
          <button className="btn" onClick={props.onCancel} disabled={props.actionBusy}>Cancel</button>
          <button className="btn mini-btn mini-btn-danger" onClick={props.onDelete} disabled={props.actionBusy}>Delete</button>
          <button className="btn" onClick={props.onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [data, setData] = useState<Dashboard>({ epics: [], tickets: [], runs: [], agentEvents: [] });
  const [modelsConfig, setModelsConfig] = useState<AgentModelsConfig>({});
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [goalText, setGoalText] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [targetDirEditing, setTargetDirEditing] = useState(false);
  const [targetBranch, setTargetBranch] = useState("");
  const [epicMode, setEpicMode] = useState<"build" | "plan">("build");
  const [planSessionId, setPlanSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [selectedEpic, setSelectedEpic] = useState<string | null>(null);
  const [selectedEpicDetails, setSelectedEpicDetails] = useState<Epic | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [selectedTicketEvents, setSelectedTicketEvents] = useState<AgentEvent[]>([]);
  const selectedTicketRef = useRef<Ticket | null>(null);
  const latestAgentEventIdRef = useRef(0);

  async function refreshModels() {
    try {
      const models = await fetchJson<AgentModelsConfig>("/api/models");
      setModelsConfig(models);
    } catch {
      // Leave the last known model config in place if the models endpoint is unavailable.
    }
  }

  useEffect(() => {
    fetchJson<Record<string, unknown>>("/api/config").then(cfg => {
      if (typeof cfg.targetDir === "string") setTargetDir(cfg.targetDir);
      if (cfg.models && typeof cfg.models === "object" && !Array.isArray(cfg.models)) {
        setModelsConfig(cfg.models as AgentModelsConfig);
      }
    }).catch(() => {});
    void refreshModels();
  }, []);

  async function refresh() {
    try {
      setLoading(true);
      const [epics, tickets, runs, fetchedAgentEvents] = await Promise.all([
        fetchJson<Epic[]>("/api/epics"),
        fetchJson<Ticket[]>("/api/tickets"),
        fetchJson<Run[]>("/api/runs"),
        fetchJson<AgentEvent[]>("/api/agent-events?limit=600")
      ]);
      // Merge fetched events with any SSE-captured events to avoid losing recent ones
      setData((current) => {
        const merged = new Map<number, AgentEvent>();
        for (const e of fetchedAgentEvents) merged.set(e.id, e);
        for (const e of current.agentEvents) merged.set(e.id, e);
        const agentEvents = [...merged.values()].sort((a, b) => a.id - b.id).slice(-600);
        return { epics, tickets, runs, agentEvents };
      });
      void refreshModels();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const [lastEventTime, setLastEventTime] = useState<Map<string, number>>(new Map());
  const [collapsedPanels, setCollapsedPanels] = useState<Set<string>>(new Set());
  const [nowTick, setNowTick] = useState<number>(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const togglePanel = (panelId: string) => {
    setCollapsedPanels(prev => {
      const next = new Set(prev);
      if (next.has(panelId)) next.delete(panelId);
      else next.add(panelId);
      return next;
    });
  };

  const eventsByRole = useMemo(() => {
    const grouped = new Map<string, AgentEvent[]>();
    for (const item of data.agentEvents) {
      const role = normalizeAgentRole(item.payload?.agentRole);
      const arr = grouped.get(role) ?? [];
      arr.push(item);
      grouped.set(role, arr);
    }
    return grouped;
  }, [data.agentEvents]);

  useEffect(() => {
    selectedTicketRef.current = selectedTicket;
  }, [selectedTicket]);

  useEffect(() => {
    latestAgentEventIdRef.current = data.agentEvents.at(-1)?.id ?? 0;
  }, [data.agentEvents]);

  useEffect(() => {
    const source = new EventSource("/api/agent-stream");
    source.addEventListener("ready", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { afterId?: number };
      if (typeof payload.afterId === "number") {
        latestAgentEventIdRef.current = Math.max(latestAgentEventIdRef.current, payload.afterId);
      }
    });
    source.addEventListener("agent", (event) => {
      const row = JSON.parse((event as MessageEvent).data) as AgentEvent;
      if (row.id <= latestAgentEventIdRef.current) return;
      latestAgentEventIdRef.current = row.id;
      setData((current) => {
        const next = [...current.agentEvents, row].slice(-600);
        return { ...current, agentEvents: next };
      });
      setSelectedTicketEvents((current) => {
        const selected = selectedTicketRef.current;
        if (!selected) return current;
        const matchesTicket = row.ticket_id === selected.id;
        const matchesRun = Boolean(selected.currentRunId) && row.run_id === selected.currentRunId;
        if (!matchesTicket && !matchesRun) return current;
        const next = [...current, row];
        const deduped = Array.from(new Map(next.map((item) => [item.id, item])).values());
        return deduped.slice(-200);
      });
      const role = normalizeAgentRole(row.payload?.agentRole);
      setLastEventTime((prev) => new Map(prev).set(role, Date.now()));
    });
    return () => source.close();
  }, []);

  useEffect(() => {
    if (!selectedTicket) {
      setSelectedTicketEvents([]);
      return;
    }

    let cancelled = false;
    const params = new URLSearchParams({ ticketId: selectedTicket.id, limit: "200" });
    if (selectedTicket.currentRunId) params.set("runId", selectedTicket.currentRunId);

    void fetchJson<AgentEvent[]>(`/api/agent-events?${params.toString()}`)
      .then((events) => {
        if (!cancelled) setSelectedTicketEvents(events);
      })
      .catch(() => {
        if (!cancelled) setSelectedTicketEvents([]);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedTicket]);

  const isAgentActive = useMemo(() => {
    const now = Date.now();
    const active = new Map<string, boolean>();
    for (const [role] of eventsByRole) {
      const lastTime = lastEventTime.get(role) || 0;
      active.set(role, now - lastTime < LIVE_THRESHOLD_MS);
    }
    return active;
  }, [eventsByRole, lastEventTime]);

  const agentRoles = useMemo(() => {
    const fromConfig = modelsConfig && typeof modelsConfig === "object" ? Object.keys(modelsConfig) : [];
    const fromEvents = [...eventsByRole.keys()];
    const all = new Set([...fromConfig, ...fromEvents]);
    return [...all].sort((a, b) => {
      const order = ["epicDecoder", "builder", "reviewer", "tester", "epicReviewer", "doctor"];
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [modelsConfig, eventsByRole]);

  const agentStatusByRole = useMemo(() => {
    const status = new Map<string, AgentStreamStatus>();
    for (const role of agentRoles) {
      const events = eventsByRole.get(role) ?? [];
      const latest = events.reduce<AgentEvent | undefined>((current, event) => {
        if (!current) return event;
        return event.id > current.id ? event : current;
      }, undefined);
      const latestTs = latest ? new Date(latest.created_at).getTime() : 0;
      const roleHasActiveRun = data.runs.some((run) => isRunActiveForRole(role, run));
      if (roleHasActiveRun) {
        status.set(role, !latestTs || (nowTick - latestTs <= RUNNING_THRESHOLD_MS) ? "running" : "stalled");
        continue;
      }
      if (isCompletedEvent(latest)) {
        status.set(role, "completed");
        continue;
      }
      status.set(role, "idle");
    }
    return status;
  }, [agentRoles, eventsByRole, data.runs, nowTick]);

  const activeItems = openRole ? [...(eventsByRole.get(openRole) ?? [])].reverse() : [];

  const dedupedTickets = useMemo(() => {
    const grouped = new Map<string, Ticket[]>();
    for (const ticket of data.tickets) {
      const key = `${ticket.epicId}::${normalizeTicketTitleKey(ticket.title)}`;
      const arr = grouped.get(key) ?? [];
      arr.push(ticket);
      grouped.set(key, arr);
    }
    const winners: Ticket[] = [];
    for (const items of grouped.values()) {
      items.sort((a, b) => ticketStatusScore(b.status) - ticketStatusScore(a.status));
      winners.push(items[0]);
    }
    return winners;
  }, [data.tickets]);

  const filteredTickets = selectedEpic
    ? dedupedTickets.filter((t) => t.epicId === selectedEpic)
    : dedupedTickets;

  const ticketsByEpic = useMemo(() => {
    const grouped = new Map<string, Ticket[]>();
    for (const ticket of dedupedTickets) {
      const arr = grouped.get(ticket.epicId) ?? [];
      arr.push(ticket);
      grouped.set(ticket.epicId, arr);
    }
    return grouped;
  }, [dedupedTickets]);

  const activeCount = dedupedTickets.filter((t) => t.status === "building" || t.status === "reviewing" || t.status === "testing").length;

  async function createEpic() {
    if (epicMode === "plan") {
      try {
        setSubmitting(true);
        const result = await fetchJson<{ sessionId: string }>("/api/plan-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ epicTitle: title, epicDescription: goalText, targetDir })
        });
        setPlanSessionId(result.sessionId);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSubmitting(false);
      }
      return;
    }
    try {
      setSubmitting(true);
      await fetchJson("/api/epics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, goalText, targetDir, targetBranch: targetBranch || undefined })
      });
      await refresh();
      setTitle("");
      setGoalText("");
      setTargetBranch("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelEpic(epicId: string) {
    const confirmed = await confirmToast({
      title: "Cancel epic?",
      description: "This interrupts ticket runs and marks the epic as cancelled.",
      confirmLabel: "Cancel Epic"
    });
    if (!confirmed) return;
    const toastId = toast.loading("Cancelling epic...");
    try {
      setActionBusy(`cancel-epic-${epicId}`);
      await fetchJson(`/api/epics/${encodeURIComponent(epicId)}/cancel`, { method: "POST" });
      if (selectedEpic === epicId) setSelectedEpic(null);
      if (selectedTicket?.epicId === epicId) setSelectedTicket(null);
      setSelectedEpicDetails(null);
      await refresh();
      toast.success("Epic cancelled.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to cancel epic: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function deleteEpic(epicId: string) {
    const confirmed = await confirmToast({
      title: "Delete epic?",
      description: "This removes epic/ticket records, branches, and related artifacts.",
      confirmLabel: "Delete Epic"
    });
    if (!confirmed) return;
    const toastId = toast.loading("Deleting epic...");
    try {
      setActionBusy(`delete-epic-${epicId}`);
      await fetchJson(`/api/epics/${encodeURIComponent(epicId)}`, { method: "DELETE" });
      if (selectedEpic === epicId) setSelectedEpic(null);
      if (selectedTicket?.epicId === epicId) setSelectedTicket(null);
      setSelectedEpicDetails(null);
      await refresh();
      toast.success("Epic deleted.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to delete epic: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function reviewEpic(epicId: string) {
    const confirmed = await confirmToast({
      title: "Run epic review now?",
      description: "This runs checks across approved tickets, then manually runs the epic reviewer.",
      confirmLabel: "Run Review"
    });
    if (!confirmed) return;
    const toastId = toast.loading("Queuing epic review...");
    try {
      setActionBusy(`review-epic-${epicId}`);
      await fetchJson(`/api/epics/${encodeURIComponent(epicId)}/review`, { method: "POST" });
      await refresh();
      toast.success("Epic review queued.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to queue epic review: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function cancelTicket(ticketId: string) {
    const confirmed = await confirmToast({
      title: "Cancel ticket?",
      description: "This interrupts the current ticket flow and marks it cancelled.",
      confirmLabel: "Cancel Ticket"
    });
    if (!confirmed) return;
    const toastId = toast.loading("Cancelling ticket...");
    try {
      setActionBusy(`cancel-ticket-${ticketId}`);
      await fetchJson(`/api/tickets/${encodeURIComponent(ticketId)}/cancel`, { method: "POST" });
      await refresh();
      toast.success("Ticket cancelled.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to cancel ticket: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function deleteTicket(ticketId: string) {
    const confirmed = await confirmToast({
      title: "Delete ticket?",
      description: "This removes ticket records, branch references, and artifacts.",
      confirmLabel: "Delete Ticket"
    });
    if (!confirmed) return;
    const toastId = toast.loading("Deleting ticket...");
    try {
      setActionBusy(`delete-ticket-${ticketId}`);
      await fetchJson(`/api/tickets/${encodeURIComponent(ticketId)}`, { method: "DELETE" });
      if (selectedTicket?.id === ticketId) setSelectedTicket(null);
      await refresh();
      toast.success("Ticket deleted.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to delete ticket: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function rerunTicket(ticketId: string) {
    const confirmed = await confirmToast({
      title: "Rerun ticket?",
      description: "This queues a fresh run for this ticket using current model selections.",
      confirmLabel: "Rerun Ticket"
    });
    if (!confirmed) return;
    const toastId = toast.loading("Queuing ticket rerun...");
    try {
      setActionBusy(`rerun-ticket-${ticketId}`);
      await fetchJson(`/api/tickets/${encodeURIComponent(ticketId)}/rerun`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cancelActive: true })
      });
      await refresh();
      toast.success("Ticket rerun queued.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to rerun ticket: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function forceRerunTicketInPlace(ticketId: string) {
    const confirmed = await confirmToast({
      title: "Force rerun in place?",
      description: "This requeues the current run id in recovery mode without creating a new run.",
      confirmLabel: "Force Rerun"
    });
    if (!confirmed) return;
    const toastId = toast.loading("Forcing in-place rerun...");
    try {
      setActionBusy(`force-rerun-ticket-${ticketId}`);
      await fetchJson(`/api/tickets/${encodeURIComponent(ticketId)}/force-rerun-in-place`, {
        method: "POST"
      });
      await refresh();
      toast.success("In-place rerun queued.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to force rerun in place: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function forceRescueTicket(ticketId: string) {
    const confirmed = await confirmToast({
      title: "Force reviewer rescue?",
      description: "This manually requeues the current run if reviewer appears stalled for at least 60 seconds.",
      confirmLabel: "Force Rescue"
    });
    if (!confirmed) return;
    const toastId = toast.loading("Forcing reviewer rescue...");
    try {
      setActionBusy(`force-rescue-ticket-${ticketId}`);
      await fetchJson(`/api/tickets/${encodeURIComponent(ticketId)}/force-rescue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ minStaleMs: 60_000, requireReviewerNode: true })
      });
      await refresh();
      toast.success("Reviewer rescue queued.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to force reviewer rescue: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function updateAgentModel(role: string, model: string) {
    const current = modelsConfig[role]?.currentModel;
    if (!current || current === model) return;
    const toastId = toast.loading(`Updating ${role} model...`);
    try {
      const response = await fetchJson<{ ok: boolean; models: AgentModelsConfig }>("/api/models", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role, model })
      });
      setModelsConfig(response.models);
      setModelOverrides((prev) => ({ ...prev, [role]: model }));
      toast.success(`${role} now uses ${model}.`, { id: toastId });
    } catch (err) {
      toast.error(`Failed to update ${role}: ${(err as Error).message}`, { id: toastId });
    }
  }

  return (
    <div className="shell">
      {/* Topbar Panel */}
      <div className="win-panel topbar">
        <div className="win-titlebar">
          <div className="win-titlebar-text">
            <span>🪟</span>
            <span>Workflow Terminal</span>
          </div>
          <div className="win-titlebar-buttons">
            <div className="win-btn-box">_</div>
            <div className="win-btn-box">□</div>
            <div className="win-btn-box">×</div>
          </div>
        </div>
        <div className="win-content">
          <div className="topbar-hero">
            <div className="title-with-mascot">
              <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" className="title-mascot">
                <g className="m-ear-left"><rect x="4" y="3" width="3" height="3" fill="#5D4037" /><rect x="5" y="4" width="1" height="1" fill="#8D6E63" /></g>
                <g className="m-ear-right"><rect x="13" y="3" width="3" height="3" fill="#5D4037" /><rect x="14" y="4" width="1" height="1" fill="#8D6E63" /></g>
                <g className="m-breathing">
                  <g className="m-head">
                    <rect x="5" y="5" width="10" height="7" fill="#795548" />
                    <rect x="4" y="7" width="1" height="3" fill="#795548" />
                    <rect x="15" y="7" width="1" height="3" fill="#795548" />
                    <rect x="8" y="8" width="4" height="3" fill="#D7CCC8" />
                    <rect x="9" y="9" width="2" height="1" fill="#212121" />
                    <g className="m-eye m-eye-left"><rect x="7" y="7" width="1" height="1" fill="#212121" /></g>
                    <g className="m-eye m-eye-right"><rect x="12" y="7" width="1" height="1" fill="#212121" /></g>
                  </g>
                  <g className="m-torso">
                    <rect x="5" y="12" width="10" height="6" fill="#795548" />
                    <rect x="4" y="13" width="12" height="4" fill="#795548" />
                    <rect x="8" y="13" width="4" height="4" fill="#8D6E63" />
                  </g>
                  <g className="m-arm-left"><rect x="2" y="12" width="3" height="3" fill="#795548" /></g>
                  <g className="m-arm-right"><rect x="15" y="12" width="3" height="3" fill="#795548" /></g>
                </g>
                <g className="m-foot-left"><rect x="5" y="18" width="3" height="2" fill="#5D4037" /></g>
                <g className="m-foot-right"><rect x="12" y="18" width="3" height="2" fill="#5D4037" /></g>
              </svg>
              <pre className="ascii-art">
                <span className="ascii-shadow">
{`   ____ _     ___  ____  _____ ____  _     ___   ___  ____   __     ______  
  / ___| |   / _ \\/ ___|| ____|  _ \\| |   / _ \\ / _ \\|  _ \\  \\ \\   / /___ \\ 
 | |   | |  | | | \\___ \\|  _| | | | | |  | | | | | | | |_) |  \\ \\ / /  __) |
 | |___| |__| |_| |___) | |___| |_| | |__| |_| | |_| |  __/    \\ V /  / __/ 
  \\____|_____|___/|____/|_____|____/|_____|___/ \\___/|_|        \\_/  |_____| `}
                </span>
                <span className="ascii-text">
{`   ____ _     ___  ____  _____ ____  _     ___   ___  ____   __     ______  
  / ___| |   / _ \\/ ___|| ____|  _ \\| |   / _ \\ / _ \\|  _ \\  \\ \\   / /___ \\ 
 | |   | |  | | | \\___ \\|  _| | | | | |  | | | | | | | |_) |  \\ \\ / /  __) |
 | |___| |__| |_| |___) | |___| |_| | |__| |_| | |_| |  __/    \\ V /  / __/ 
  \\____|_____|___/|____/|_____|____/|_____|___/ \\___/|_|        \\_/  |_____| `}
                </span>
              </pre>
            </div>
            <span className="subtitle-mono">workspace: {targetDir}</span>
          </div>
          <div className="topbar-actions">
            <button className="btn" onClick={() => void refresh()} disabled={loading}>
              {loading ? "⏳ Refresh..." : "🔄 Refresh"}
            </button>
            <label className="toggle">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
              Auto-refresh
            </label>
          </div>
        </div>
      </div>

      {/* Agent Stats */}
      <div className="win-panel agent-stats-panel">
        <div className="win-titlebar">
          <div className="win-titlebar-text">
            <span>🎮</span>
            <span>All Agent Streams ({agentRoles.length})</span>
          </div>
          <div className="win-titlebar-buttons">
            <div className="win-btn-box" onClick={() => togglePanel("agents")}>_</div>
            <div className="win-btn-box">×</div>
          </div>
        </div>
        <div className={`win-content ${collapsedPanels.has("agents") ? "collapsed" : ""}`}>
          <div className="agent-stats-grid two-cols">
            {agentRoles.map((role) => (
              <button key={role} className="agent-stat-box" onClick={() => setOpenRole(role)}>
                <span className={`agent-stat-icon ${isAgentActive.get(role) ? "active" : ""}`}>◆</span>
                <span className="agent-stat-name">{role}</span>
                <span className={`agent-stat-status status-${agentStatusByRole.get(role) || "idle"}`}>{agentStatusByRole.get(role) || "idle"}</span>
                <span className="agent-stat-glyph">{AGENT_GLYPHS[role] || AGENT_GLYPHS.unknown}</span>
                <span className="agent-stat-count">{eventsByRole.get(role)?.length ?? 0}</span>
                <span className="agent-stat-label">msgs</span>
              </button>
            ))}
            {!agentRoles.length ? <p className="no-agents">📭 No agent stream yet.</p> : null}
          </div>
        </div>
      </div>

      {/* Main Grid */}
      <div className="main-grid">
        {/* Left Column */}
        <div className="left-col">
          {/* Mission Status */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📊</span>
                <span>Mission Status</span>
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box">_</div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div className="stats-row crt-row">
              <div className="crt-tv">
                <div className="crt-screen">
                  <span className="crt-label">📁 EPICS</span>
                  <span className="crt-value">{data.epics.length}</span>
                </div>
                <div className="crt-body"></div>
              </div>
              <div className="crt-tv">
                <div className="crt-screen">
                  <span className="crt-label">📋 TICKETS</span>
                  <span className="crt-value">{data.tickets.length}</span>
                </div>
                <div className="crt-body"></div>
              </div>
              <div className="crt-tv">
                <div className="crt-screen">
                  <span className="crt-label">⚙️ RUNS</span>
                  <span className="crt-value">{data.runs.length}</span>
                </div>
                <div className="crt-body"></div>
              </div>
              <div className="crt-tv">
                <div className="crt-screen">
                  <span className="crt-label">🔥 ACTIVE</span>
                  <span className="crt-value">{activeCount}</span>
                </div>
                <div className="crt-body"></div>
              </div>
            </div>
          </div>

          {/* Live Preview */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📡</span>
                <span>Live Preview</span>
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box">_</div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div className="win-content">
              <div className="preview-content">
                {data.agentEvents.length ? data.agentEvents.slice(-10).map((item) => (
                  <div className="preview-item" key={item.id}>
                    <span className="preview-role">{normalizeAgentRole(item.payload?.agentRole)}</span>
                    <span className="preview-msg">{item.payload?.content || item.message || "..."}</span>
                  </div>
                )) : <span className="preview-empty">Waiting for agent output...</span>}
              </div>
            </div>
          </div>

          {/* New Epic */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📝</span>
                <span>New Epic</span>
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box" onClick={() => togglePanel("newEpic")}>_</div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div className={`win-content ${collapsedPanels.has("newEpic") ? "collapsed" : ""}`}>
              <div className="create-form">
                <label>
                  Title:
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Epic title" />
                </label>
                <label>
                  Goal:
                  <textarea value={goalText} onChange={(e) => setGoalText(e.target.value)} rows={4} placeholder="Describe the goal" />
                </label>
                <div className="target-dir-row">
                  <label className="target-dir-label">Mode:</label>
                  <select className="mode-select" value={epicMode} onChange={(e) => setEpicMode(e.target.value as "build" | "plan")}>
                    <option value="build">🚀 Build</option>
                    <option value="plan">📐 Plan</option>
                  </select>
                  {epicMode === "plan" && <span className="mode-hint">Explore &amp; plan before building</span>}
                </div>
                {epicMode === "build" && (
                <div className="target-dir-row">
                  <label className="target-dir-label">Target Branch:</label>
                  <input
                    className="target-dir-input"
                    value={targetBranch}
                    onChange={(e) => setTargetBranch(e.target.value)}
                    placeholder="feature/my-branch (optional)"
                  />
                </div>
                )}
                <div className="target-dir-row">
                  <label className="target-dir-label">Target Dir:</label>
                  <input 
                    className="target-dir-input"
                    value={targetDir} 
                    onChange={(e) => setTargetDir(e.target.value)} 
                    placeholder="C:\path\to\project" 
                    disabled={!targetDirEditing}
                  />
                  <button 
                    className="btn target-dir-btn" 
                    onClick={async () => {
                      if (targetDirEditing) {
                        await fetchJson("/api/config", {
                          method: "PUT",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ targetDir })
                        });
                        setTargetDirEditing(false);
                      } else {
                        setTargetDirEditing(true);
                      }
                    }}
                  >
                    {targetDirEditing ? "💾" : "✏️"}
                  </button>
                </div>
                <button className="btn btn-primary" onClick={() => void createEpic()} disabled={submitting || !title || !goalText}>
                  {submitting ? "⏳..." : epicMode === "plan" ? "📐 Start Planning" : "🚀 Create and Queue"}
                </button>
                {error ? <p className="error-msg">⚠️ {error}</p> : null}
              </div>
            </div>
          </div>

          {/* Epics */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📂</span>
                <span>Epics ({data.epics.length})</span>
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box" onClick={() => togglePanel("epics")}>_</div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div className={`win-content win-inset ${collapsedPanels.has("epics") ? "collapsed" : ""}`}>
              <div className="epic-list">
                {data.epics.length ? data.epics.map((epic) => (
                  <div
                    key={epic.id}
                    className={`epic-item ${selectedEpic === epic.id ? "selected" : epic.status}`}
                    onClick={() => setSelectedEpic(selectedEpic === epic.id ? null : epic.id)}
                  >
                    <div className="epic-top">
                      <div>
                        <span className="epic-id">{epic.id}</span>
                        <span className="epic-title">{epic.title}</span>
                      </div>
                      <div className="item-actions">
                        <span className={`pill pill-${epic.status}`}>{epic.status}</span>
                        <button className="mini-btn" onClick={(e) => { e.stopPropagation(); setSelectedEpicDetails(epic); }} disabled={actionBusy !== null}>
                          View
                        </button>
                      </div>
                    </div>
                    <p className="epic-goal">{epic.goalText.length > 100 ? epic.goalText.slice(0, 100) + "…" : epic.goalText}</p>
                    <p className="epic-meta">Updated: {formatTime(epic.updatedAt)}</p>
                  </div>
                )) : <p className="epic-empty">📭 Create your first epic to kick off the workflow.</p>}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="right-col">
          {/* Tickets */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📋</span>
                <span>Tickets ({filteredTickets.length})</span>
                {selectedEpic && <span className="filter-badge">🔍 {truncateId(selectedEpic)}</span>}
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box" onClick={() => togglePanel("tickets")}>_</div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div className={`win-content win-inset ${collapsedPanels.has("tickets") ? "collapsed" : ""}`}>
              <div className="ticket-list">
                {filteredTickets.length ? filteredTickets.map((ticket) => (
                  <div className="ticket-item" key={ticket.id} onClick={() => setSelectedTicket(ticket)}>
                    <div className="ticket-top">
                      <div style={{ flex: 1 }}>
                        <div className="ticket-id-row">
                          <span className="ticket-id">{truncateId(ticket.id)}</span>
                          {ticket.priority && <span className={`priority-${ticket.priority}`}>{ticket.priority}</span>}
                        </div>
                        <p className="ticket-title">{ticket.title}</p>
                      </div>
                      <div className="item-actions">
                        <span className={`pill pill-${ticket.status}`}>{ticket.status}</span>
                      </div>
                    </div>
                    {ticket.lastMessage && (
                      <p className="ticket-last-msg">"{ticket.lastMessage}"</p>
                    )}
                    <div className="ticket-footer">
                      {ticket.dependencies.length > 0 && (
                        <span>
                          <span className="editorial-spacing">Depends:</span>
                          {ticket.dependencies.map((d) => d.split("__").pop()).join(", ")}
                        </span>
                      )}
                      {ticket.currentNode && (
                        <span>
                          <span className="editorial-spacing">Node:</span>
                          {ticket.currentNode}
                        </span>
                      )}
                      {(ticketsByEpic.get(ticket.epicId) ?? []).length > 0 && (
                        <span>
                          <span className="editorial-spacing">Epic:</span>
                          {truncateId(ticket.epicId)}
                        </span>
                      )}
                    </div>
                  </div>
                )) : (
                  <p className="ticket-empty">📭 {selectedEpic ? "No tickets for this epic yet." : "No tickets yet."}</p>
                )}
              </div>
            </div>
          </div>

          {/* Recent Runs */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📺</span>
                <span>Recent Runs</span>
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box" onClick={() => togglePanel("runs")}>_</div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div className={`win-content ${collapsedPanels.has("runs") ? "collapsed" : ""}`}>
              <div className="run-list">
                {data.runs.slice(0, 10).map((run) => (
                  <div className="run-row" key={run.id}>
                    <div>
                      <span className="run-kind">{run.kind}</span>
                      <span style={{ marginLeft: "0.5rem" }} className="run-id">{truncateId(run.id)}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span className={`pill pill-${run.status}`}>{run.status}</span>
                      <span className="run-node">{run.currentNode ?? "queued"}</span>
                    </div>
                  </div>
                ))}
                {!data.runs.length ? <p className="run-empty">📭 No runs yet.</p> : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      <AgentModal
        role={openRole || "agent"}
        items={activeItems}
        open={Boolean(openRole)}
        onClose={() => setOpenRole(null)}
        status={openRole ? (agentStatusByRole.get(openRole) || "idle") : "idle"}
        modelInfo={openRole && modelsConfig[openRole] ? {
          currentModel: modelOverrides[openRole] ?? modelsConfig[openRole].currentModel,
          adapters: modelsConfig[openRole].adapters,
          switchable: modelsConfig[openRole].switchable
        } : undefined}
        onModelChange={(adapterId) => {
          if (!openRole) return;
          void updateAgentModel(openRole, adapterId);
        }}
      />
      <TicketModal
        ticket={selectedTicket!}
        events={selectedTicket ? selectedTicketEvents : data.agentEvents}
        runs={data.runs}
        open={Boolean(selectedTicket)}
        onClose={() => setSelectedTicket(null)}
        onCancel={() => selectedTicket && void cancelTicket(selectedTicket.id)}
        onRerun={() => selectedTicket && void rerunTicket(selectedTicket.id)}
        onForceRerunInPlace={() => selectedTicket && void forceRerunTicketInPlace(selectedTicket.id)}
        onForceRescue={() => selectedTicket && void forceRescueTicket(selectedTicket.id)}
        onDelete={() => selectedTicket && void deleteTicket(selectedTicket.id)}
        actionBusy={actionBusy !== null}
      />
      <EpicModal
        epic={selectedEpicDetails!}
        open={Boolean(selectedEpicDetails)}
        onClose={() => setSelectedEpicDetails(null)}
        onReview={() => { if (selectedEpicDetails) void reviewEpic(selectedEpicDetails.id); }}
        onCancel={() => { if (selectedEpicDetails) void cancelEpic(selectedEpicDetails.id); }}
        onDelete={() => { if (selectedEpicDetails) void deleteEpic(selectedEpicDetails.id); }}
        actionBusy={actionBusy !== null}
      />
      {planSessionId && (
        <PlanningModal
          sessionId={planSessionId}
          epicTitle={title || "Plan Mode"}
          open={true}
          onClose={() => setPlanSessionId(null)}
          onApproved={async (_epicId) => {
            setPlanSessionId(null);
            setTitle("");
            setGoalText("");
            await refresh();
          }}
        />
      )}
    </div>
  );
}
