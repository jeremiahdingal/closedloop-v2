import path from "node:path";
import { readFile } from "node:fs/promises";

export type ReviewerMode = "off" | "direct-fast" | "mediated-deep";

export type SchemaInvariantRule = {
  source: string;
  derived: string;
  strict: boolean;
};

export type FolderBoundaryRule = {
  path: string;
  owner: string;
};

export type ReviewContract = {
  schemaSources: string[];
  derivedSchemas: SchemaInvariantRule[];
  generatedReadOnlyPaths: string[];
  folderOwnership: FolderBoundaryRule[];
  strictFolderBoundaries: boolean;
};

export type ReviewContractLoadResult = {
  found: boolean;
  valid: boolean;
  contractPath: string;
  warnings: string[];
  contract: ReviewContract | null;
};

export type ReviewGuardResult = {
  passed: boolean;
  blockers: string[];
  suggestions: string[];
  metadata: {
    ruleHits: string[];
    changedFiles: string[];
    contractFound: boolean;
    contractValid: boolean;
    contractPath: string;
  };
};

type ReviewGuardInput = {
  diff: string;
  allowedPaths: string[];
  contract: ReviewContractLoadResult;
  destructiveBlockers: string[];
};

const contractCache = new Map<string, ReviewContractLoadResult>();

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function inPath(filePath: string, basePath: string): boolean {
  const file = normalizePath(filePath);
  const base = normalizePath(basePath).replace(/\/+$/, "");
  if (!base) return true;
  return file === base || file.startsWith(`${base}/`);
}

export function extractChangedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const addMatch = /^\+\+\+ b\/(.+)$/.exec(line.trim());
    const delMatch = /^--- a\/(.+)$/.exec(line.trim());
    const candidate = addMatch?.[1] ?? delMatch?.[1];
    if (!candidate || candidate === "/dev/null") continue;
    files.add(normalizePath(candidate));
  }
  return [...files];
}

function normalizeDerivedSchemas(raw: unknown): SchemaInvariantRule[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((entry): SchemaInvariantRule | null => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        const source = typeof record.source === "string" ? normalizePath(record.source) : "";
        const derived = typeof record.derived === "string" ? normalizePath(record.derived) : "";
        if (!source || !derived) return null;
        return {
          source,
          derived,
          strict: record.strict !== false,
        };
      })
      .filter((value): value is SchemaInvariantRule => value !== null);
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .map(([derived, source]): SchemaInvariantRule | null => {
        if (typeof source !== "string") return null;
        return {
          source: normalizePath(source),
          derived: normalizePath(derived),
          strict: true,
        };
      })
      .filter((value): value is SchemaInvariantRule => value !== null);
  }
  return [];
}

function normalizeFolderOwnership(raw: unknown): FolderBoundaryRule[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        const rulePath = typeof record.path === "string" ? normalizePath(record.path) : "";
        const owner = typeof record.owner === "string" ? record.owner.trim() : "";
        if (!rulePath || !owner) return null;
        return { path: rulePath, owner } satisfies FolderBoundaryRule;
      })
      .filter((value): value is FolderBoundaryRule => Boolean(value));
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .map(([rulePath, owner]) => {
        if (typeof owner !== "string") return null;
        return { path: normalizePath(rulePath), owner: owner.trim() } satisfies FolderBoundaryRule;
      })
      .filter((value): value is FolderBoundaryRule => Boolean(value));
  }
  return [];
}

