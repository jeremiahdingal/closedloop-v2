import path from "node:path";
import { writeJson } from "../utils.ts";
import type { TicketContextPacket } from "../types.ts";

export async function writeContextPacket(workspacePath: string, packet: TicketContextPacket): Promise<string> {
  const filePath = path.join(workspacePath, ".orchestrator", "context.json");
  await writeJson(filePath, packet as unknown as Record<string, unknown>);
  return filePath;
}
