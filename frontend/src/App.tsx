import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";
import "./styles.css";

import {
  AgentEvent,
  AgentModelsConfig,
  AgentStreamStatus,
  Dashboard,
  Epic,
  EpicMergeStatus,
  KnowledgePipelineConfig,
  KnowledgeStatusResponse,
  OllamaPsSnapshot,
  PlannerProfile,
  Run,
  Ticket,
} from "./types.ts";

import {
  AGENT_GLYPHS,
  LIVE_THRESHOLD_MS,
  RUNNING_THRESHOLD_MS,
  confirmToast,
  fetchJson,
  formatTime,
  isCompletedEvent,
  isRunActiveForRole,
  normalizeAgentRole,
  normalizeDisplayedTicketId,
  normalizeTicketTitleKey,
  ticketStatusScore,
  truncateId,
} from "./utils.ts";

import { AgentModal } from "./components/AgentModal.tsx";
import { EpicModal } from "./components/EpicModal.tsx";
import { PlanningModal } from "./components/PlanningModal.tsx";
import { TicketModal } from "./components/TicketModal.tsx";
import { DirectChatModal } from "./components/DirectChatModal.tsx";
import { GameModal } from "./components/GameModal.tsx";
import { OllamaPsPanel } from "./components/OllamaPsPanel.tsx";

const TICKET_MODAL_EVENT_LIMIT = 500;
const REMOTE_KNOWLEDGE_MODEL_OPTIONS = [
  { id: "zai:glm-5.1", label: "Z AI (glm-5.1)" },
  { id: "codex-cli", label: "Codex CLI" },
  { id: "anthropic-mediated:glm-4.7", label: "Anthropic-Mediated (glm-4.7)" },
  { id: "mediated:batiai/qwen3.6-27b:iq3", label: "Mediated (BatiAI Qwen3.6-27B iq3)" },
  { id: "mediated:qwen3.5:27b", label: "Mediated (qwen3.5:27b)" },
  { id: "qwen3.5:9b", label: "Ollama (qwen3.5:9b)" },
] as const;

