import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { CanonicalEditPacket, CoderOutput, EditOperation, TicketRecord } from "../types.ts";

export type VerifierOutcome = "accepted" | "repairable" | "escalate" | "empty_failure";

export type VerificationResult = {
  outcome: VerifierOutcome;
  summary: string;
  appliedOperations: EditOperation[];
  failedOperations: Array<{ op: EditOperation; reason: string }>;
  unauthorizedOperations: Array<{ op: EditOperation; reason: string }>;
  staleOperations: Array<{ op: EditOperation; reason: string }>;
};

export async function verifyAndApplyEdits(
  ticket: TicketRecord,
  coderOutput: CoderOutput,
  editPacket: CanonicalEditPacket,
  workspacePath: string
): Promise<VerificationResult> {
  const result: VerificationResult = {
    outcome: "accepted",
    summary: "",
    appliedOperations: [],
    failedOperations: [],
    unauthorizedOperations: [],
    staleOperations: []
  };

  if (coderOutput.unresolvedBlockers.length > 0) {
    if (coderOutput.operations.length > 0) {
      result.summary = `(Warning: unresolved blockers: ${coderOutput.unresolvedBlockers.join(", ")}) `;
    } else {
      result.outcome = "escalate";
      result.summary = `Coder reported unresolved blockers: ${coderOutput.unresolvedBlockers.join(", ")}`;
      return result;
    }
  }

  if (coderOutput.operations.length === 0) {
    result.outcome = "empty_failure";
    result.summary = "Coder produced no operations.";
    return result;
  }

  for (const op of coderOutput.operations) {
    // 1. Path validation
    if (!isPathAllowed(op.path, editPacket.allowedPaths)) {
      result.unauthorizedOperations.push({ op, reason: "Path not in allowedPaths" });
      continue;
    }

    // 2. Operation-specific validation
    try {
      if (op.kind === "search_replace") {
        const fileInPacket = editPacket.files.find(f => f.path === op.path);
        if (!fileInPacket || !fileInPacket.exists) {
          result.failedOperations.push({ op, reason: "File does not exist in packet" });
          continue;
        }
        
        // Hash check
        const fullPath = join(workspacePath, op.path);
        const currentContent = await readFile(fullPath, "utf8");
        const currentHash = createHash("sha256").update(currentContent).digest("hex");
        
        if (currentHash !== op.expected_sha256) {
          result.staleOperations.push({ op, reason: "SHA256 mismatch (stale edit)" });
          continue;
        }

        // Apply search/replace
        const index = currentContent.indexOf(op.search);
        if (index === -1) {
          result.failedOperations.push({ op, reason: "Search block not found in file" });
          continue;
        }

        const newContent = currentContent.slice(0, index) + op.replace + currentContent.slice(index + op.search.length);
        await writeFile(fullPath, newContent, "utf8");
        result.appliedOperations.push(op);

      } else if (op.kind === "create_file") {
        const fullPath = join(workspacePath, op.path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, op.content, "utf8");
        result.appliedOperations.push(op);

      } else if (op.kind === "append_file") {
        const fullPath = join(workspacePath, op.path);
        const existing = await readFile(fullPath, "utf8").catch(() => "");
        await writeFile(fullPath, existing + op.content, "utf8");
        result.appliedOperations.push(op);

      } else if (op.kind === "delete_file") {
        if (!editPacket.destructivePermissions.allowFileDeletion && !editPacket.allowedDeletePaths.includes(op.path)) {
          result.unauthorizedOperations.push({ op, reason: "File deletion not authorized" });
          continue;
        }
        const fullPath = join(workspacePath, op.path);
        await unlink(fullPath);
        result.appliedOperations.push(op);

      } else if (op.kind === "rename_file") {
        if (!editPacket.destructivePermissions.allowFileRename && !editPacket.allowedRenamePaths.includes(op.path)) {
          result.unauthorizedOperations.push({ op, reason: "File rename not authorized" });
          continue;
        }
        const oldFullPath = join(workspacePath, op.path);
        const newFullPath = join(workspacePath, op.newPath);
        await mkdir(dirname(newFullPath), { recursive: true });
        await rename(oldFullPath, newFullPath);
        result.appliedOperations.push(op);
      }
    } catch (err) {
      result.failedOperations.push({ op, reason: `Error applying operation: ${err}` });
    }
  }

  // Final outcome determination
  if (result.unauthorizedOperations.length > 0) {
    result.outcome = "escalate"; // Potentially useful but needs review/authorization
    result.summary = `Unauthorized operations attempted: ${result.unauthorizedOperations.length}`;
  } else if (result.failedOperations.length > 0 || result.staleOperations.length > 0) {
    result.outcome = "repairable";
    result.summary = `Some operations failed (${result.failedOperations.length}) or were stale (${result.staleOperations.length})`;
  } else if (result.appliedOperations.length === 0) {
    result.outcome = "empty_failure";
    result.summary = "No operations were successfully applied.";
  } else {
    result.outcome = "accepted";
    result.summary = `Successfully applied ${result.appliedOperations.length} operations.`;
  }

  return result;
}

function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  if (allowedPaths.includes("*")) return true;
  return allowedPaths.some(p => filePath.startsWith(p));
}
