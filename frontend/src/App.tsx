import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import "./styles.css";

import {
  AgentEvent,
  AgentModelsConfig,
  AgentStreamStatus,
  Dashboard,
  Epic,
  Run,
  Ticket,
} from "./types";

import {
  AGENT_GLYPHS,
  LIVE_THRESHOLD_MS,
  RUNNING_THRESHOLD_MS,
  confirmToast,
  fetchJson,
  formatTime,
  isRunActiveForRole,
  normalizeAgentRole,
  normalizeTicketTitleKey,
  ticketStatusScore,
  truncateId,
} from "./utils";

import { AgentModal } from "./components/AgentModal";
import { EpicModal } from "./components/EpicModal";
import { PlanningModal } from "./components/PlanningModal";
import { TicketModal } from "./components/TicketModal";

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
    fetchJson<Record<string, unknown>>("/api/config")
      .then((cfg) => {
        if (typeof cfg.targetDir === "string") setTargetDir(cfg.targetDir);
        if (typeof cfg.currentBranch === "string" && cfg.currentBranch)
          setTargetBranch(cfg.currentBranch);
        if (cfg.models && typeof cfg.models === "object" && !Array.isArray(cfg.models)) {
          setModelsConfig(cfg.models as AgentModelsConfig);
        }
      })
      .catch(() => {});
    void refreshModels();
  }, []);

  async function refresh() {
    try {
      setLoading(true);
      const [epics, tickets, runs, fetchedAgentEvents] = await Promise.all([
        fetchJson<Epic[]>("/api/epics"),
        fetchJson<Ticket[]>("/api/tickets"),
        fetchJson<Run[]>("/api/runs"),
        fetchJson<AgentEvent[]>("/api/agent-events?limit=600"),
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

  useEffect(() => {
    void refresh();
  }, []);
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
    setCollapsedPanels((prev) => {
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
    const fromConfig =
      modelsConfig && typeof modelsConfig === "object" ? Object.keys(modelsConfig) : [];
    const fromEvents = [...eventsByRole.keys()];
    const all = new Set([...fromConfig, ...fromEvents]);
    return [...all].sort((a, b) => {
      const order = [
        "playWriter",
        "playTester",
        "epicDecoder",
        "builder",
        "reviewer",
        "tester",
        "epicReviewer",
        "doctor",
      ];
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [modelsConfig, eventsByRole]);

  const agentSections = useMemo(() => {
    const buildAgents = ["playWriter", "playTester"];
    const test = agentRoles.filter((r) => buildAgents.includes(r));
    const build = agentRoles.filter((r) => !buildAgents.includes(r));
    return { test, build };
  }, [agentRoles]);

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
        status.set(
          role,
          !latestTs || nowTick - latestTs <= RUNNING_THRESHOLD_MS ? "running" : "stalled"
        );
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

  const filteredTickets = useMemo(() => {
    let result = selectedEpic ? dedupedTickets.filter((t) => t.epicId === selectedEpic) : dedupedTickets;
    // When no epic is selected (default view), hide tickets where the epic is done
    if (!selectedEpic) {
      result = result.filter((ticket) => {
        const epic = data.epics.find((e) => e.id === ticket.epicId);
        return epic?.status !== "done";
      });
    }
    return result;
  }, [selectedEpic, dedupedTickets, data.epics]);

  const ticketsByEpic = useMemo(() => {
    const grouped = new Map<string, Ticket[]>();
    for (const ticket of dedupedTickets) {
      const arr = grouped.get(ticket.epicId) ?? [];
      arr.push(ticket);
      grouped.set(ticket.epicId, arr);
    }
    return grouped;
  }, [dedupedTickets]);

  const activeCount = dedupedTickets.filter(
    (t) => t.status === "building" || t.status === "reviewing" || t.status === "testing"
  ).length;

  async function createEpic() {
    if (epicMode === "plan") {
      try {
        setSubmitting(true);
        const result = await fetchJson<{ sessionId: string }>("/api/plan-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            epicTitle: title,
            epicDescription: goalText,
            targetDir,
            targetBranch: targetBranch || undefined,
          }),
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
        body: JSON.stringify({ title, goalText, targetDir, targetBranch: targetBranch || undefined }),
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
      confirmLabel: "Cancel Epic",
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
      confirmLabel: "Delete Epic",
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

  async function retryEpic(epicId: string) {
    const toastId = toast.loading("Re-queuing epic run...");
    try {
      setActionBusy(`retry-epic-${epicId}`);
      await fetchJson(`/api/epics/${encodeURIComponent(epicId)}/retry`, { method: "POST" });
      await refresh();
      toast.success("Epic re-queued.", { id: toastId });
    } catch (err) {
      toast.error(`Failed to retry epic: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function reviewEpic(epicId: string) {
    const epic = data.epics.find((e) => e.id === epicId);
    if (epic?.status === "done") {
      toast.info("Epic is already approved. Skipping review.");
      return;
    }

    const activeReviewRun = data.runs.find((run) => {
      if (run.epicId !== epicId) return false;
      if (run.status !== "queued" && run.status !== "running" && run.status !== "waiting")
        return false;
      const node = String(run.currentNode ?? "").toLowerCase();
      return node.includes("review");
    });
    if (activeReviewRun) {
      toast.info(`Review already in progress (${truncateId(activeReviewRun.id)}).`);
      return;
    }

    const confirmed = await confirmToast({
      title: "Run epic review now?",
      description:
        "This runs checks across approved tickets, then manually runs the epic reviewer.",
      confirmLabel: "Run Review",
    });
    if (!confirmed) return;
    const toastId = toast.loading("Queuing epic review...");
    try {
      setActionBusy(`review-epic-${epicId}`);
      const result = await fetchJson<{
        ok: boolean;
        runId?: string;
        skipped?: boolean;
        deduped?: boolean;
        message?: string;
      }>(`/api/epics/${encodeURIComponent(epicId)}/review`, { method: "POST" });
      await refresh();
      if (result.skipped) {
        toast.info(result.message || "Epic already approved. Skipping review.", { id: toastId });
      } else if (result.deduped) {
        toast.info(result.message || "Review already queued/running.", { id: toastId });
      } else {
        toast.success("Epic review queued.", { id: toastId });
      }
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to queue epic review: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function playLoopEpic(epicId: string) {
    const confirmed = await confirmToast({
      title: "Run play loop now?",
      description: "This runs Play Writer and Play Tester for the selected epic.",
      confirmLabel: "Run Play Loop",
    });
    if (!confirmed) return;
    const toastId = toast.loading("Queuing play loop...");
    try {
      setActionBusy(`play-loop-epic-${epicId}`);
      await fetchJson(`/api/epics/${encodeURIComponent(epicId)}/play-loop`, { method: "POST" });
      await refresh();
      toast.success("Play loop queued.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to queue play loop: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function cancelTicket(ticketId: string) {
    const confirmed = await confirmToast({
      title: "Cancel ticket?",
      description: "This interrupts the current ticket flow and marks it cancelled.",
      confirmLabel: "Cancel Ticket",
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
      confirmLabel: "Delete Ticket",
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
      confirmLabel: "Rerun Ticket",
    });
    if (!confirmed) return;
    const toastId = toast.loading("Queuing ticket rerun...");
    try {
      setActionBusy(`rerun-ticket-${ticketId}`);
      await fetchJson(`/api/tickets/${encodeURIComponent(ticketId)}/rerun`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cancelActive: true }),
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
      confirmLabel: "Force Rerun",
    });
    if (!confirmed) return;
    const toastId = toast.loading("Forcing in-place rerun...");
    try {
      setActionBusy(`force-rerun-ticket-${ticketId}`);
      await fetchJson(`/api/tickets/${encodeURIComponent(ticketId)}/force-rerun-in-place`, {
        method: "POST",
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
      description:
        "This manually requeues the current run if reviewer appears stalled for at least 60 seconds.",
      confirmLabel: "Force Rescue",
    });
    if (!confirmed) return;
    const toastId = toast.loading("Forcing reviewer rescue...");
    try {
      setActionBusy(`force-rescue-ticket-${ticketId}`);
      await fetchJson(`/api/tickets/${encodeURIComponent(ticketId)}/force-rescue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ minStaleMs: 60_000, requireReviewerNode: true }),
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
        body: JSON.stringify({ role, model }),
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
              <svg
                viewBox="0 0 20 20"
                xmlns="http://www.w3.org/2000/svg"
                shape-rendering="crispEdges"
                className="title-mascot"
              >
                <g className="m-ear-left">
                  <rect x="4" y="3" width="3" height="3" fill="#5D4037" />
                  <rect x="5" y="4" width="1" height="1" fill="#8D6E63" />
                </g>
                <g className="m-ear-right">
                  <rect x="13" y="3" width="3" height="3" fill="#5D4037" />
                  <rect x="14" y="4" width="1" height="1" fill="#8D6E63" />
                </g>
                <g className="m-breathing">
                  <g className="m-head">
                    <rect x="5" y="5" width="10" height="7" fill="#795548" />
                    <rect x="4" y="7" width="1" height="3" fill="#795548" />
                    <rect x="15" y="7" width="1" height="3" fill="#795548" />
                    <rect x="8" y="8" width="4" height="3" fill="#D7CCC8" />
                    <rect x="9" y="9" width="2" height="1" fill="#212121" />
                    <g className="m-eye m-eye-left">
                      <rect x="7" y="7" width="1" height="1" fill="#212121" />
                    </g>
                    <g className="m-eye m-eye-right">
                      <rect x="12" y="7" width="1" height="1" fill="#212121" />
                    </g>
                  </g>
                  <g className="m-torso">
                    <rect x="5" y="12" width="10" height="6" fill="#795548" />
                    <rect x="4" y="13" width="12" height="4" fill="#795548" />
                    <rect x="8" y="13" width="4" height="4" fill="#8D6E63" />
                  </g>
                  <g className="m-arm-left">
                    <rect x="2" y="12" width="3" height="3" fill="#795548" />
                  </g>
                  <g className="m-arm-right">
                    <rect x="15" y="12" width="3" height="3" fill="#795548" />
                  </g>
                </g>
                <g className="m-foot-left">
                  <rect x="5" y="18" width="3" height="2" fill="#5D4037" />
                </g>
                <g className="m-foot-right">
                  <rect x="12" y="18" width="3" height="2" fill="#5D4037" />
                </g>
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
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
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
            <span>
              All Agent Streams ({agentSections.test.length + agentSections.build.length})
            </span>
          </div>
          <div className="win-titlebar-buttons">
            <div className="win-btn-box" onClick={() => togglePanel("agents")}>
              _
            </div>
            <div className="win-btn-box">×</div>
          </div>
        </div>
        <div className={`win-content ${collapsedPanels.has("agents") ? "collapsed" : ""}`}>
          <div className="agent-sections-row">
            {/* BUILD Section */}
            <div className="agent-section-box build-section">
              <div className="agent-section-header">
                <span className="agent-section-icon">🔧</span>
                <span className="agent-section-title">BUILD</span>
              </div>
              <div className="agent-stats-grid">
                {agentSections.build.map((role) => (
                  <button key={role} className="agent-stat-box" onClick={() => setOpenRole(role)}>
                    <span className={`agent-stat-icon ${isAgentActive.get(role) ? "active" : ""}`}>
                      ◆
                    </span>
                    <span className="agent-stat-name">{role}</span>
                    <span
                      className={`agent-stat-status status-${
                        agentStatusByRole.get(role) || "idle"
                      }`}
                    >
                      {agentStatusByRole.get(role) || "idle"}
                    </span>
                    <span className="agent-stat-glyph">
                      {AGENT_GLYPHS[role] || AGENT_GLYPHS.unknown}
                    </span>
                    <span className="agent-stat-count">{eventsByRole.get(role)?.length ?? 0}</span>
                    <span className="agent-stat-label">msgs</span>
                  </button>
                ))}
              </div>
            </div>

            {/* TEST Section */}
            <div className="agent-section-box test-section">
              <div className="agent-section-header">
                <span className="agent-section-icon">🧪</span>
                <span className="agent-section-title">TEST</span>
              </div>
              <div className="agent-stats-grid">
                {agentSections.test.map((role) => (
                  <button key={role} className="agent-stat-box" onClick={() => setOpenRole(role)}>
                    <span className={`agent-stat-icon ${isAgentActive.get(role) ? "active" : ""}`}>
                      ◆
                    </span>
                    <span className="agent-stat-name">{role}</span>
                    <span
                      className={`agent-stat-status status-${
                        agentStatusByRole.get(role) || "idle"
                      }`}
                    >
                      {agentStatusByRole.get(role) || "idle"}
                    </span>
                    <span className="agent-stat-glyph">
                      {AGENT_GLYPHS[role] || AGENT_GLYPHS.unknown}
                    </span>
                    <span className="agent-stat-count">{eventsByRole.get(role)?.length ?? 0}</span>
                    <span className="agent-stat-label">msgs</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          {agentSections.test.length + agentSections.build.length === 0 && (
            <p className="no-agents">📭 No agent stream yet.</p>
          )}
        </div>
      </div>

      {/* Main Grid */}
      <div className="main-grid">
        {/* Mobile Stacked View */}
        <div className="mobile-stacked">
          {/* Epics */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📁</span>
                <span>Epics ({data.epics.length})</span>
                {selectedEpic && <span className="filter-badge">🔍 {truncateId(selectedEpic)}</span>}
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box" onClick={() => togglePanel("epics")}>
                  _
                </div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div
              className={`win-content win-inset ${collapsedPanels.has("epics") ? "collapsed" : ""}`}
            >
              <div className="epic-list">
                {data.epics.length ? (
                  data.epics.map((epic) => (
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
                          <button
                            className="mini-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              void playLoopEpic(epic.id);
                            }}
                            disabled={actionBusy !== null}
                          >
                            Play
                          </button>
                          <button
                            className="mini-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedEpicDetails(epic);
                            }}
                            disabled={actionBusy !== null}
                          >
                            View
                          </button>
                        </div>
                      </div>
                      <p className="epic-goal">
                        {epic.goalText.length > 100
                          ? epic.goalText.slice(0, 100) + "…"
                          : epic.goalText}
                      </p>
                      <p className="epic-meta">Updated: {formatTime(epic.updatedAt)}</p>
                    </div>
                  ))
                ) : (
                  <p className="epic-empty">📭 Create your first epic to kick off the workflow.</p>
                )}
              </div>
            </div>
          </div>

          {/* Tickets */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📋</span>
                <span>Tickets ({filteredTickets.length})</span>
                {selectedEpic && <span className="filter-badge">🔍 {truncateId(selectedEpic)}</span>}
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box" onClick={() => togglePanel("tickets")}>
                  _
                </div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div
              className={`win-content win-inset ${collapsedPanels.has("tickets") ? "collapsed" : ""}`}
            >
              <div className="ticket-list">
                {filteredTickets.length ? (
                  filteredTickets.map((ticket) => (
                    <div
                      className="ticket-item"
                      key={ticket.id}
                      onClick={() => setSelectedTicket(ticket)}
                    >
                      <div className="ticket-top">
                        <div style={{ flex: 1 }}>
                          <div className="ticket-id-row">
                            <span className="ticket-id">{truncateId(ticket.id)}</span>
                            {ticket.priority && (
                              <span className={`priority-${ticket.priority}`}>{ticket.priority}</span>
                            )}
                          </div>
                          <p className="ticket-title">{ticket.title}</p>
                        </div>
                        <div className="item-actions">
                          <span className={`pill pill-${ticket.status}`}>{ticket.status}</span>
                        </div>
                      </div>
                      {ticket.lastMessage && <p className="ticket-last-msg">"{ticket.lastMessage}"</p>}
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
                  ))
                ) : (
                  <p className="ticket-empty">
                    📭 {selectedEpic ? "No tickets for this epic yet." : "No tickets yet."}
                  </p>
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
                <div className="win-btn-box" onClick={() => togglePanel("runs")}>
                  _
                </div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div className={`win-content ${collapsedPanels.has("runs") ? "collapsed" : ""}`}>
              <div className="run-list">
                {data.runs.slice(0, 10).map((run) => (
                  <div className="run-row" key={run.id}>
                    <div>
                      <span className="run-kind">{run.kind}</span>
                      <span style={{ marginLeft: "0.5rem" }} className="run-id">
                        {truncateId(run.id)}
                      </span>
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

        {/* Desktop Left Column */}
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
                {data.agentEvents.length ? (
                  data.agentEvents.slice(-10).map((item) => (
                    <div className="preview-item" key={item.id}>
                      <span className="preview-role">{normalizeAgentRole(item.payload?.agentRole)}</span>
                      <span className="preview-msg">
                        {item.payload?.content || item.message || "..."}
                      </span>
                    </div>
                  ))
                ) : (
                  <span className="preview-empty">Waiting for agent output...</span>
                )}
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
                <div className="win-btn-box" onClick={() => togglePanel("newEpic")}>
                  _
                </div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div className={`win-content ${collapsedPanels.has("newEpic") ? "collapsed" : ""}`}>
              <div className="create-form">
                <label>
                  Title:
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Epic title"
                  />
                </label>
                <label>
                  Goal:
                  <textarea
                    value={goalText}
                    onChange={(e) => setGoalText(e.target.value)}
                    rows={4}
                    placeholder="Describe the goal"
                  />
                </label>
                <div className="target-dir-row">
                  <label className="target-dir-label">Mode:</label>
                  <select
                    className="mode-select"
                    value={epicMode}
                    onChange={(e) => setEpicMode(e.target.value as "build" | "plan")}
                  >
                    <option value="build">🚀 Build</option>
                    <option value="plan">📐 Plan</option>
                  </select>
                  {epicMode === "plan" && (
                    <span className="mode-hint">Explore &amp; plan before building</span>
                  )}
                </div>
                <div className="target-dir-row">
                  <label className="target-dir-label">Target Branch:</label>
                  <input
                    className="target-dir-input"
                    value={targetBranch}
                    onChange={(e) => setTargetBranch(e.target.value)}
                    placeholder="feature/my-branch (optional)"
                  />
                </div>
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
                          body: JSON.stringify({ targetDir }),
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
                <button
                  className="btn btn-primary"
                  onClick={() => void createEpic()}
                  disabled={submitting || !title || !goalText}
                >
                  {submitting ? "⏳..." : epicMode === "plan" ? "📐 Start Planning" : "🚀 Create and Queue"}
                </button>
                {error ? <p className="error-msg">⚠️ {error}</p> : null}
              </div>
            </div>
          </div>

          {/* Epics List Desktop */}
          <div className="win-panel desktop-only">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📁</span>
                <span>Epics ({data.epics.length})</span>
                {selectedEpic && <span className="filter-badge">🔍 {truncateId(selectedEpic)}</span>}
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box" onClick={() => togglePanel("epicsDesktop")}>
                  _
                </div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div
              className={`win-content win-inset ${
                collapsedPanels.has("epicsDesktop") ? "collapsed" : ""
              }`}
            >
              <div className="epic-list">
                {data.epics.length ? (
                  data.epics.map((epic) => (
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
                          <button
                            className="mini-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              void playLoopEpic(epic.id);
                            }}
                            disabled={actionBusy !== null}
                          >
                            Play
                          </button>
                          <button
                            className="mini-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedEpicDetails(epic);
                            }}
                            disabled={actionBusy !== null}
                          >
                            View
                          </button>
                        </div>
                      </div>
                      <p className="epic-goal">
                        {epic.goalText.length > 100
                          ? epic.goalText.slice(0, 100) + "…"
                          : epic.goalText}
                      </p>
                      <p className="epic-meta">Updated: {formatTime(epic.updatedAt)}</p>
                    </div>
                  ))
                ) : (
                  <p className="epic-empty">📭 Create your first epic to kick off the workflow.</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Desktop Right Column */}
        <div className="right-col desktop-only">
          {/* Tickets List Desktop */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📋</span>
                <span>Tickets ({filteredTickets.length})</span>
                {selectedEpic && <span className="filter-badge">🔍 {truncateId(selectedEpic)}</span>}
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box" onClick={() => togglePanel("ticketsDesktop")}>
                  _
                </div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div
              className={`win-content win-inset ${
                collapsedPanels.has("ticketsDesktop") ? "collapsed" : ""
              }`}
            >
              <div className="ticket-list">
                {filteredTickets.length ? (
                  filteredTickets.map((ticket) => (
                    <div
                      className="ticket-item"
                      key={ticket.id}
                      onClick={() => setSelectedTicket(ticket)}
                    >
                      <div className="ticket-top">
                        <div style={{ flex: 1 }}>
                          <div className="ticket-id-row">
                            <span className="ticket-id">{truncateId(ticket.id)}</span>
                            {ticket.priority && (
                              <span className={`priority-${ticket.priority}`}>{ticket.priority}</span>
                            )}
                          </div>
                          <p className="ticket-title">{ticket.title}</p>
                        </div>
                        <div className="item-actions">
                          <span className={`pill pill-${ticket.status}`}>{ticket.status}</span>
                        </div>
                      </div>
                      {ticket.lastMessage && <p className="ticket-last-msg">"{ticket.lastMessage}"</p>}
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
                  ))
                ) : (
                  <p className="ticket-empty">
                    📭 {selectedEpic ? "No tickets for this epic yet." : "No tickets yet."}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Recent Runs Desktop */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📺</span>
                <span>Recent Runs</span>
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box" onClick={() => togglePanel("runsDesktop")}>
                  _
                </div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div
              className={`win-content ${collapsedPanels.has("runsDesktop") ? "collapsed" : ""}`}
            >
              <div className="run-list">
                {data.runs.slice(0, 10).map((run) => (
                  <div className="run-row" key={run.id}>
                    <div>
                      <span className="run-kind">{run.kind}</span>
                      <span style={{ marginLeft: "0.5rem" }} className="run-id">
                        {truncateId(run.id)}
                      </span>
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

      {/* Modals */}
      {planSessionId && (
        <PlanningModal
          sessionId={planSessionId}
          epicTitle={title}
          initialBranch={targetBranch || undefined}
          open={true}
          onClose={() => setPlanSessionId(null)}
          onApproved={(epicId) => {
            setPlanSessionId(null);
            setTitle("");
            setGoalText("");
            setTargetBranch("");
            void refresh();
          }}
        />
      )}

      {openRole && (
        <AgentModal
          role={openRole}
          items={activeItems}
          open={true}
          onClose={() => setOpenRole(null)}
          modelInfo={modelsConfig[openRole]}
          onModelChange={(m) => void updateAgentModel(openRole, m)}
          status={agentStatusByRole.get(openRole)}
        />
      )}

      {selectedTicket && (
        <TicketModal
          ticket={selectedTicket}
          events={data.agentEvents}
          runs={data.runs}
          open={true}
          onClose={() => setSelectedTicket(null)}
          onCancel={() => void cancelTicket(selectedTicket.id)}
          onRerun={() => void rerunTicket(selectedTicket.id)}
          onForceRerunInPlace={() => void forceRerunTicketInPlace(selectedTicket.id)}
          onForceRescue={() => void forceRescueTicket(selectedTicket.id)}
          onDelete={() => void deleteTicket(selectedTicket.id)}
          actionBusy={actionBusy !== null}
        />
      )}

      {selectedEpicDetails && (
        <EpicModal
          epic={selectedEpicDetails}
          open={true}
          onClose={() => setSelectedEpicDetails(null)}
          onRetry={() => void retryEpic(selectedEpicDetails.id)}
          onReview={() => void reviewEpic(selectedEpicDetails.id)}
          onPlayLoop={() => void playLoopEpic(selectedEpicDetails.id)}
          onCancel={() => void cancelEpic(selectedEpicDetails.id)}
          onDelete={() => void deleteEpic(selectedEpicDetails.id)}
          actionBusy={actionBusy !== null}
          epicEvents={data.agentEvents.filter((e) => e.payload?.epicId === selectedEpicDetails.id)}
          epicTickets={data.tickets.filter((t) => t.epicId === selectedEpicDetails.id)}
        />
      )}
    </div>
  );
}
