import { loadConfig } from "../config.ts";
import { AppDatabase } from "../db/database.ts";
import { WorkspaceBridge } from "../bridge/workspace-bridge.ts";
import { DryRunGateway, OpenCodeHybridGateway } from "../orchestration/models.ts";
import { TicketRunner } from "../orchestration/ticket-runner.ts";
import { GoalRunner } from "../orchestration/goal-runner.ts";
import { RecoveryService } from "../orchestration/recovery.ts";
import { ensureDir } from "../utils.ts";

export async function bootstrap(options?: { dryRun?: boolean }) {
  const config = loadConfig();
  await ensureDir(config.dataDir);
  await ensureDir(config.artifactsDir);
  await ensureDir(config.workspacesDir);
  const db = new AppDatabase(config.dbPath);
  const bridge = new WorkspaceBridge(db);
  const gateway = options?.dryRun ?? config.dryRun ? new DryRunGateway() : new OpenCodeHybridGateway();
  const ticketRunner = new TicketRunner(db, bridge, gateway);
  const goalRunner = new GoalRunner(db, ticketRunner, gateway);
  const recovery = new RecoveryService(db, ticketRunner, goalRunner);
  return { config, db, bridge, gateway, ticketRunner, goalRunner, recovery };
}
