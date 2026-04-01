import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ensureDir, nowIso } from "../utils.ts";

export async function appendAuditLine(auditDir: string, fileName: string, line: string): Promise<void> {
  await ensureDir(auditDir);
  await appendFile(path.join(auditDir, fileName), `[${nowIso()}] ${line}\n`, "utf8");
}
