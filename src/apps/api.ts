import { GoalRunner } from "../orchestration/goal-runner.ts";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { bootstrap } from "./bootstrap.ts";

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
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function writeSseEvent(res: http.ServerResponse, event: string, data: unknown, id?: number | string) {
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function main() {
  const { config, db, goalRunner } = await bootstrap();
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
          goalText: String(body.goalText || "")
        });
        const runId = await goalRunner.enqueueGoal(epic.id);
        return json(res, 201, { epic, runId });
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
