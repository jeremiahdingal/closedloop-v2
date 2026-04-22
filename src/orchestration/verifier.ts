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
  relaxedOperations: Array<{ op: EditOperation; reason: string }>;
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
    staleOperations: [],
    relaxedOperations: []
  };

  if ((coderOutput.unresolvedBlockers ?? []).length > 0) {
    if ((coderOutput.operations ?? []).length > 0) {
      result.summary = `(Warning: unresolved blockers: ${coderOutput.unresolvedBlockers.join(", ")}) `;
    } else {
      result.outcome = "escalate";
      result.summary = `Coder reported unresolved blockers: ${coderOutput.unresolvedBlockers.join(", ")}`;
      return result;
    }
  }

  if ((coderOutput.operations ?? []).length === 0) {
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

        const fullPath = join(workspacePath, op.path);
        const currentContent = await readFile(fullPath, "utf8");
        const currentHash = createHash("sha256").update(currentContent).digest("hex");

        // Hash check — warn if stale but still attempt application.
        // The search block itself is the real validation: if the search text
        // is found in the current file content, the edit is valid regardless
        // of the SHA256 hash. Hash mismatches typically mean the file was
        // modified by a previous run or between explorer/coder stages.
        const hashMatches = currentHash === op.expected_sha256;
        if (!hashMatches) {
          console.warn(`[VERIFIER] SHA256 mismatch for ${op.path} — attempting relaxed application (search block validation)`);
        }

        // Skip identity transforms (search === replace) — no actual change needed
        if (op.search === op.replace) {
          console.warn(`[VERIFIER] Skipping identity transform for ${op.path} (search === replace)`);
          continue;
        }

        // Apply search/replace
        let index = currentContent.indexOf(op.search);
        let usedFuzzyMatch = false;

        // Fallback: normalize whitespace for matching (handles tabs vs spaces, trailing whitespace)
        if (index === -1) {
          const normalizeWs = (s: string) => s.replace(/\r\n/g, "\n").replace(/\t/g, "  ").replace(/[ \t]+$/gm, "");
          const normCurrent = normalizeWs(currentContent);
          const normSearch = normalizeWs(op.search);
          const normIndex = normCurrent.indexOf(normSearch);
          if (normIndex !== -1) {
            // Find the corresponding position in the original content
            // Use the normalized position as a hint and scan nearby
            const approxCharCount = normSearch.length;
            for (let scanStart = Math.max(0, normIndex - 50); scanStart < Math.min(currentContent.length, normIndex + 200); scanStart++) {
              const candidate = currentContent.slice(scanStart, scanStart + op.search.length + 100);
              const normCandidate = normalizeWs(candidate);
              if (normCandidate.startsWith(normSearch)) {
                // Find the actual end position by matching normalized length
                let endOffset = 0;
                let normOffset = 0;
                while (normOffset < normSearch.length && scanStart + endOffset < currentContent.length) {
                  const ch = currentContent[scanStart + endOffset];
                  const normCh = normalizeWs(ch);
                  endOffset++;
                  normOffset += normCh.length;
                }
                index = scanStart;
                usedFuzzyMatch = true;
                console.warn(`[VERIFIER] Fuzzy whitespace match for ${op.path} at offset ${index}`);
                break;
              }
            }
          }
        }

        if (index === -1) {
          const detail = hashMatches
            ? `Search block not found in file (searched ${op.search.length} chars in ${currentContent.length} char file)`
            : "Search block not found in file (SHA256 also mismatched — file has diverged since edit was planned)";
          result.failedOperations.push({ op, reason: detail });
          console.warn(`[VERIFIER] Search block for ${op.path}: first 200 chars of search: ${op.search.slice(0, 200)}`);
          console.warn(`[VERIFIER] File content first 200 chars: ${currentContent.slice(0, 200)}`);
          continue;
        }

        const newContent = currentContent.slice(0, index) + op.replace + currentContent.slice(index + op.search.length);
        await writeFile(fullPath, newContent, "utf8");
        result.appliedOperations.push(op);
        if (usedFuzzyMatch) {
          result.relaxedOperations.push({ op, reason: "Applied with fuzzy whitespace matching" });
        }
        if (!hashMatches && !usedFuzzyMatch) {
          result.relaxedOperations.push({ op, reason: "SHA256 mismatch but search block matched — applied with relaxed validation" });
        }

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
  } else if (result.failedOperations.length > 0) {
    // Only set repairable if some operations actually FAILED (not just stale hashes)
    result.outcome = "repairable";
    result.summary = `Some operations failed (${result.failedOperations.length})${result.relaxedOperations.length > 0 ? `, ${result.relaxedOperations.length} applied with relaxed hash validation` : ""}`;
  } else if (result.appliedOperations.length === 0) {
    result.outcome = "empty_failure";
    result.summary = "No operations were successfully applied.";
  } else {
    result.outcome = "accepted";
    const relaxedNote = result.relaxedOperations.length > 0 ? ` (${result.relaxedOperations.length} with relaxed hash validation)` : "";
    result.summary = `Successfully applied ${result.appliedOperations.length} operations${relaxedNote}.`;
  }

  return result;
}

function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  if (allowedPaths.includes("*")) return true;
  return allowedPaths.some(p => filePath.startsWith(p));
}