export function App() {
  const [data, setData] = useState<Dashboard>({ epics: [], tickets: [], runs: [], agentEvents: [] });
  const [modelsConfig, setModelsConfig] = useState<AgentModelsConfig>({});
  const [knowledgeConfig, setKnowledgeConfig] = useState<KnowledgePipelineConfig | null>(null);
  const [knowledgeDraft, setKnowledgeDraft] = useState<KnowledgePipelineConfig | null>(null);
  const [knowledgeStatus, setKnowledgeStatus] = useState<KnowledgeStatusResponse | null>(null);
  const [ollamaPs, setOllamaPs] = useState<OllamaPsSnapshot>({ ok: false, status: "idle", models: [] });
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [remoteOverrideEnabled, setRemoteOverrideEnabled] = useState(false);
  const [title, setTitle] = useState("");
  const [goalText, setGoalText] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [targetDirEditing, setTargetDirEditing] = useState(false);
  const [targetBranch, setTargetBranch] = useState("");
  const [epicMode, setEpicMode] = useState<"build" | "plan">("build");
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState("");
  const [epicImages, setEpicImages] = useState<File[]>([]);
  const [schedulerDate, setSchedulerDate] = useState<string>("");
  const [planSessionId, setPlanSessionId] = useState<string | null>(null);
  const [planMinimized, setPlanMinimized] = useState(false);
  const [planReady, setPlanReady] = useState(false);
  const [planAwaitingClarification, setPlanAwaitingClarification] = useState(false);
  const [loading, setLoading] = useState(true);
  const [epicPage, setEpicPage] = useState(0);
  const [epicPageSize] = useState(5);
  const [epicTotal, setEpicTotal] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isTetrisOpen, setIsTetrisOpen] = useState(false);
  const [isPacmanOpen, setIsPacmanOpen] = useState(false);
  const [isTamagotchiOpen, setIsTamagotchiOpen] = useState(false);
  const [selectedEpic, setSelectedEpic] = useState<string | null>(null);
  const [selectedEpicDetails, setSelectedEpicDetails] = useState<Epic | null>(null);
  const [selectedEpicMergeStatus, setSelectedEpicMergeStatus] = useState<EpicMergeStatus | null>(null);
  const [selectedEpicMergeStatusLoading, setSelectedEpicMergeStatusLoading] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [selectedTicketEvents, setSelectedTicketEvents] = useState<AgentEvent[]>([]);
  const selectedTicketRef = useRef<Ticket | null>(null);
  const latestAgentEventIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refreshModels() {
    try {
      const models = await fetchJson<AgentModelsConfig>("/api/models");
      setModelsConfig(models);
    } catch {
      // Leave the last known model config in place if the models endpoint is unavailable.
    }
  }

  async function refreshWorkspaceConfig() {
    const cfg = await fetchJson<Record<string, unknown>>("/api/config");
    if (typeof cfg.targetDir === "string") setTargetDir(cfg.targetDir);
    if (typeof cfg.currentBranch === "string" && cfg.currentBranch) {
      setTargetBranch(cfg.currentBranch);
    }
    if (typeof cfg.remoteOverrideEnabled === "boolean") {
      setRemoteOverrideEnabled(cfg.remoteOverrideEnabled);
    }
    if (cfg.models && typeof cfg.models === "object" && !Array.isArray(cfg.models)) {
      setModelsConfig(cfg.models as AgentModelsConfig);
    }
    if (cfg.epicDecoderKnowledge && typeof cfg.epicDecoderKnowledge === "object" && !Array.isArray(cfg.epicDecoderKnowledge)) {
      const nextKnowledgeConfig = cfg.epicDecoderKnowledge as KnowledgePipelineConfig;
      setKnowledgeConfig(nextKnowledgeConfig);
      setKnowledgeDraft(nextKnowledgeConfig);
    }
  }

  async function refreshKnowledgeStatus() {
    try {
      const nextStatus = await fetchJson<KnowledgeStatusResponse>("/api/knowledge/status");
      setKnowledgeStatus(nextStatus);
    } catch {
      // Keep the previous snapshot visible if the endpoint is temporarily unavailable.
    }
  }

  useEffect(() => {
    refreshWorkspaceConfig().catch(() => {});
    void refreshModels();
    void refreshKnowledgeStatus();
  }, []);

  async function refresh() {
    try {
      setLoading(true);
      const [epicResult, tickets, runs, fetchedAgentEvents, ollamaSnapshot, nextKnowledgeStatus] = await Promise.all([
        fetchJson<{ epics: Epic[]; total: number }>("/api/epics?limit=" + epicPageSize + "&offset=" + (epicPage * epicPageSize)),
        fetchJson<Ticket[]>("/api/tickets"),
        fetchJson<Run[]>("/api/runs"),
        fetchJson<AgentEvent[]>("/api/agent-events?limit=600"),
        fetchJson<OllamaPsSnapshot>("/api/ollama/ps").catch((): OllamaPsSnapshot => ({
          ok: false,
          status: "error",
          models: [],
          error: "Failed to load Ollama process list.",
        })),
        fetchJson<KnowledgeStatusResponse>("/api/knowledge/status").catch(() => knowledgeStatus),
      ]);
      
      setEpicTotal(epicResult.total);
      setOllamaPs(ollamaSnapshot);
      if (nextKnowledgeStatus) setKnowledgeStatus(nextKnowledgeStatus);

      // Merge fetched events with any SSE-captured events to avoid losing recent ones
      setData((current) => {
        const merged = new Map<number, AgentEvent>();
        for (const e of fetchedAgentEvents) merged.set(e.id, e);
        for (const e of current.agentEvents) merged.set(e.id, e);
        const agentEvents = [...merged.values()].sort((a, b) => a.id - b.id).slice(-600);
        return { epics: epicResult.epics, tickets, runs, agentEvents };
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
  }, [epicPage]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, epicPage]);

  const [lastEventTime, setLastEventTime] = useState<Map<string, number>>(new Map());
  const [collapsedPanels, setCollapsedPanels] = useState<Set<string>>(new Set(["scheduler"]));
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

  const knowledgeDraftDirty = useMemo(() => {
    if (!knowledgeConfig || !knowledgeDraft) return false;
    return JSON.stringify(knowledgeConfig) !== JSON.stringify(knowledgeDraft);
  }, [knowledgeConfig, knowledgeDraft]);

  const decoderModelInfo = modelsConfig.epicDecoder;
  const hardenerModelInfo = modelsConfig.ticketHardener;
  const judgeModelInfo = modelsConfig.decompositionJudge;
  const repairModelInfo = modelsConfig.ticketRepair;

  const decoderEffectiveModel = decoderModelInfo?.effectiveModel ?? "unavailable";
  const hardenerModeLabel = knowledgeDraft?.enableModelBackedHardener
    ? knowledgeDraft?.strictModelPlanningStages ? "LLM strict" : "LLM preferred"
    : knowledgeDraft?.allowDeterministicPlanningFallback ? "deterministic fallback" : "disabled";
  const judgeModeLabel = knowledgeDraft?.enableModelBackedJudge
    ? knowledgeDraft?.strictModelPlanningStages ? "LLM strict" : "LLM preferred"
    : knowledgeDraft?.allowDeterministicPlanningFallback ? "deterministic fallback" : "disabled";
  const repairModeLabel = knowledgeDraft?.enableModelBackedRepair
    ? knowledgeDraft?.strictModelPlanningStages ? "LLM strict" : "LLM preferred"
    : knowledgeDraft?.allowDeterministicPlanningFallback ? "deterministic fallback" : "disabled";

  function updateKnowledgeDraft<K extends keyof KnowledgePipelineConfig>(key: K, value: KnowledgePipelineConfig[K]) {
    setKnowledgeDraft((current) => {
      if (!current) return current;
      return { ...current, [key]: value };
    });
  }

  function parsePositiveInt(value: string, fallback: number): number {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  async function saveKnowledgeConfig() {
    if (!knowledgeDraft) return;
    const toastId = toast.loading("Saving decoder operations...");
    try {
      await fetchJson("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ epicDecoderKnowledge: knowledgeDraft }),
      });
      await refreshWorkspaceConfig();
      await refreshKnowledgeStatus();
      toast.success("Decoder operations saved.", { id: toastId });
    } catch (err) {
      toast.error(`Failed to save decoder operations: ${(err as Error).message}`, { id: toastId });
    }
  }

  async function triggerKnowledgeRefresh(force = false) {
    const toastId = toast.loading("Queueing knowledge refresh...");
    try {
      const response = await fetchJson<{ skipped?: boolean; queued?: boolean; reason?: string }>("/api/knowledge/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      await refreshKnowledgeStatus();
      if (response.skipped) {
        toast.success("Knowledge refresh already queued.", { id: toastId });
      } else {
        toast.success("Knowledge refresh queued.", { id: toastId });
      }
    } catch (err) {
      toast.error(`Failed to queue knowledge refresh: ${(err as Error).message}`, { id: toastId });
    }
  }

  function plannerTargetTokens(profile: PlannerProfile | undefined, config: KnowledgePipelineConfig | null): number | null {
    if (!profile || !config) return null;
    if (profile === "small-local") return config.smallLocalPlannerTargetTokens;
    if (profile === "medium-local") return config.mediumLocalPlannerTargetTokens;
    return config.remoteStrongPlannerTargetTokens;
  }

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

  // Keep selectedTicket synced with latest ticket data (e.g., new currentRunId after retry)
  useEffect(() => {
    if (!selectedTicket) return;
    const fresh = data.tickets.find(t => t.id === selectedTicket.id);
    if (fresh && (
      fresh.status !== selectedTicket.status
      || fresh.currentRunId !== selectedTicket.currentRunId
      || fresh.updatedAt !== selectedTicket.updatedAt
    )) {
      setSelectedTicket(fresh);
    }
  }, [data.tickets]);

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
        if (row.ticket_id !== selected.id && row.run_id !== selected.currentRunId) return current;
        const next = [...current, row];
        const deduped = Array.from(new Map(next.map((item) => [item.id, item])).values());
        return deduped.slice(-TICKET_MODAL_EVENT_LIMIT);
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
    const params = new URLSearchParams({ limit: String(TICKET_MODAL_EVENT_LIMIT) });
    if (selectedTicket.currentRunId) {
      params.set("runId", selectedTicket.currentRunId);
    }

    void fetchJson<AgentEvent[]>(`/api/tickets/${encodeURIComponent(selectedTicket.id)}/events?${params.toString()}`)
      .then((events) => {
        if (!cancelled) setSelectedTicketEvents(events);
      })
      .catch(() => {
        if (!cancelled) setSelectedTicketEvents([]);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedTicket?.id, selectedTicket?.currentRunId]);

  useEffect(() => {
    if (!selectedEpicDetails) {
      setSelectedEpicMergeStatus(null);
      setSelectedEpicMergeStatusLoading(false);
      return;
    }
    let cancelled = false;
    setSelectedEpicMergeStatusLoading(true);
    void fetchJson<EpicMergeStatus>(`/api/epics/${encodeURIComponent(selectedEpicDetails.id)}/merge-status`)
      .then((status) => {
        if (!cancelled) setSelectedEpicMergeStatus(status);
      })
      .catch(() => {
        if (!cancelled) setSelectedEpicMergeStatus(null);
      })
      .finally(() => {
        if (!cancelled) setSelectedEpicMergeStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEpicDetails?.id, selectedEpicDetails?.updatedAt]);

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
        "system",
        "playWriter",
        "playTester",
        "epicDecoder",
        "ticketHardener",
        "decompositionJudge",
        "ticketRepair",
        "explorer",
        "coder",
        "reviewer",
        "epicReviewer",
        "doctor",
        "builder",
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

  const agentStreamCards = useMemo(
    () => [
      ...agentSections.build.map((role) => ({ role, lane: "build" as const })),
      ...agentSections.test.map((role) => ({ role, lane: "test" as const })),
    ],
    [agentSections],
  );

  const knowledgeRefreshEvents = useMemo(
    () =>
      [...data.agentEvents]
        .filter((event) => Boolean(event.payload?.metadata?.knowledgeRefresh))
        .slice(-20)
        .reverse(),
    [data.agentEvents],
  );

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

  const activeItems = useMemo(
    () => (openRole ? [...(eventsByRole.get(openRole) ?? [])].reverse() : []),
    [openRole, eventsByRole]
  );

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

  function localDate(d: Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  const scheduledEpics = useMemo(
    () => data.epics.filter((e) => e.scheduledDate).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!)),
    [data.epics],
  );

  const displayEpics = useMemo(() => {
    if (!schedulerDate) return data.epics;
    return data.epics.filter((e) => e.scheduledDate === schedulerDate);
  }, [data.epics, schedulerDate]);

  const displayScheduledEpics = useMemo(() => {
    if (schedulerDate) return scheduledEpics.filter((e) => e.scheduledDate === schedulerDate);
    return scheduledEpics;
  }, [scheduledEpics, schedulerDate]);

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
      if (epicImages.length > 0 || isScheduled) {
        const form = new FormData();
        form.append("title", title);
        form.append("goalText", goalText);
        form.append("targetDir", targetDir);
        if (targetBranch) form.append("targetBranch", targetBranch);
        if (isScheduled && scheduledDate) form.append("scheduledDate", scheduledDate);
        for (const f of epicImages) form.append("images", f);
        await fetchJson("/api/epics", { method: "POST", body: form });
      } else {
        await fetchJson("/api/epics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, goalText, targetDir, targetBranch: targetBranch || undefined }),
        });
      }
      await refresh();
      setTitle("");
      setGoalText("");
      setTargetBranch("");
      setIsScheduled(false);
      setScheduledDate("");
      setEpicImages([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
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

  async function markEpicDone(id: string) {
    if (actionBusy) return;
    const toastId = toast.loading("Marking epic as done...");
    try {
      setActionBusy(`mark-done-epic-${id}`);
      const res = await fetch(`/api/epics/${encodeURIComponent(id)}/done`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to mark epic as done");
      toast.success("Epic marked as done.", { id: toastId });
      void refresh();
    } catch (err) {
      toast.error(`Error: ${(err as Error).message}`, { id: toastId });
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

  async function redecodeEpic(epicId: string) {
    const confirmed = await confirmToast({
      title: "Re-decode epic?",
      description: "This clears the epic's current tickets and runs, then queues a fresh decoder pass.",
      confirmLabel: "Re-decode Epic",
    });
    if (!confirmed) return;

    const toastId = toast.loading("Re-decoding epic...");
    try {
      setActionBusy(`redecode-epic-${epicId}`);
      await fetchJson(`/api/epics/${encodeURIComponent(epicId)}/redecode`, { method: "POST" });
      await refresh();
      toast.success("Epic queued for a fresh decode.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to re-decode epic: ${(err as Error).message}`, { id: toastId });
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

  async function pauseEpic(epicId: string) {
    const toastId = toast.loading("Pausing epic...");
    try {
      setActionBusy(`pause-epic-${epicId}`);
      await fetchJson(`/api/epics/${encodeURIComponent(epicId)}/pause`, { method: "POST" });
      await refresh();
      toast.success("Epic paused.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to pause epic: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function resumeEpic(epicId: string) {
    const toastId = toast.loading("Resuming epic...");
    try {
      setActionBusy(`resume-epic-${epicId}`);
      await fetchJson(`/api/epics/${encodeURIComponent(epicId)}/resume`, { method: "POST" });
      await refresh();
      toast.success("Epic resumed.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to resume epic: ${(err as Error).message}`, { id: toastId });
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

  async function rerunDirectTicket(ticketId: string) {
    const confirmed = await confirmToast({
      title: "Skip explorer and rerun?",
      description: "This queues a new run that skips the explorer and goes directly to coding, using previous analysis or ticket allowedPaths.",
      confirmLabel: "Skip Explorer & Rerun",
    });
    if (!confirmed) return;
    const toastId = toast.loading("Queuing direct rerun (skip explorer)...");
    try {
      setActionBusy(`rerun-direct-ticket-${ticketId}`);
      await fetchJson(`/api/tickets/${encodeURIComponent(ticketId)}/rerun-direct`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cancelActive: true }),
      });
      await refresh();
      toast.success("Direct rerun queued (skip explorer).", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to direct rerun: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function updateTicketDetails(ticketId: string, input: {
    title: string;
    description: string;
    acceptanceCriteria: string[];
    dependencies: string[];
    allowedPaths: string[];
    priority: string;
  }) {
    if (actionBusy) return;
    const toastId = toast.loading("Saving ticket changes...");
    try {
      setActionBusy(ticketId);
      const updated = await fetchJson<Ticket>(`/api/tickets/${encodeURIComponent(ticketId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      setData((current) => ({
        ...current,
        tickets: current.tickets.map((ticket) => (ticket.id === updated.id ? updated : ticket)),
      }));
      setSelectedTicket(updated);
      toast.success("Ticket updated.", { id: toastId });
    } catch (err) {
      setError((err as Error).message);
      toast.error(`Failed to update ticket: ${(err as Error).message}`, { id: toastId });
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

  function renderDecoderModelField(
    role: string,
    label: string,
    info: AgentModelsConfig[string] | undefined,
    note: string,
  ) {
    const adapters = info?.adapters ?? [];
    return (
      <label className="decoder-op-field">
        <span>{label}</span>
        <select
          value={info?.currentModel ?? ""}
          onChange={(e) => void updateAgentModel(role, e.target.value)}
          disabled={!info?.switchable || adapters.length === 0}
        >
          {adapters.length === 0 ? (
            <option value="">No adapters</option>
          ) : (
            adapters.map((adapter) => (
              <option key={adapter.id} value={adapter.id}>
                {adapter.label}
              </option>
            ))
          )}
        </select>
        <span className="decoder-op-subtle">
          Effective: <code>{info?.effectiveModel ?? "unavailable"}</code>
        </span>
        <span className="decoder-op-subtle">{note}</span>
      </label>
    );
  }

  async function mergeEpicToMain(epicId: string) {
    const confirmed = await confirmToast({
      title: "Merge epic to main?",
      description: "This will merge the epic branch into local main if the repo is clean and conflict-free.",
      confirmLabel: "Merge to Main",
    });
    if (!confirmed) return;
    const toastId = toast.loading("Merging epic branch into main...");
    try {
      setActionBusy(`merge-epic-${epicId}`);
      const result = await fetchJson<{ ok: true; sourceBranch: string; targetBranch: string; mergedCommit: string }>(
        `/api/epics/${encodeURIComponent(epicId)}/merge-main`,
        { method: "POST" }
      );
      toast.success(`Merged ${result.sourceBranch} into ${result.targetBranch}.`, { id: toastId });
      if (selectedEpicDetails?.id === epicId) {
        const status = await fetchJson<EpicMergeStatus>(`/api/epics/${encodeURIComponent(epicId)}/merge-status`);
        setSelectedEpicMergeStatus(status);
      }
      await refresh();
    } catch (err) {
      toast.error(`Failed to merge epic: ${(err as Error).message}`, { id: toastId });
    } finally {
      setActionBusy(null);
    }
  }

  async function updateRemoteOverride(next: boolean) {
    const toastId = toast.loading(next ? "Enabling Remote Override..." : "Disabling Remote Override...");
    try {
      const response = await fetchJson<{ remoteOverrideEnabled?: boolean }>("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remoteOverrideEnabled: next }),
      });
      if (typeof response.remoteOverrideEnabled === "boolean") {
        setRemoteOverrideEnabled(response.remoteOverrideEnabled);
      } else {
        setRemoteOverrideEnabled(next);
      }
      await refreshWorkspaceConfig();
      await refreshKnowledgeStatus();
      toast.success(next ? "Remote Override enabled." : "Remote Override disabled.", { id: toastId });
      void refreshModels();
    } catch (err) {
      toast.error(`Failed to update Remote Override: ${(err as Error).message}`, { id: toastId });
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
            <button className="btn" onClick={() => setIsTetrisOpen(true)}>
              🎮 Tetris
            </button>
            <button className="btn" onClick={() => setIsPacmanOpen(true)}>
              🕹️ Pac-Man
            </button>
            <button className="btn" onClick={() => setIsTamagotchiOpen(true)}>
              🐾 Tamagotchi
            </button>
            <button className="btn" onClick={() => setIsChatOpen(true)}>
              💬 Direct Chat
            </button>
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
            <label className="toggle">
              <input
                type="checkbox"
                checked={remoteOverrideEnabled}
                onChange={(e) => void updateRemoteOverride(e.target.checked)}
              />
              Remote Override
            </label>
          </div>
        </div>
      </div>

      <div className="win-panel decoder-ops-panel">
        <div className="win-titlebar">
          <div className="win-titlebar-text">
            <span>⚙️</span>
            <span>Decoder Ops</span>
            {knowledgeStatus && (
              <span className={`filter-badge knowledge-badge state-${knowledgeStatus.freshness.state}`}>
                {knowledgeStatus.freshness.state}
              </span>
            )}
          </div>
          <div className="win-titlebar-buttons">
            <div className="win-btn-box" onClick={() => togglePanel("decoderOps")}>
              _
            </div>
            <div className="win-btn-box">×</div>
          </div>
        </div>
        <div className={`win-content ${collapsedPanels.has("decoderOps") ? "collapsed" : ""}`}>
          <div className="decoder-ops-grid">
            <div className="decoder-op-card win-inset">
              <div className="decoder-op-heading">
                <span>Model Routing</span>
                {remoteOverrideEnabled && <span className="decoder-op-chip">Remote Override</span>}
              </div>
              <div className="decoder-op-form">
                {renderDecoderModelField(
                  "epicDecoder",
                  "Epic decoder",
                  decoderModelInfo,
                  "Primary draft planner for the staged epic decomposition.",
                )}
                {renderDecoderModelField(
                  "ticketHardener",
                  "Ticket hardener",
                  hardenerModelInfo,
                  "Compact rewrite pass for turning draft tickets into stricter builder-ready tasks.",
                )}
                {renderDecoderModelField(
                  "decompositionJudge",
                  "Decomposition judge",
                  judgeModelInfo,
                  "Focused evaluation pass that approves or rejects hardened tickets before builders see them.",
                )}
                {renderDecoderModelField(
                  "ticketRepair",
                  "Ticket repair",
                  repairModelInfo,
                  "Single bounded rewrite/split pass used only when the judge rejects tickets.",
                )}
              </div>
              <div className="decoder-op-kv">
                <span>Refresh agent</span>
                <code>{knowledgeDraft?.remoteKnowledgeModel ?? "zai:glm-5.1"}</code>
              </div>
              <div className="decoder-op-kv">
                <span>Hardener mode</span>
                <code>{hardenerModeLabel}</code>
              </div>
              <div className="decoder-op-kv">
                <span>Judge mode</span>
                <code>{judgeModeLabel}</code>
              </div>
              <div className="decoder-op-kv">
                <span>Repair mode</span>
                <code>{repairModeLabel}</code>
              </div>
              <p className="decoder-op-note">
                Decoder, hardener, judge, and repair are model-backed planning stages now. Deterministic code still runs after them as schema validation, readiness scoring, and final safety gates.
              </p>
              <p className="decoder-op-note">
                {remoteOverrideEnabled
                  ? "Remote Override only takes over planning when cached knowledge is missing or critically stale. With valid knowledge, the local planning stages stay on their configured models."
                  : "With valid cached knowledge, planning stays local-first. Missing or critically stale knowledge will not silently invent repo context."}
              </p>
            </div>

            <div className="decoder-op-card win-inset">
              <div className="decoder-op-heading">
                <span>Pipeline Controls</span>
                {knowledgeDraftDirty && <span className="decoder-op-chip dirty">unsaved</span>}
              </div>
              <div className="decoder-op-form">
                <label className="decoder-op-field">
                  <span>Planner profile</span>
                  <select
                    value={knowledgeDraft?.plannerProfile ?? "small-local"}
                    onChange={(e) => updateKnowledgeDraft("plannerProfile", e.target.value as PlannerProfile)}
                  >
                    <option value="small-local">small-local</option>
                    <option value="medium-local">medium-local</option>
                    <option value="remote-strong">remote-strong</option>
                  </select>
                </label>
                <label className="decoder-op-field">
                  <span>Remote knowledge model</span>
                  <select
                    value={knowledgeDraft?.remoteKnowledgeModel ?? ""}
                    onChange={(e) => updateKnowledgeDraft("remoteKnowledgeModel", e.target.value)}
                  >
                    {REMOTE_KNOWLEDGE_MODEL_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="decoder-op-field">
                  <span>Approved epic refresh interval</span>
                  <input
                    type="number"
                    min={1}
                    value={knowledgeDraft?.approvedEpicRefreshInterval ?? 10}
                    onChange={(e) =>
                      updateKnowledgeDraft(
                        "approvedEpicRefreshInterval",
                        parsePositiveInt(e.target.value, knowledgeDraft?.approvedEpicRefreshInterval ?? 10),
                      )
                    }
                  />
                </label>
                <label className="decoder-op-field">
                  <span>Context budget (tokens)</span>
                  <input
                    type="number"
                    min={1000}
                    value={knowledgeDraft?.maxSelectedKnowledgeTokens ?? 6000}
                    onChange={(e) =>
                      updateKnowledgeDraft(
                        "maxSelectedKnowledgeTokens",
                        parsePositiveInt(e.target.value, knowledgeDraft?.maxSelectedKnowledgeTokens ?? 6000),
                      )
                    }
                  />
                </label>
              </div>
              <div className="decoder-op-toggle-grid">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft?.enableKnowledgePipeline ?? true}
                    onChange={(e) => updateKnowledgeDraft("enableKnowledgePipeline", e.target.checked)}
                  />
                  Knowledge pipeline
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft?.enableModelBackedHardener ?? true}
                    onChange={(e) => updateKnowledgeDraft("enableModelBackedHardener", e.target.checked)}
                  />
                  Model-backed hardener
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft?.enableModelBackedJudge ?? true}
                    onChange={(e) => updateKnowledgeDraft("enableModelBackedJudge", e.target.checked)}
                  />
                  Model-backed judge
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft?.enableModelBackedRepair ?? true}
                    onChange={(e) => updateKnowledgeDraft("enableModelBackedRepair", e.target.checked)}
                  />
                  Model-backed repair
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft?.enableRemoteKnowledgeRefresh ?? true}
                    onChange={(e) => updateKnowledgeDraft("enableRemoteKnowledgeRefresh", e.target.checked)}
                  />
                  Async refresh jobs
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft?.requireFreshKnowledgeForLargeEpics ?? false}
                    onChange={(e) => updateKnowledgeDraft("requireFreshKnowledgeForLargeEpics", e.target.checked)}
                  />
                  Fresh knowledge for large epics
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft?.strictModelPlanningStages ?? true}
                    onChange={(e) => updateKnowledgeDraft("strictModelPlanningStages", e.target.checked)}
                  />
                  Strict LLM stages
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft?.remoteOverrideForMissingKnowledge ?? true}
                    onChange={(e) => updateKnowledgeDraft("remoteOverrideForMissingKnowledge", e.target.checked)}
                  />
                  Remote fallback for missing knowledge
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft?.allowDeterministicPlanningFallback ?? false}
                    onChange={(e) => updateKnowledgeDraft("allowDeterministicPlanningFallback", e.target.checked)}
                  />
                  Allow deterministic fallback
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft?.allowRawRepoContext ?? false}
                    onChange={(e) => updateKnowledgeDraft("allowRawRepoContext", e.target.checked)}
                  />
                  Allow raw repo context
                </label>
              </div>
              <div className="decoder-op-actions">
                <button className="btn" onClick={() => void saveKnowledgeConfig()} disabled={!knowledgeDraftDirty}>
                  Save Decoder Ops
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    if (knowledgeConfig) setKnowledgeDraft(knowledgeConfig);
                  }}
                  disabled={!knowledgeDraftDirty}
                >
                  Reset Draft
                </button>
              </div>
            </div>

            <div className="decoder-op-card win-inset">
              <div className="decoder-op-heading">
                <span>Knowledge Status</span>
                <span className={`decoder-op-chip state-${knowledgeStatus?.freshness.state ?? "missing"}`}>
                  {knowledgeStatus?.refreshState?.refreshStatus ?? "idle"}
                </span>
              </div>
              <div className="decoder-op-kv">
                <span>Snapshot</span>
                <code>{knowledgeStatus?.status.version ?? "none"}</code>
              </div>
              <div className="decoder-op-kv">
                <span>Availability</span>
                <code>{knowledgeStatus?.status.available ? "available" : "missing"}</code>
              </div>
              <div className="decoder-op-kv">
                <span>Freshness</span>
                <code>{knowledgeStatus?.freshness.state ?? "unknown"}</code>
              </div>
              <div className="decoder-op-kv">
                <span>Approved epics since refresh</span>
                <code>{knowledgeStatus?.refreshState?.approvedEpicsSinceKnowledgeRefresh ?? knowledgeStatus?.freshness.approvedEpicsSinceRefresh ?? 0}</code>
              </div>
              <div className="decoder-op-kv">
                <span>Planner target</span>
                <code>{plannerTargetTokens(knowledgeDraft?.plannerProfile, knowledgeDraft) ?? "n/a"} tokens</code>
              </div>
              {knowledgeStatus?.freshness.reasonCodes?.length ? (
                <div className="decoder-op-list">
                  {knowledgeStatus.freshness.reasonCodes.slice(0, 4).map((reason) => (
                    <span key={reason} className="decoder-op-list-item">
                      {reason}
                    </span>
                  ))}
                </div>
              ) : null}
              {knowledgeStatus?.status.warnings?.length ? (
                <p className="decoder-op-warning">{knowledgeStatus.status.warnings[0]}</p>
              ) : null}
              <div className="decoder-op-actions">
                <button className="btn" onClick={() => void triggerKnowledgeRefresh(false)}>
                  Queue Refresh
                </button>
                <button className="btn" onClick={() => void triggerKnowledgeRefresh(true)}>
                  Force Refresh
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="win-panel">
        <div className="win-titlebar">
          <div className="win-titlebar-text">
            <span>📡</span>
            <span>Knowledge Refresh Stream</span>
            <span className="win-titlebar-count">{knowledgeRefreshEvents.length}</span>
          </div>
          <div className="win-titlebar-buttons">
            <div className="win-btn-box" onClick={() => togglePanel("knowledgeRefreshStream")}>
              _
            </div>
            <div className="win-btn-box">×</div>
          </div>
        </div>
        <div className={`win-content ${collapsedPanels.has("knowledgeRefreshStream") ? "collapsed" : ""}`}>
          <div className="preview-content">
            {knowledgeRefreshEvents.length ? (
              knowledgeRefreshEvents.map((item) => {
                const role = normalizeAgentRole(item.payload?.agentRole);
                const source = item.payload?.source ?? "unknown";
                const model = typeof item.payload?.metadata?.model === "string"
                  ? item.payload?.metadata?.model
                  : typeof item.payload?.metadata?.remoteKnowledgeModel === "string"
                    ? item.payload?.metadata?.remoteKnowledgeModel
                    : null;
                return (
                  <div className="preview-item" key={item.id}>
                    <span className="preview-role">
                      {role}
                      {source ? ` · ${source}` : ""}
                      {model ? ` · ${model}` : ""}
                    </span>
                    <span className="preview-msg">
                      {item.payload?.content || item.message || "..."}
                    </span>
                  </div>
                );
              })
            ) : (
              <span className="preview-empty">No knowledge refresh stream yet.</span>
            )}
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
          <div className="agent-streams-summary">
            <span className="agent-streams-pill build">BUILD {agentSections.build.length}</span>
            <span className="agent-streams-pill test">TEST {agentSections.test.length}</span>
          </div>
          <div className="agent-streams-grid">
            {agentStreamCards.map(({ role, lane }) => (
              <button
                key={role}
                className={`agent-stream-row ${lane}`}
                onClick={() => setOpenRole(role)}
              >
                <span className={`agent-stream-lane ${lane}`}>{lane}</span>
                <span className={`agent-stat-icon ${isAgentActive.get(role) ? "active" : ""}`}>
                  ◆
                </span>
                <div className="agent-stream-main">
                  <span className="agent-stat-name">{role}</span>
                  <span
                    className={`agent-stat-status status-${
                      agentStatusByRole.get(role) || "idle"
                    }`}
                  >
                    {agentStatusByRole.get(role) || "idle"}
                  </span>
                </div>
                <span className="agent-stat-glyph">
                  {AGENT_GLYPHS[role] || AGENT_GLYPHS.unknown}
                </span>
                <div className="agent-stream-count">
                  <span className="agent-stat-count">{eventsByRole.get(role)?.length ?? 0}</span>
                  <span className="agent-stat-label">msgs</span>
                </div>
              </button>
            ))}
          </div>
          {agentStreamCards.length === 0 && (
            <p className="no-agents">📭 No agent stream yet.</p>
          )}
        </div>
      </div>

      {/* Main Grid */}
      <div className="main-grid">
        {/* Mobile Stacked View */}
        <div className="mobile-stacked">
          <OllamaPsPanel snapshot={ollamaPs} />

          {/* Epics */}
          <div className="win-panel">
            <div className="win-titlebar">
              <div className="win-titlebar-text">
                <span>📁</span>
                <span>Epics ({displayEpics.length})</span>
                {selectedEpic && <span className="filter-badge">🔍 {truncateId(selectedEpic)}</span>}
                {schedulerDate && <span className="filter-badge">📅 {schedulerDate}</span>}
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
              <div className="pagination-bar">
                <button
                  className="mini-btn" 
                  disabled={epicPage === 0} 
                  onClick={() => setEpicPage(p => p - 1)}
                >
                  &lt; Prev
                </button>
                <span className="pagination-info">
                  Page {epicPage + 1} of {Math.ceil(epicTotal / epicPageSize) || 1}
                </span>
                <button 
                  className="mini-btn" 
                  disabled={(epicPage + 1) * epicPageSize >= epicTotal} 
                  onClick={() => setEpicPage(p => p + 1)}
                >
                  Next &gt;
                </button>
              </div>
              <div className="epic-list">
                {displayEpics.length ? (
                  displayEpics.map((epic) => (
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
                          {epic.status === "paused" ? (
                            <button
                              className="mini-btn"
                              onClick={(e) => { e.stopPropagation(); void resumeEpic(epic.id); }}
                              disabled={actionBusy !== null}
                              title="Resume epic"
                            >
                              ▶
                            </button>
                          ) : ["executing", "planning", "reviewing"].includes(epic.status) ? (
                            <button
                              className="mini-btn"
                              onClick={(e) => { e.stopPropagation(); void pauseEpic(epic.id); }}
                              disabled={actionBusy !== null}
                              title="Pause epic"
                            >
                              ⏸
                            </button>
                          ) : null}
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
                            <span className="ticket-id">{truncateId(normalizeDisplayedTicketId(ticket.id))}</span>
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
          <OllamaPsPanel snapshot={ollamaPs} />
          {/* Legacy Mission Status (hidden) */}
          <div className="win-panel mission-status-panel">
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

          {/* Scheduler */}
          <div className="win-panel">
            <div className="win-titlebar win-titlebar-blue">
              <div className="win-titlebar-text">
                <span>📅</span>
                <span>Scheduler</span>
                {scheduledEpics.length > 0 && <span className="win-titlebar-count">{scheduledEpics.length}</span>}
              </div>
              <div className="win-titlebar-buttons">
                <div className="win-btn-box" onClick={() => togglePanel("scheduler")}>_</div>
                <div className="win-btn-box">×</div>
              </div>
            </div>
            <div className={`win-content ${collapsedPanels.has("scheduler") ? "collapsed" : ""}`}>
              <div className="scheduler-content">
                <Calendar
                  calendarType="gregory"
                  value={schedulerDate ? new Date(schedulerDate + "T00:00:00") : null}
                  onClickDay={(date) => {
                    const iso = localDate(date);
                    setSchedulerDate(schedulerDate === iso ? "" : iso);
                  }}
                  tileContent={({ date, view }) => {
                    if (view !== "month") return null;
                    const iso = localDate(date);
                    const dayEpics = scheduledEpics.filter(e => e.scheduledDate === iso);
                    if (dayEpics.length === 0) return null;
                    return (
                      <div className="scheduler-tile-dots">
                        {dayEpics.slice(0, 3).map((_, i) => (
                          <span key={i} className="scheduler-tile-dot" />
                        ))}
                      </div>
                    );
                  }}
                />
                <div className="scheduler-events-label">Events</div>
                <div className="scheduler-events">
                  {displayScheduledEpics.length === 0 ? (
                    <div className="scheduler-empty">No scheduled epics</div>
                  ) : (
                    displayScheduledEpics.map((epic) => (
                      <div
                        key={epic.id}
                        className="scheduler-event"
                        onClick={() => setSelectedEpic(epic.id)}
                      >
                        <span className="scheduler-event-date">{epic.scheduledDate}</span>
                        <span className="scheduler-event-title">{epic.title}</span>
                        <span className={`pill pill-${epic.status}`}>{epic.status}</span>
                      </div>
                    ))
                  )}
                </div>
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
                <div className="target-dir-row">
                  <label className="scheduler-checkbox">
                    <input
                      type="checkbox"
                      checked={isScheduled}
                      onChange={(e) => setIsScheduled(e.target.checked)}
                    />
                    <span>Scheduled</span>
                  </label>
                  {isScheduled && (
                    <input
                      type="date"
                      className="date-input"
                      value={scheduledDate}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setScheduledDate(e.target.value)}
                    />
                  )}
                </div>
                <div className="target-dir-row">
                  <label className="target-dir-label">Images:</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => setEpicImages(Array.from(e.target.files ?? []))}
                  />
                  <button
                    className="btn target-dir-btn"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    📎
                  </button>
                  {epicImages.length > 0 && (
                    <span className="file-count">{epicImages.length} file(s)</span>
                  )}
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
                <span>Epics ({displayEpics.length})</span>
                {selectedEpic && <span className="filter-badge">🔍 {truncateId(selectedEpic)}</span>}
                {schedulerDate && <span className="filter-badge">📅 {schedulerDate}</span>}              </div>
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
              <div className="pagination-bar">
                <button 
                  className="mini-btn" 
                  disabled={epicPage === 0} 
                  onClick={() => setEpicPage(p => p - 1)}
                >
                  &lt; Prev
                </button>
                <span className="pagination-info">
                  Page {epicPage + 1} of {Math.ceil(epicTotal / epicPageSize) || 1}
                </span>
                <button 
                  className="mini-btn" 
                  disabled={(epicPage + 1) * epicPageSize >= epicTotal} 
                  onClick={() => setEpicPage(p => p + 1)}
                >
                  Next &gt;
                </button>
              </div>
              <div className="epic-list">
                {displayEpics.length ? (
                  displayEpics.map((epic) => (
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
                          {epic.status === "paused" ? (
                            <button
                              className="mini-btn"
                              onClick={(e) => { e.stopPropagation(); void resumeEpic(epic.id); }}
                              disabled={actionBusy !== null}
                              title="Resume epic"
                            >
                              ▶
                            </button>
                          ) : ["executing", "planning", "reviewing"].includes(epic.status) ? (
                            <button
                              className="mini-btn"
                              onClick={(e) => { e.stopPropagation(); void pauseEpic(epic.id); }}
                              disabled={actionBusy !== null}
                              title="Pause epic"
                            >
                              ⏸
                            </button>
                          ) : null}
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
                            <span className="ticket-id">{truncateId(normalizeDisplayedTicketId(ticket.id))}</span>
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
          open={!planMinimized}
          onMinimize={() => setPlanMinimized(true)}
          onReady={() => setPlanReady(true)}
          onStateChange={({ hasPlan, awaitingClarification }) => {
            setPlanReady(hasPlan && !awaitingClarification);
            setPlanAwaitingClarification(awaitingClarification);
          }}
          onClose={() => {
            setPlanSessionId(null);
            setPlanMinimized(false);
            setPlanReady(false);
            setPlanAwaitingClarification(false);
          }}
          onApproved={(epicId) => {
            setPlanSessionId(null);
            setPlanMinimized(false);
            setPlanReady(false);
            setPlanAwaitingClarification(false);
            setTitle("");
            setGoalText("");
            setTargetBranch("");
            void refresh();
          }}
        />
      )}

      {planMinimized && planSessionId && (
        <div 
          className={`minimized-planner-indicator ${planReady ? 'is-ready' : planAwaitingClarification ? 'is-ready' : ''}`}
          onClick={() => setPlanMinimized(false)}
          title={
            planReady
              ? "Plan is ready. Click to open."
              : planAwaitingClarification
              ? "Planner needs clarification. Click to answer."
              : "Planning in progress... Click to open."
          }
        >
          <span className="min-icon">📐</span>
          <span className="min-label">Planning: {title}</span>
          {(planReady || planAwaitingClarification) && <span className="min-ready-dot" />}
        </div>
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
          events={selectedTicketEvents}
          runs={data.runs}
          open={true}
          onClose={() => setSelectedTicket(null)}
          onCancel={() => void cancelTicket(selectedTicket.id)}
          onRerun={() => void rerunTicket(selectedTicket.id)}
          onForceRerunInPlace={() => void forceRerunTicketInPlace(selectedTicket.id)}
          onRerunDirect={() => void rerunDirectTicket(selectedTicket.id)}
          onForceRescue={() => void forceRescueTicket(selectedTicket.id)}
          onUpdate={(input) => updateTicketDetails(selectedTicket.id, input)}
          onDelete={() => void deleteTicket(selectedTicket.id)}
          actionBusy={actionBusy !== null}
        />
      )}

      {selectedEpicDetails && (
        <EpicModal
          epic={selectedEpicDetails}
          open={true}
          onClose={() => setSelectedEpicDetails(null)}
          onRedecode={() => void redecodeEpic(selectedEpicDetails.id)}
          onRetry={() => void retryEpic(selectedEpicDetails.id)}
          onReview={() => void reviewEpic(selectedEpicDetails.id)}
          onPlayLoop={() => void playLoopEpic(selectedEpicDetails.id)}
          onMergeToMain={() => void mergeEpicToMain(selectedEpicDetails.id)}
          onMarkDone={() => void markEpicDone(selectedEpicDetails.id)}
          onCancel={() => void cancelEpic(selectedEpicDetails.id)}
          onPause={() => void pauseEpic(selectedEpicDetails.id)}
          onResume={() => void resumeEpic(selectedEpicDetails.id)}
          onDelete={() => void deleteEpic(selectedEpicDetails.id)}
          actionBusy={actionBusy !== null}
          mergeStatus={selectedEpicMergeStatus}
          mergeStatusLoading={selectedEpicMergeStatusLoading}
          epicEvents={data.agentEvents.filter((e) => e.payload?.epicId === selectedEpicDetails.id)}
          epicTickets={data.tickets.filter((t) => t.epicId === selectedEpicDetails.id)}
        />
      )}

      <DirectChatModal
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        modelsConfig={modelsConfig}
        defaultTargetDir={targetDir}
      />

      <GameModal isOpen={isTetrisOpen} onClose={() => setIsTetrisOpen(false)} game="tetris" />
      <GameModal isOpen={isPacmanOpen} onClose={() => setIsPacmanOpen(false)} game="pacman" />
      <GameModal isOpen={isTamagotchiOpen} onClose={() => setIsTamagotchiOpen(false)} game="tamagotchi" />
    </div>
  );
}
