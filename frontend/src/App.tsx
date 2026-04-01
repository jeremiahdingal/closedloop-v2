import { useEffect, useMemo, useState } from "react";
import "./styles.css";

type Epic = { id: string; title: string; goalText: string; status: string; createdAt: string; updatedAt: string };
type Ticket = { id: string; epicId: string; title: string; status: string; currentNode: string | null; lastMessage: string | null; priority: string; dependencies: string[] };
type Run = { id: string; kind: string; status: string; currentNode: string | null; ticketId: string | null; epicId: string | null; lastMessage: string | null; heartbeatAt: string | null };
type AgentEvent = { id: number; created_at: string; message: string; run_id: string | null; ticket_id: string | null; payload: { agentRole: string; streamKind: string; content: string; source: string; done?: boolean; runId?: string | null; ticketId?: string | null; epicId?: string | null } | null };

type Dashboard = { epics: Epic[]; tickets: Ticket[]; runs: Run[]; agentEvents: AgentEvent[] };

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

const truncateId = (id: string) => id.slice(0, 14) + "…";

const formatTime = (dateStr: string | null) => {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

function AgentModal(props: { role: string; items: AgentEvent[]; open: boolean; onClose: () => void }) {
  if (!props.open) return null;
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="editorial-spacing eyebrow">Live agent stream</p>
            <h2>{props.role}</h2>
          </div>
          <button className="btn" onClick={props.onClose}>Close</button>
        </div>
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
      </div>
    </div>
  );
}

