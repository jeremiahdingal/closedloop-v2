import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CanonicalEditPacket, TicketRecord, ExplorerOutput } from "../types.ts";

export async function buildCanonicalEditPacket(
  ticket: TicketRecord,
  explorerOutput: ExplorerOutput,
  workspacePath: string
): Promise<CanonicalEditPacket> {
  const allRecommendedFiles = Array.from(new Set([
    ...explorerOutput.recommendedFilesForCoding,
    ...explorerOutput.relevantFiles
  ]));

  const files: CanonicalEditPacket["files"] = [];

  for (const relPath of allRecommendedFiles) {
    const fullPath = join(workspacePath, relPath);
    try {
      const content = await readFile(fullPath, "utf8");
      const sha256 = createHash("sha256").update(content).digest("hex");
      
      // Basic size limit for "small/medium/large" files
      const isLarge = content.length > 500000; 

      files.push({
        path: relPath,
        exists: true,
        sha256,
        content: isLarge ? null : content,
        excerpts: isLarge ? [{ content: content.slice(0, 20000), startLine: 1, endLine: 400 }] : undefined // Simple default excerpt
      });
    } catch (err) {
      files.push({
        path: relPath,
        exists: false,
        sha256: null,
        content: null
      });
    }
  }

  // Determine destructive permissions based on ticket context
  // Default to false, can be tuned by heuristics or explicit ticket flags
  const allowFileDeletion = ticket.description.toLowerCase().includes("delete") || 
                            ticket.description.toLowerCase().includes("remove") ||
                            ticket.acceptanceCriteria.some(c => c.toLowerCase().includes("delete") || c.toLowerCase().includes("remove"));

  const allowFileRename = ticket.description.toLowerCase().includes("rename") || 
                          ticket.description.toLowerCase().includes("move");

  return {
    ticketId: ticket.id,
    goalText: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria,
    allowedPaths: Array.from(new Set([...(ticket.allowedPaths ?? []), ...allRecommendedFiles])),
    files,
    destructivePermissions: {
      allowFileDeletion,
      allowFileRename,
      allowLargeDeletion: false, // Strict by default
      allowFullReplace: false    // Strict by default
    },
    allowedDeletePaths: allowFileDeletion ? (allRecommendedFiles.length > 0 ? allRecommendedFiles : ticket.allowedPaths) : [],
    allowedRenamePaths: allowFileRename ? (allRecommendedFiles.length > 0 ? allRecommendedFiles : ticket.allowedPaths) : [],
    allowedFullReplacePaths: []
  };
}

