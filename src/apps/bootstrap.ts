import { loadConfig } from "../config.ts";
import { AppDatabase } from "../db/database.ts";
import { WorkspaceBridge } from "../bridge/workspace-bridge.ts";
import { DryRunGateway, OllamaGateway, createGateway } from "../orchestration/models.ts";
import { TicketRunner } from "../orchestration/ticket-runner.ts";
import { GoalRunner } from "../orchestration/goal-runner.ts";
import { RecoveryService } from "../orchestration/recovery.ts";
import { LifecycleService } from "../orchestration/lifecycle.ts";
import { ensureDir } from "../utils.ts";
import { Agent, setGlobalDispatcher } from "undici";

// Configure global fetch timeout (15 mins) for local LLMs
setGlobalDispatcher(new Agent({
  connectTimeout: 900_000,
  headersTimeout: 900_000,
  bodyTimeout: 900_000,
  keepAliveTimeout: 900_000
}));

// Ensure only one Ollama model is loaded at a time
if (!process.env.OLLAMA_KEEP_ALIVE) {
  process.env.OLLAMA_KEEP_ALIVE = "0";
}
if (!process.env.OLLAMA_NUM_PARALLEL) {
  process.env.OLLAMA_NUM_PARALLEL = "1";
}

// Z AI API key for cloud model access
if (!process.env.ZAI_API_KEY) {
  process.env.ZAI_API_KEY = "582aa918cc194bdba2453e11c9f2080e.RU9NrpNKFOoqT5QD";
}

export async function bootstrap(options?: { dryRun?: boolean }) {
  const config = loadConfig();
  await ensureDir(config.dataDir);
  await ensureDir(config.artifactsDir);
  await ensureDir(config.workspacesDir);
  const db = new AppDatabase(config.dbPath);
  const bridge = new WorkspaceBridge(db);
  const lifecycle = new LifecycleService(db, bridge);
  const gateway = options?.dryRun ?? config.dryRun ? new DryRunGateway() : createGateway();
  const ticketRunner = new TicketRunner(db, bridge, gateway, lifecycle);
  const goalRunner = new GoalRunner(db, ticketRunner, gateway, lifecycle);
  const recovery = new RecoveryService(db, ticketRunner, goalRunner);
  await bridge.cleanupArchivedWorkspaces();
  return { config, db, bridge, gateway, ticketRunner, goalRunner, recovery, lifecycle };
}
