import { GoalRunner } from "../orchestration/goal-runner.ts";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { bootstrap } from "./bootstrap.ts";
import { loadConfig, updateAgentModel } from "../config.ts";
import type { AgentRole } from "../types.ts";

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
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware, bash + file tools via ChatGPT subscription" },
    { id: "opencode:qwen3-coder:30b", label: "OpenCode (qwen3-coder:30b)", description: "Workspace-aware, bash + file tools via OpenCode CLI" },
    { id: "ollama", label: "Ollama (Fallback)", description: "Pure LLM via local Ollama, no workspace tools" }
  ],
  epicReviewer: [
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "opencode:qwen3-coder:30b", label: "OpenCode (qwen3-coder:30b)", description: "Workspace-aware, bash + file tools via OpenCode CLI" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware, bash + file tools via ChatGPT subscription" }
  ],
  builder: [
    { id: "mediated:qwen3-coder:30b", label: "Mediated (qwen3-coder:30b)", description: "Local tool execution via Ollama + harness" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Local tool execution via Ollama + harness" },
    { id: "opencode:qwen3-coder:30b", label: "OpenCode (qwen3-coder:30b)", description: "Workspace-aware, bash + file tools via OpenCode CLI" }
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
  const { config, db, goalRunner, lifecycle } = await bootstrap();
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
        return json(res, 200, db.listEventsAfterId(Number(url.searchParams.get("afterId") || 0), {
          kind: "agent_stream",
          runId: url.searchParams.get("runId") || undefined,
          ticketId: url.searchParams.get("ticketId") || undefined,
          limit: Number(url.searchParams.get("limit") || 500)
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
          targetDir: String(body.targetDir || process.cwd())
        });
        const runId = await goalRunner.enqueueGoal(epic.id);
        return json(res, 201, { epic, runId });
      }
      const cancelEpicMatch = /^\/api\/epics\/([^/]+)\/cancel$/.exec(url.pathname);
      if (cancelEpicMatch && req.method === "POST") {
        const summary = await lifecycle.cancelEpic(decodeURIComponent(cancelEpicMatch[1]));
        return json(res, 200, { ok: true, ...summary });
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