export function App() {
  const [data, setData] = useState<Dashboard>({ epics: [], tickets: [], runs: [], agentEvents: [] });
  const [title, setTitle] = useState("Implement shared workflow bridge");
  const [goalText, setGoalText] = useState("Create isolated ticket workspaces, run the local builder-reviewer-tester loop, and finish with goal-level review.");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [selectedEpic, setSelectedEpic] = useState<string | null>(null);

  async function refresh() {
    try {
      setLoading(true);
      const [epics, tickets, runs, agentEvents] = await Promise.all([
        fetchJson<Epic[]>("/api/epics"),
        fetchJson<Ticket[]>("/api/tickets"),
        fetchJson<Run[]>("/api/runs"),
        fetchJson<AgentEvent[]>("/api/agent-events?limit=300")
      ]);
      setData({ epics, tickets, runs, agentEvents });
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

  useEffect(() => {
    const source = new EventSource("/api/agent-stream");
    source.addEventListener("agent", (event) => {
      const row = JSON.parse((event as MessageEvent).data) as AgentEvent;
      setData((current) => {
        const next = [...current.agentEvents, row].slice(-600);
        return { ...current, agentEvents: next };
      });
    });
    return () => source.close();
  }, []);

  async function createEpic() {
    try {
      setSubmitting(true);
      await fetchJson("/api/epics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, goalText })
      });
      await refresh();
      setTitle("");
      setGoalText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const ticketsByEpic = useMemo(() => {
    const grouped = new Map<string, Ticket[]>();
    for (const ticket of data.tickets) {
      const arr = grouped.get(ticket.epicId) ?? [];
      arr.push(ticket);
      grouped.set(ticket.epicId, arr);
    }
    return grouped;
  }, [data.tickets]);

  const eventsByRole = useMemo(() => {
    const grouped = new Map<string, AgentEvent[]>();
    for (const item of data.agentEvents) {
      const role = item.payload?.agentRole || "unknown";
      const arr = grouped.get(role) ?? [];
      arr.push(item);
      grouped.set(role, arr);
    }
    return grouped;
  }, [data.agentEvents]);

  const agentRoles = [...eventsByRole.keys()];
  const activeItems = openRole ? (eventsByRole.get(openRole) ?? []) : [];

  const filteredTickets = selectedEpic
    ? data.tickets.filter((t) => t.epicId === selectedEpic)
    : data.tickets;

  const activeCount = data.tickets.filter((t) => t.status === "building" || t.status === "reviewing" || t.status === "testing").length;

  return (
    <div className="shell">
      {/* Hero / topbar */}
      <header className="topbar">
        <div className="topbar-actions">
          <button className="btn" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <label className="toggle">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh
          </label>
        </div>
        <p className="editorial-spacing eyebrow">LangGraph × OpenCode</p>
        <h1>Workflow Dashboard</h1>
        <p className="subtitle">Builder and epic reviewer stream live output into the UI while LangGraph keeps the workflow state and routing.</p>
      </header>

      {/* Stats row */}
      <div className="stats-row">
        <div className="stat-cell">
          <span className="editorial-spacing stat-label">Epics</span>
          <span className="stat-value">{data.epics.length}</span>
        </div>
        <div className="stat-cell">
          <span className="editorial-spacing stat-label">Tickets</span>
          <span className="stat-value">{data.tickets.length}</span>
        </div>
        <div className="stat-cell">
          <span className="editorial-spacing stat-label">Runs</span>
          <span className="stat-value">{data.runs.length}</span>
        </div>
        <div className="stat-cell">
          <span className="editorial-spacing stat-label">Active</span>
          <span className="stat-value">{activeCount}</span>
        </div>
      </div>

      {/* Main grid */}
      <div className="main-grid">
        {/* Left column */}
        <div className="left-col">
          {/* Create epic */}
          <section>
            <div className="section-head">
              <h2>New epic</h2>
            </div>
            <div className="create-form">
              <label>
                Title
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Epic title" />
              </label>
              <label>
                Goal
                <textarea value={goalText} onChange={(e) => setGoalText(e.target.value)} rows={4} placeholder="Describe the goal" />
              </label>
              <button className="btn btn-primary" onClick={() => void createEpic()} disabled={submitting || !title || !goalText}>
                {submitting ? "Queueing…" : "Create and queue"}
              </button>
              {error ? <p className="error-msg">{error}</p> : null}
            </div>
          </section>

          {/* Epics list */}
          <section>
            <div className="section-head">
              <h2>Epics</h2>
              <span className="editorial-spacing section-count">{data.epics.length} total</span>
            </div>
            <div className="epic-list">
              {data.epics.length ? data.epics.map((epic) => (
                <div
                  key={epic.id}
                  className="epic-item"
                  onClick={() => setSelectedEpic(selectedEpic === epic.id ? null : epic.id)}
                >
                  <div className="epic-top">
                    <div>
                      <span className="epic-id">{truncateId(epic.id)}</span>
                      <span className="epic-title">{epic.title}</span>
                    </div>
                    <span className={`pill pill-${epic.status}`}>{epic.status}</span>
                  </div>
                  <p className="epic-goal">{epic.goalText}</p>
                  <p className="epic-meta">Updated {formatTime(epic.updatedAt)}</p>
                </div>
              )) : <p className="epic-empty">Create your first epic to kick off the workflow.</p>}
            </div>
          </section>

          {/* Agent stream chips */}
          <section>
            <div className="section-head">
              <h3>Streaming agents</h3>
              <span className="editorial-spacing section-count">{agentRoles.length} active</span>
            </div>
            <div className="agent-chips">
              {agentRoles.map((role) => (
                <button key={role} className="agent-chip" onClick={() => setOpenRole(role)}>
                  {role}
                  <span className="agent-chip-count">{eventsByRole.get(role)?.length ?? 0}</span>
                </button>
              ))}
              {!agentRoles.length ? <p className="no-agents">No agent stream yet.</p> : null}
            </div>
          </section>
        </div>

        {/* Right column */}
        <div className="right-col">
          {/* Tickets */}
          <section>
            <div className="section-head">
              <h2>Tickets</h2>
              <span className="editorial-spacing section-count">{filteredTickets.length} shown</span>
              {selectedEpic && (
                <button className="section-action" onClick={() => setSelectedEpic(null)}>Show all</button>
              )}
            </div>
            <div className="ticket-list">
              {filteredTickets.length ? filteredTickets.map((ticket) => (
                <div className="ticket-item" key={ticket.id}>
                  <div className="ticket-top">
                    <div style={{ flex: 1 }}>
                      <div className="ticket-id-row">
                        <span className="ticket-id">{truncateId(ticket.id)}</span>
                        {ticket.priority && <span className={`priority-${ticket.priority}`}>{ticket.priority}</span>}
                      </div>
                      <p className="ticket-title">{ticket.title}</p>
                    </div>
                    <span className={`pill pill-${ticket.status}`}>{ticket.status}</span>
                  </div>
                  {ticket.lastMessage && (
                    <p className="ticket-last-msg">"{ticket.lastMessage}"</p>
                  )}
                  <div className="ticket-footer">
                    {ticket.dependencies.length > 0 && (
                      <span>
                        <span className="editorial-spacing">Depends </span>
                        {ticket.dependencies.map((d) => d.split("__").pop()).join(", ")}
                      </span>
                    )}
                    {ticket.currentNode && (
                      <span>
                        <span className="editorial-spacing">Node </span>
                        {ticket.currentNode}
                      </span>
                    )}
                    {(ticketsByEpic.get(ticket.epicId) ?? []).length > 0 && (
                      <span>
                        <span className="editorial-spacing">Epic </span>
                        {truncateId(ticket.epicId)}
                      </span>
                    )}
                  </div>
                </div>
              )) : (
                <p className="ticket-empty">{selectedEpic ? "No tickets for this epic yet." : "No tickets yet."}</p>
              )}
            </div>
          </section>

          {/* Recent runs */}
          <section>
            <div className="section-head">
              <h3>Recent runs</h3>
            </div>
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
              {!data.runs.length ? <p className="run-empty">No runs yet.</p> : null}
            </div>
          </section>

          {/* Live stream tail */}
          <section>
            <div className="section-head">
              <h3>Live stream tail</h3>
            </div>
            <div className="stream-tail">
              {data.agentEvents.length ? data.agentEvents.slice(-8).reverse().map((item) => (
                <div className="stream-item" key={item.id}>
                  <div className="stream-item-meta">
                    <span className={`pill pill-${item.payload?.streamKind || "raw"}`}>{item.payload?.agentRole || "unknown"}</span>
                    <span className="stream-item-time">{formatTime(item.created_at)}</span>
                  </div>
                  <pre>{item.payload?.content || item.message}</pre>
                </div>
              )) : <p className="stream-waiting">Waiting for agent output.</p>}
            </div>
          </section>
        </div>
      </div>

      {/* Footer */}
      <footer className="footer">
        <span className="footer-brand">LangGraph × OpenCode — Workflow Dashboard</span>
        <div className="footer-legend">
          <span className="legend-item"><span className="legend-dot legend-dot-executing" />executing</span>
          <span className="legend-item"><span className="legend-dot legend-dot-building" />building</span>
          <span className="legend-item"><span className="legend-dot legend-dot-queued" />queued</span>
          <span className="legend-item"><span className="legend-dot legend-dot-done" />done</span>
          <span className="legend-item"><span className="legend-dot legend-dot-failed" />failed</span>
        </div>
      </footer>

      <AgentModal role={openRole || "agent"} items={activeItems} open={Boolean(openRole)} onClose={() => setOpenRole(null)} />
    </div>
  );
}
