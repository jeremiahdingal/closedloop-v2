import { GoalRunner } from "../orchestration/goal-runner.ts";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { bootstrap } from "./bootstrap.ts";
import { loadConfig, updateAgentModel } from "../config.ts";
import type { AgentRole, AgentStreamPayload, GoalDecomposition } from "../types.ts";
import { runPlanDecoder, extractPlanFromStream } from "../orchestration/plan-runner.ts";
import { randomId } from "../utils.ts";

// ---------------------------------------------------------------------------
// In-memory plan session store (ephemeral — lost on server restart, by design)
// ---------------------------------------------------------------------------
type PlanSession = {
  id: string;
  epicTitle: string;
  epicDescription: string;
  targetDir: string;
  targetBranch: string | null;
  userMessages: string[];
  latestPlan: GoalDecomposition | null;
  status: "running" | "idle" | "error";
  streamChunks: AgentStreamPayload[];
  textChunks: string[];       // raw assistant text for FINAL_JSON detection
  pendingMessages: string[];  // queued while decoder is running
};

const planSessions = new Map<string, PlanSession>();

type ModelAdapterOption = {
  id: string;
  label: string;
  description: string;
};

type AgentModelInfo = {
  currentModel: string;
  adapters: ModelAdapterOption[];
  switchable: boolean;
};

