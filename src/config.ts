import path from "node:path";
import { readFileSync } from "node:fs";
import type { AgentRole, CommandCatalog } from "./types.ts";

export type AppConfig = {
  dataDir: string;
  dbPath: string;
  artifactsDir: string;
  workspacesDir: string;
  publicDir: string;
  uiDistDir: string;
  repoRoot: string;
  apiPort: number;
  workerPollMs: number;
  leaseTtlMs: number;
  workspaceRetentionHours: number;
  dryRun: boolean;
  useLangGraph: boolean;
  commandCatalog: CommandCatalog;
  models: Record<AgentRole, string>;
};

function readModelsFile(): Record<AgentRole, string> {
  const filePath = path.resolve(process.cwd(), "config", "agent-models.json");
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<AgentRole, string>;
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
  const repoRoot = path.resolve(process.env.REPO_ROOT || process.cwd());
  const publicDir = path.resolve(process.cwd(), "src", "public");
  const uiDistDir = path.resolve(process.cwd(), "frontend-dist");

  return {
    dataDir,
    dbPath: path.join(dataDir, "state.db"),
    artifactsDir: path.join(dataDir, "artifacts"),
    workspacesDir: path.join(dataDir, "workspaces"),
    publicDir,
    uiDistDir,
    repoRoot,
    apiPort: Number(process.env.API_PORT || 4010),
    workerPollMs: Number(process.env.WORKER_POLL_MS || 1000),
    leaseTtlMs: Number(process.env.LEASE_TTL_MS || 60_000),
    workspaceRetentionHours: Number(process.env.WORKSPACE_RETENTION_HOURS || 48),
    dryRun: process.env.DRY_RUN === "1",
    useLangGraph: process.env.USE_LANGGRAPH !== "0",
    commandCatalog: {
      status: process.env.STATUS_COMMAND || "git status --short",
      test: process.env.TEST_COMMAND || "npm test -- --runInBand",
      lint: process.env.LINT_COMMAND || "npm run lint",
      typecheck: process.env.TYPECHECK_COMMAND || "npm run typecheck"
    },
    models: readModelsFile()
  };
}