function parseReviewContractMarkdown(markdown: string): { contract: ReviewContract | null; warnings: string[] } {
  const warnings: string[] = [];
  const sectionMatch = /##\s*REVIEW_CONTRACT\b([\s\S]*)/i.exec(markdown);
  if (!sectionMatch) {
    warnings.push("Missing REVIEW_CONTRACT section in PROJECT_STRUCTURE.md.");
    return { contract: null, warnings };
  }

  const blockMatch = /```(json|yaml|yml)?\s*([\s\S]*?)```/i.exec(sectionMatch[1]);
  if (!blockMatch) {
    warnings.push("Missing fenced REVIEW_CONTRACT payload.");
    return { contract: null, warnings };
  }

  const lang = (blockMatch[1] || "json").toLowerCase();
  if (lang !== "json") {
    warnings.push(`Unsupported REVIEW_CONTRACT format '${lang}'. Use JSON.`);
    return { contract: null, warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(blockMatch[2].trim());
  } catch (err) {
    warnings.push(`Invalid REVIEW_CONTRACT JSON: ${err instanceof Error ? err.message : String(err)}`);
    return { contract: null, warnings };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push("REVIEW_CONTRACT payload must be a JSON object.");
    return { contract: null, warnings };
  }

  const record = parsed as Record<string, unknown>;
  const schemaSources = Array.isArray(record.schemaSources)
    ? record.schemaSources.filter((v): v is string => typeof v === "string").map(normalizePath)
    : [];
  const derivedSchemas = normalizeDerivedSchemas(record.derivedSchemas);
  const generatedReadOnlyPaths = Array.isArray(record.generatedReadOnlyPaths)
    ? record.generatedReadOnlyPaths.filter((v): v is string => typeof v === "string").map(normalizePath)
    : [];
  const folderOwnership = normalizeFolderOwnership(record.folderOwnership);
  const strictFolderBoundaries = record.strictFolderBoundaries === true;

  return {
    warnings,
    contract: {
      schemaSources,
      derivedSchemas,
      generatedReadOnlyPaths,
      folderOwnership,
      strictFolderBoundaries,
    },
  };
}

export async function loadReviewContract(
  workspaceRoot: string,
  reviewContractPath: string
): Promise<ReviewContractLoadResult> {
  const resolvedPath = path.isAbsolute(reviewContractPath)
    ? reviewContractPath
    : path.join(workspaceRoot, reviewContractPath);
  const cacheKey = `${workspaceRoot}::${resolvedPath}`;
  const cached = contractCache.get(cacheKey);
  if (cached) return cached;

  try {
    const markdown = await readFile(resolvedPath, "utf8");
    const { contract, warnings } = parseReviewContractMarkdown(markdown);
    const result: ReviewContractLoadResult = {
      found: true,
      valid: Boolean(contract),
      contractPath: resolvedPath,
      warnings,
      contract,
    };
    contractCache.set(cacheKey, result);
    return result;
  } catch {
    const result: ReviewContractLoadResult = {
      found: false,
      valid: false,
      contractPath: resolvedPath,
      warnings: [`Review contract file not found at ${resolvedPath}.`],
      contract: null,
    };
    contractCache.set(cacheKey, result);
    return result;
  }
}

export function runReviewGuard(input: ReviewGuardInput): ReviewGuardResult {
  const blockers = new Set<string>(input.destructiveBlockers);
  const suggestions = new Set<string>();
  const ruleHits = new Set<string>();

  if (input.destructiveBlockers.length > 0) {
    ruleHits.add("destructive_diff");
  }

  const changedFiles = extractChangedFilesFromDiff(input.diff);

  const contract = input.contract.contract;
  if (contract) {
    for (const file of changedFiles) {
      if (contract.generatedReadOnlyPaths.some((p) => inPath(file, p))) {
        blockers.add(`Generated/read-only path modified directly: ${file}`);
        ruleHits.add("generated_read_only");
      }
    }

    if (contract.strictFolderBoundaries && contract.folderOwnership.length > 0) {
      for (const file of changedFiles) {
        const owners = contract.folderOwnership.filter((r) => inPath(file, r.path));
        if (owners.length === 0) {
          blockers.add(`Changed file is outside declared folder ownership: ${file}`);
          ruleHits.add("folder_ownership_missing");
        }
        if (owners.length > 1) {
          blockers.add(`Folder ownership conflict for ${file}: ${owners.map((o) => o.owner).join(", ")}`);
          ruleHits.add("folder_ownership_conflict");
        }
      }
    }

    for (const rule of contract.derivedSchemas) {
      const sourceChanged = changedFiles.some((file) => inPath(file, rule.source));
      const derivedChanged = changedFiles.some((file) => inPath(file, rule.derived));

      if (derivedChanged && !sourceChanged && rule.strict) {
        blockers.add(`Derived schema changed without source update: ${rule.derived} (source: ${rule.source})`);
        ruleHits.add("schema_source_of_truth");
      }
      if (sourceChanged && !derivedChanged) {
        suggestions.add(`Schema source changed without derived update: ${rule.source} -> ${rule.derived}`);
        ruleHits.add("schema_derived_missing");
      }
    }
  } else {
    suggestions.add("Review contract unavailable; only destructive and allowed-path checks were enforced.");
    ruleHits.add("contract_fallback");
  }

  for (const warning of input.contract.warnings) {
    suggestions.add(warning);
  }

  const blockerList = [...blockers];
  const suggestionList = [...suggestions];
  return {
    passed: blockerList.length === 0,
    blockers: blockerList,
    suggestions: suggestionList,
    metadata: {
      ruleHits: [...ruleHits],
      changedFiles,
      contractFound: input.contract.found,
      contractValid: input.contract.valid,
      contractPath: input.contract.contractPath,
    },
  };
}