const SWITCHABLE_ADAPTORS: Record<string, ModelAdapterOption[]> = {
  epicDecoder: [
    { id: "qwen-cli", label: "Qwen CLI", description: "Workspace-aware local Qwen CLI execution" },
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware, bash + file tools via ChatGPT subscription" },
    { id: "opencode:qwen3-coder:30b", label: "OpenCode (qwen3-coder:30b)", description: "Workspace-aware, bash + file tools via OpenCode CLI" },
    { id: "ollama", label: "Ollama (Fallback)", description: "Pure LLM via local Ollama, no workspace tools" },
    { id: "gemma4:26b", label: "Ollama (gemma4:26b)", description: "Pure LLM via local Ollama, no workspace tools" }
  ],
  epicReviewer: [
    { id: "qwen-cli", label: "Qwen CLI", description: "Workspace-aware local Qwen CLI execution" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:gemma4:26b", label: "Mediated (gemma4:26b)", description: "Local tool execution via Ollama + harness" },
    { id: "opencode:qwen3-coder:30b", label: "OpenCode (qwen3-coder:30b)", description: "Workspace-aware, bash + file tools via OpenCode CLI" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware, bash + file tools via ChatGPT subscription" }
  ],
  reviewer: [
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "qwen3.5:9b", label: "Ollama (qwen3.5:9b)", description: "Pure LLM via local Ollama, no workspace tools" },
    { id: "glm-4.7-flash:q4_K_M", label: "Ollama (glm-4.7-flash)", description: "Pure LLM via local Ollama, no workspace tools" },
    { id: "gemma4:26b", label: "Ollama (gemma4:26b)", description: "Pure LLM via local Ollama, no workspace tools" }
  ],
  tester: [
    { id: "skip", label: "Skip Tester", description: "Bypass tester step and mark tests as skipped" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:gemma4:26b", label: "Mediated (gemma4:26b)", description: "Local tool execution via Ollama + harness" }
  ],
  builder: [
    { id: "mediated:qwen2.5-coder:14b", label: "Mediated (qwen2.5-coder:14b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen2.5-coder:7b", label: "Mediated (qwen2.5-coder:7b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:devstral-small-2:24b", label: "Mediated (devstral-small-2:24b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:gemma4:26b", label: "Mediated (gemma4:26b)", description: "Local tool execution via Ollama + harness" }
  ]
};

function parseAdapter(raw: string): { adapter: string; model: string } {
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) {
    return { adapter: raw.slice(0, colonIdx), model: raw.slice(colonIdx + 1) };
  }
  return { adapter: raw, model: "" };
}

function getAgentModelsConfig(): Record<string, AgentModelInfo> {
  const models = loadConfig().models;
  const result: Record<string, AgentModelInfo> = {};
  for (const [role, rawModel] of Object.entries(models)) {
    if (role === "epicReviewer") {
      result[role] = {
        currentModel: "qwen-cli",
        adapters: [{ id: "qwen-cli", label: "Qwen CLI (Forced)", description: "Temporarily locked to Qwen CLI for epic review stability" }],
        switchable: false
      };
      continue;
    }
    const { adapter, model } = parseAdapter(rawModel);
    const switchableOptions = SWITCHABLE_ADAPTORS[role];
    const adapters: ModelAdapterOption[] = switchableOptions
      ? switchableOptions.map((opt) => {
          if (opt.id === "opencode" && model) {
            return { id: `opencode:${model}`, label: `OpenCode (${model})`, description: opt.description };
          }
          return opt;
        })
      : [{ id: rawModel, label: rawModel, description: "Configured adapter" }];
    result[role] = {
      currentModel: rawModel,
      adapters,
      switchable: Boolean(switchableOptions)
    };
  }
  return result;
}

function isAgentRole(value: string): value is AgentRole {
  return ["epicDecoder", "builder", "reviewer", "tester", "epicReviewer", "doctor", "system"].includes(value);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function writeSseEvent(res: http.ServerResponse, event: string, data: unknown, id?: number | string) {
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function main() {
  const { config, db, goalRunner, lifecycle, ticketRunner } = await bootstrap();
  const server = http.createServer(async (req, res) => {
    try {
      setCors(res);
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (!req.url) return json(res, 400, { error: "missing_url" });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === "/health") return json(res, 200, { ok: true, dryRun: config.dryRun, useLangGraph: config.useLangGraph });
      if (url.pathname === "/api/epics" && req.method === "GET") return json(res, 200, db.listEpics());
      if (url.pathname === "/api/tickets" && req.method === "GET") return json(res, 200, db.listTickets(url.searchParams.get("epicId") || undefined));
      if (url.pathname === "/api/runs" && req.method === "GET") return json(res, 200, db.listRuns());
      if (url.pathname === "/api/jobs" && req.method === "GET") return json(res, 200, db.listJobs());
      if (url.pathname === "/api/events" && req.method === "GET") return json(res, 200, db.listEvents());
      if (url.pathname === "/api/artifacts" && req.method === "GET") {
        return json(res, 200, db.listArtifacts(url.searchParams.get("ticketId") || undefined));
      }
      if (url.pathname === "/api/agent-events" && req.method === "GET") {
        const afterId = Number(url.searchParams.get("afterId") || 0);
        return json(res, 200, db.listEventsAfterId(afterId, {
          kind: "agent_stream",
          runId: url.searchParams.get("runId") || undefined,
          ticketId: url.searchParams.get("ticketId") || undefined,
          limit: Number(url.searchParams.get("limit") || 500),
          newest: !url.searchParams.get("afterId")
        }));
      }
      if (url.pathname === "/api/agent-stream" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        let afterId = Number(url.searchParams.get("afterId") || 0);
        const runId = url.searchParams.get("runId") || undefined;
        const ticketId = url.searchParams.get("ticketId") || undefined;
        let closed = false;
        req.on("close", () => {
          closed = true;
        });
        writeSseEvent(res, "ready", { ok: true, afterId });
        const pump = () => {
          if (closed) return;
          const rows = db.listEventsAfterId(afterId, { kind: "agent_stream", runId, ticketId, limit: 200 });
          for (const row of rows as any[]) {
            afterId = Number(row.id);
            writeSseEvent(res, "agent", row, row.id as number);
          }
          res.write(`: heartbeat ${Date.now()}\n\n`);
          setTimeout(pump, 1000);
        };
        pump();
        return;
      }
      if (url.pathname === "/api/epics" && req.method === "POST") {
        const body = await readBody(req);
        const epic = GoalRunner.createEpic(db, {
          title: String(body.title || "Untitled epic"),
          goalText: String(body.goalText || ""),
          targetDir: String(body.targetDir || process.cwd()),
          targetBranch: body.targetBranch ? String(body.targetBranch) : undefined
        });
        const runId = await goalRunner.enqueueGoal(epic.id);
        return json(res, 201, { epic, runId });
      }
      const cancelEpicMatch = /^\/api\/epics\/([^/]+)\/cancel$/.exec(url.pathname);
      if (cancelEpicMatch && req.method === "POST") {
        const summary = await lifecycle.cancelEpic(decodeURIComponent(cancelEpicMatch[1]));
        return json(res, 200, { ok: true, ...summary });
      }
      const reviewEpicMatch = /^\/api\/epics\/([^/]+)\/review$/.exec(url.pathname);
      if (reviewEpicMatch && req.method === "POST") {
        const epicId = decodeURIComponent(reviewEpicMatch[1]);
        const epic = db.getEpic(epicId);
        if (!epic) return json(res, 404, { error: "epic_not_found" });
        const runId = await goalRunner.enqueueManualReview(epicId);
        return json(res, 200, { ok: true, epicId, runId });
      }
      const retryEpicMatch = /^\/api\/epics\/([^/]+)\/retry$/.exec(url.pathname);
      if (retryEpicMatch && req.method === "POST") {
        const epicId = decodeURIComponent(retryEpicMatch[1]);
        const epic = db.getEpic(epicId);
        if (!epic) return json(res, 404, { error: "epic_not_found" });
        db.updateEpicStatus(epicId, "executing");
        const runId = await goalRunner.enqueueGoal(epicId);
        return json(res, 200, { ok: true, epicId, runId });
      }
      const deleteEpicMatch = /^\/api\/epics\/([^/]+)$/.exec(url.pathname);
      if (deleteEpicMatch && req.method === "DELETE") {
        const summary = await lifecycle.deleteEpic(decodeURIComponent(deleteEpicMatch[1]));
        return json(res, 200, { ok: true, ...summary });
      }
      const cancelTicketMatch = /^\/api\/tickets\/([^/]+)\/cancel$/.exec(url.pathname);
      if (cancelTicketMatch && req.method === "POST") {
        const summary = await lifecycle.cancelTicket(decodeURIComponent(cancelTicketMatch[1]));
        return json(res, 200, { ok: true, ...summary });
      }
      const rerunTicketMatch = /^\/api\/tickets\/([^/]+)\/rerun$/.exec(url.pathname);
      if (rerunTicketMatch && req.method === "POST") {
        const ticketId = decodeURIComponent(rerunTicketMatch[1]);
        const body = await readBody(req);
        const cancelActive = body?.cancelActive !== false;
        const ticket = db.getTicket(ticketId);
        if (!ticket) return json(res, 404, { error: "ticket_not_found" });
        const activeRuns = db
          .listRunsForTicket(ticket.id)
          .filter((run) => run.status === "queued" || run.status === "running" || run.status === "waiting");
        if (activeRuns.length && !cancelActive) {
          return json(res, 409, { error: "ticket_has_active_run", activeRunIds: activeRuns.map((run) => run.id) });
        }
        if (activeRuns.length) {
          await lifecycle.cancelTicket(ticket.id);
        }
        const runId = await ticketRunner.start(ticket.id, ticket.epicId);
        db.recordEvent({
          aggregateType: "ticket",
          aggregateId: ticket.id,
          runId,
          ticketId: ticket.id,
          kind: "ticket_rerun_queued",
          message: "Ticket rerun queued.",
          payload: { ticketId: ticket.id, runId, cancelledPreviousRuns: activeRuns.map((run) => run.id) }
        });
        return json(res, 200, { ok: true, runId, ticketId: ticket.id });
      }
      const forceRerunInPlaceMatch = /^\/api\/tickets\/([^/]+)\/force-rerun-in-place$/.exec(url.pathname);
      if (forceRerunInPlaceMatch && req.method === "POST") {
        const ticketId = decodeURIComponent(forceRerunInPlaceMatch[1]);
        const ticket = db.getTicket(ticketId);
        if (!ticket) return json(res, 404, { error: "ticket_not_found" });
        if (!ticket.currentRunId) {
          return json(res, 409, { error: "ticket_has_no_current_run", message: "Ticket has no current run to reuse." });
        }
        const run = db.getRun(ticket.currentRunId);
        if (!run) return json(res, 404, { error: "run_not_found", runId: ticket.currentRunId });
        if (run.kind !== "ticket") {
          return json(res, 409, { error: "invalid_run_kind", message: "Only ticket runs can be force-rerun in place." });
        }

        // Supersede stale/duplicate active jobs for this run before enqueuing a new one.
        const supersededJobIds: string[] = [];
        for (const job of db.listJobRecords()) {
          const payload = (job.payload ?? {}) as Record<string, unknown>;
          if (job.kind !== "run_ticket") continue;
          if (String(payload.runId ?? "") !== run.id) continue;
          if (job.status !== "queued" && job.status !== "running") continue;
          db.failJob(job.id, "Superseded by force rerun in place.", false);
          supersededJobIds.push(job.id);
        }

        const timestamp = new Date().toISOString();
        const reason = "Force rerun requested by user (in place).";
        db.updateRun({
          runId: run.id,
          status: "queued",
          currentNode: "recovery",
          heartbeatAt: timestamp,
          lastMessage: reason,
          errorText: null,
          attempt: run.attempt + 1
        });
        db.updateTicketRunState({
          ticketId: ticket.id,
          status: "queued",
          currentRunId: run.id,
          currentNode: "recovery",
          lastHeartbeatAt: timestamp,
          lastMessage: reason
        });
        db.enqueueJob("run_ticket", { ticketId: ticket.id, epicId: ticket.epicId, runId: run.id });
        db.recordEvent({
          aggregateType: "ticket",
          aggregateId: ticket.id,
          runId: run.id,
          ticketId: ticket.id,
          kind: "ticket_force_rerun_in_place",
          message: reason,
          payload: {
            ticketId: ticket.id,
            runId: run.id,
            priorStatus: run.status,
            priorNode: run.currentNode,
            supersededJobIds
          }
        });
        return json(res, 200, { ok: true, runId: run.id, ticketId: ticket.id, supersededJobIds });
      }
      const forceRescueMatch = /^\/api\/tickets\/([^/]+)\/force-rescue$/.exec(url.pathname);
      if (forceRescueMatch && req.method === "POST") {
        const ticketId = decodeURIComponent(forceRescueMatch[1]);
        const body = await readBody(req);
        const minStaleMsRaw = Number(body?.minStaleMs ?? 60_000);
        const minStaleMs = Number.isFinite(minStaleMsRaw) && minStaleMsRaw >= 0 ? minStaleMsRaw : 60_000;
        const requireReviewerNode = body?.requireReviewerNode !== false;

        const ticket = db.getTicket(ticketId);
        if (!ticket) return json(res, 404, { error: "ticket_not_found" });
        if (!ticket.currentRunId) {
          return json(res, 409, { error: "ticket_has_no_current_run", message: "Ticket has no current run to rescue." });
        }
        const run = db.getRun(ticket.currentRunId);
        if (!run) return json(res, 404, { error: "run_not_found", runId: ticket.currentRunId });
        if (run.kind !== "ticket") {
          return json(res, 409, { error: "invalid_run_kind", message: "Only ticket runs can be rescued." });
        }

        const node = String(run.currentNode ?? "").toLowerCase();
        if (requireReviewerNode && !node.includes("review")) {
          return json(res, 409, {
            error: "run_not_in_reviewer",
            message: "Force rescue is only allowed when current node is reviewer.",
            currentNode: run.currentNode
          });
        }

        const heartbeatAtMs = run.heartbeatAt ? new Date(run.heartbeatAt).getTime() : 0;
        const stalledForMs = heartbeatAtMs > 0 ? Math.max(0, Date.now() - heartbeatAtMs) : Number.MAX_SAFE_INTEGER;
        if (stalledForMs < minStaleMs) {
          return json(res, 409, {
            error: "run_not_stale_enough",
            message: `Run heartbeat is still fresh (${stalledForMs}ms < ${minStaleMs}ms).`,
            stalledForMs,
            minStaleMs
          });
        }

        const supersededJobIds: string[] = [];
        for (const job of db.listJobRecords()) {
          const payload = (job.payload ?? {}) as Record<string, unknown>;
          if (job.kind !== "run_ticket") continue;
          if (String(payload.runId ?? "") !== run.id) continue;
          if (job.status !== "queued" && job.status !== "running") continue;
          db.failJob(job.id, "Superseded by manual force rescue.", false);
          supersededJobIds.push(job.id);
        }

        const timestamp = new Date().toISOString();
        const reason = `Doctor forced rescue for ticket ${ticket.id} at ${run.currentNode ?? "unknown node"}.`;
        db.updateRun({
          runId: run.id,
          status: "queued",
          currentNode: "recovery",
          heartbeatAt: timestamp,
          lastMessage: reason,
          errorText: null,
          attempt: run.attempt + 1
        });
        db.updateTicketRunState({
          ticketId: ticket.id,
          status: "queued",
          currentRunId: run.id,
          currentNode: "recovery",
          lastHeartbeatAt: timestamp,
          lastMessage: reason
        });
        db.enqueueJob("run_ticket", { ticketId: ticket.id, epicId: ticket.epicId, runId: run.id });
        db.recordEvent({
          aggregateType: "ticket",
          aggregateId: ticket.id,
          runId: run.id,
          ticketId: ticket.id,
          kind: "agent_stream",
          message: "doctor:assistant",
          payload: {
            agentRole: "doctor",
            source: "orchestrator",
            streamKind: "assistant",
            content: reason,
            runId: run.id,
            ticketId: ticket.id,
            epicId: ticket.epicId,
            done: true
          }
        });
        db.recordEvent({
          aggregateType: "ticket",
          aggregateId: ticket.id,
          runId: run.id,
          ticketId: ticket.id,
          kind: "ticket_force_rescue",
          message: reason,
          payload: {
            ticketId: ticket.id,
            runId: run.id,
            priorStatus: run.status,
            priorNode: run.currentNode,
            stalledForMs,
            minStaleMs,
            supersededJobIds
          }
        });
        return json(res, 200, { ok: true, runId: run.id, ticketId: ticket.id, stalledForMs, supersededJobIds });
      }
      const deleteTicketMatch = /^\/api\/tickets\/([^/]+)$/.exec(url.pathname);
      if (deleteTicketMatch && req.method === "DELETE") {
        const summary = await lifecycle.deleteTicket(decodeURIComponent(deleteTicketMatch[1]));
        return json(res, 200, { ok: true, ...summary });
      }
      if (url.pathname === "/api/config" && req.method === "GET") {
        const configPath = path.join(process.cwd(), "config", "workspace.json");
        const wsConfig = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : {};
        return json(res, 200, { ...wsConfig, models: getAgentModelsConfig() });
      }
      if (url.pathname === "/api/models" && req.method === "GET") {
        return json(res, 200, getAgentModelsConfig());
      }
      if (url.pathname === "/api/models" && req.method === "PUT") {
        const body = await readBody(req);
        const role = String(body.role || "");
        const model = String(body.model || "").trim();
        if (!isAgentRole(role)) return json(res, 400, { error: "invalid_role" });
        if (!model) return json(res, 400, { error: "missing_model" });
        if (role === "epicReviewer" && model !== "qwen-cli") {
          return json(res, 409, { error: "model_locked", message: "epicReviewer is temporarily locked to qwen-cli." });
        }
        updateAgentModel(role, model);
        return json(res, 200, { ok: true, models: getAgentModelsConfig() });
      }
      if (url.pathname === "/api/config" && req.method === "PUT") {
        const body = await readBody(req);
        const configPath = path.join(process.cwd(), "config", "workspace.json");
        const content = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : {};
        Object.assign(content, body);
        await writeFile(configPath, JSON.stringify(content, null, 2));
        return json(res, 200, content);
      }

      // -----------------------------------------------------------------------
      // Plan Session routes (detached from main build pipeline)
      // -----------------------------------------------------------------------
      if (url.pathname === "/api/plan-session" && req.method === "POST") {
        const body = await readBody(req);
        const epicTitle = String(body.epicTitle || "Untitled Plan");
        const epicDescription = String(body.epicDescription || "");
        const targetDir = String(body.targetDir || process.cwd());

        const targetBranch = body.targetBranch ? String(body.targetBranch) : null;
        const sessionId = randomId("plan");
        const session: PlanSession = {
          id: sessionId,
          epicTitle,
          epicDescription,
          targetDir,
          targetBranch,
          userMessages: [],
          latestPlan: null,
          status: "running",
          streamChunks: [],
          textChunks: [],
          pendingMessages: [],
        };
        planSessions.set(sessionId, session);

        // Fire off plan decoder asynchronously — never awaited here
        const runSession = async (sess: PlanSession) => {
          try {
            const gateway = (goalRunner as any).gateway;
            const result = await runPlanDecoder({
              cwd: sess.targetDir,
              epicTitle: sess.epicTitle,
              epicDescription: sess.epicDescription,
              userMessages: sess.userMessages,
              sessionId: sess.id,
              db,
              gateway,
              onStream: (event: AgentStreamPayload) => {
                sess.streamChunks.push(event);
                if (event.streamKind === "assistant" && event.content) {
                  sess.textChunks.push(event.content);
                  const plan = extractPlanFromStream(sess.textChunks);
                  if (plan) sess.latestPlan = plan;
                }
              },
            });
            // Ollama fallback: onStream was never called — push rawText as a stream chunk
            if (!sess.latestPlan) {
              sess.latestPlan = result.plan;
              if (result.rawText) {
                sess.streamChunks.push({
                  agentRole: "epicDecoder",
                  source: "orchestrator",
                  streamKind: "assistant",
                  content: result.rawText,
                  sequence: sess.streamChunks.length,
                });
              }
            }
          } catch (err) {
            sess.streamChunks.push({
              agentRole: "epicDecoder",
              source: "orchestrator",
              streamKind: "stderr",
              content: `Plan decoder error: ${err instanceof Error ? err.message : String(err)}`,
              sequence: sess.streamChunks.length,
            });
            sess.status = "error";
            return;
          }
          // Drain any pending user messages as a re-run
          sess.status = "idle";
          if (sess.pendingMessages.length > 0) {
            sess.userMessages.push(...sess.pendingMessages);
            sess.pendingMessages = [];
            sess.textChunks = [];
            sess.latestPlan = null;
            sess.streamChunks.push({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "plan_cleared", content: "", sequence: sess.streamChunks.length });
            sess.status = "running";
            void runSession(sess);
          }
        };
        void runSession(session);

        return json(res, 201, { sessionId });
      }

      const planStreamMatch = /^\/api\/plan-session\/([^/]+)\/stream$/.exec(url.pathname);
      if (planStreamMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(planStreamMatch[1]);
        const session = planSessions.get(sessionId);
        if (!session) return json(res, 404, { error: "plan_session_not_found" });

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        let afterIndex = Number(url.searchParams.get("afterIndex") || 0);
        let closed = false;
        req.on("close", () => { closed = true; });
        writeSseEvent(res, "ready", { ok: true, afterIndex, status: session.status });
        const pump = () => {
          if (closed) return;
          const chunks = session.streamChunks;
          while (afterIndex < chunks.length) {
            const chunk = chunks[afterIndex];
            writeSseEvent(res, "agent", { ...chunk, id: afterIndex }, afterIndex);
            afterIndex++;
          }
          writeSseEvent(res, "session_status", { status: session.status, hasPlan: session.latestPlan !== null });
          if (session.latestPlan) {
            writeSseEvent(res, "plan_ready", session.latestPlan);
          }
          res.write(`: heartbeat ${Date.now()}\n\n`);
          setTimeout(pump, 800);
        };
        pump();
        return;
      }

      const planMessageMatch = /^\/api\/plan-session\/([^/]+)\/message$/.exec(url.pathname);
      if (planMessageMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(planMessageMatch[1]);
        const session = planSessions.get(sessionId);
        if (!session) return json(res, 404, { error: "plan_session_not_found" });
        const body = await readBody(req);
        const message = String(body.message || "").trim();
        if (!message) return json(res, 400, { error: "empty_message" });

        if (session.status === "running") {
          session.pendingMessages.push(message);
          return json(res, 200, { ok: true, queued: true });
        }
        // Re-run with new message
        session.userMessages.push(message);
        session.textChunks = [];
        session.streamChunks.push({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "plan_cleared", content: "", sequence: session.streamChunks.length });
        session.latestPlan = null;
        session.status = "running";
        const gateway = (goalRunner as any).gateway;
        const runSession = async (sess: PlanSession) => {
          try {
            const result = await runPlanDecoder({
              cwd: sess.targetDir,
              epicTitle: sess.epicTitle,
              epicDescription: sess.epicDescription,
              userMessages: sess.userMessages,
              sessionId: sess.id,
              db,
              gateway,
              onStream: (event: AgentStreamPayload) => {
                sess.streamChunks.push(event);
                if (event.streamKind === "assistant" && event.content) {
                  sess.textChunks.push(event.content);
                  const plan = extractPlanFromStream(sess.textChunks);
                  if (plan) sess.latestPlan = plan;
                }
              },
            });
            if (!sess.latestPlan) {
              sess.latestPlan = result.plan;
              if (result.rawText) {
                sess.streamChunks.push({
                  agentRole: "epicDecoder",
                  source: "orchestrator",
                  streamKind: "assistant",
                  content: result.rawText,
                  sequence: sess.streamChunks.length,
                });
              }
            }
          } catch (err) {
            sess.streamChunks.push({
              agentRole: "epicDecoder",
              source: "orchestrator",
              streamKind: "stderr",
              content: `Plan decoder error: ${err instanceof Error ? err.message : String(err)}`,
              sequence: sess.streamChunks.length,
            });
            sess.status = "error";
            return;
          }
          sess.status = "idle";
          if (sess.pendingMessages.length > 0) {
            sess.userMessages.push(...sess.pendingMessages);
            sess.pendingMessages = [];
            sess.textChunks = [];
            sess.latestPlan = null;
            sess.streamChunks.push({ agentRole: "epicDecoder", source: "orchestrator", streamKind: "plan_cleared", content: "", sequence: sess.streamChunks.length });
            sess.status = "running";
            void runSession(sess);
          }
        };
        void runSession(session);
        return json(res, 200, { ok: true, restarted: true });
      }

      const planApproveMatch = /^\/api\/plan-session\/([^/]+)\/approve$/.exec(url.pathname);
      if (planApproveMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(planApproveMatch[1]);
        const session = planSessions.get(sessionId);
        if (!session) return json(res, 404, { error: "plan_session_not_found" });
        if (!session.latestPlan) return json(res, 409, { error: "no_plan_ready", message: "The planner has not produced a plan yet." });

        const approveBody = await readBody(req);
        // Allow approve-time override; fall back to branch set at session creation
        const resolvedBranch = (approveBody.targetBranch ? String(approveBody.targetBranch) : null) ?? session.targetBranch ?? undefined;

        const epic = GoalRunner.createEpic(db, {
          title: session.epicTitle,
          goalText: session.epicDescription,
          targetDir: session.targetDir,
          targetBranch: resolvedBranch || undefined,
        });
        const runId = await goalRunner.approveFromPlan(epic.id, session.latestPlan);
        // Persist plan analysis stream as agent_stream events so the epic modal can display them
        for (const chunk of session.streamChunks) {
          if (!chunk.content) continue;
          db.recordEvent({
            aggregateType: "epic",
            aggregateId: epic.id,
            runId: null,
            ticketId: null,
            kind: "agent_stream",
            message: `planAnalysis:${chunk.streamKind || "assistant"}`,
            payload: { ...chunk, agentRole: "planAnalysis", epicId: epic.id, runId: null, ticketId: null } as any,
          });
        }
        planSessions.delete(sessionId);
        return json(res, 201, { epicId: epic.id, runId });
      }

      const builtIndex = path.join(config.uiDistDir, "index.html");
      if (req.method === "GET" && !url.pathname.startsWith("/api")) {
        const filePath = existsSync(builtIndex)
          ? path.join(config.uiDistDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1))
          : path.join(config.publicDir, "index.html");
        try {
          const html = await readFile(filePath, "utf8");
          res.setHeader("content-type", filePath.endsWith(".js") ? "application/javascript" : filePath.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
          res.end(html);
          return;
        } catch {
          if (existsSync(builtIndex)) {
            const html = await readFile(builtIndex, "utf8");
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(html);
            return;
          }
        }
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
    }
  });

  server.listen(config.apiPort, () => {
    console.log(`API listening on http://127.0.0.1:${config.apiPort}`);
  });
}

void main();
