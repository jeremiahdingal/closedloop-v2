/**
 * Context Builder
 * Orchestrates RAG pipeline: index → retrieve → format
 */

import { AppDatabase } from "../db/database.ts";
import type { TicketRecord, TicketContextPacket } from "../types.ts";
import { getOrCreateIndex } from "./indexer.ts";
import { retrieveChunks } from "./retriever.ts";

export interface ContextBuildOptions {
  ticket: TicketRecord;
  packet: TicketContextPacket;
  db: AppDatabase;
  repoRoot: string;
  commitHash: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
}

export interface BuiltContext {
  codeContext: string;
  docContext: string;
  toolContext?: string;
  totalTokenEstimate: number;
  retrievalMode: "semantic" | "keyword";
  chunkCount: number;
}

export interface ToolingContextOptions {
  role: string;
  availableTools: string[];
  db: AppDatabase;
  indexId: number;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  includeRepair?: boolean;
}

function resolveRagBudget(model: string | undefined, explicitMaxTokens: number | undefined): number {
  if (typeof explicitMaxTokens === "number" && Number.isFinite(explicitMaxTokens) && explicitMaxTokens > 0) {
    return explicitMaxTokens;
  }
  void model;
  return 2000;
}

/**
 * Build context for tool guidance (playbooks, toolcards, repair hints)
 */
export async function buildToolingContext(options: ToolingContextOptions): Promise<string> {
  const maxTokens = options.maxTokens || 2000;
  
  // 1. Retrieve the playbook for the role
  const playbookQuery = `playbook for ${options.role}`;
  const playbooks = await retrieveChunks({
    query: playbookQuery,
    db: options.db,
    indexId: options.indexId,
    topK: 5,
    scopePaths: ["src/public/tooling/playbooks"],
    maxTokens: Math.floor(maxTokens * 0.4),
    model: options.model,
    baseUrl: options.baseUrl,
  });

  // 2. Retrieve toolcards for available tools
  const toolQueries = options.availableTools.map(t => `tool card for ${t}`).join(" OR ");
  const toolcards = await retrieveChunks({
    query: toolQueries,
    db: options.db,
    indexId: options.indexId,
    topK: options.availableTools.length,
    scopePaths: ["src/public/tooling/toolcards"],
    maxTokens: Math.floor(maxTokens * 0.5),
    model: options.model,
    baseUrl: options.baseUrl,
  });

  // 3. Optional: Retrieve repair hints
  const repairHints = options.includeRepair 
    ? await retrieveChunks({
        query: "common tool call errors and repairs",
        db: options.db,
        indexId: options.indexId,
        topK: 3,
        scopePaths: ["src/public/tooling/repair"],
        maxTokens: Math.floor(maxTokens * 0.1),
        model: options.model,
        baseUrl: options.baseUrl,
      })
    : [];

  const sections = ["=== Tool Guidance ==="];
  
  if (playbooks.length > 0) {
    sections.push("--- Playbook ---");
    sections.push(...playbooks.map(p => p.content));
  }

  if (toolcards.length > 0) {
    sections.push("--- Tool Cards ---");
    sections.push(...toolcards.map(t => t.content));
  }

  if (repairHints.length > 0) {
    sections.push("--- Repair Hints ---");
    sections.push(...repairHints.map(r => r.content));
  }

  return sections.join("\n\n");
}

/**
 * Build pre-computed context for a ticket
 */
export async function buildContextForTicket(options: ContextBuildOptions): Promise<BuiltContext> {
  const maxTokens = resolveRagBudget(options.model, options.maxTokens);

  try {
    // Create or retrieve index
    const indexResult = await getOrCreateIndex({
      repoRoot: options.repoRoot,
      commitHash: options.commitHash,
      db: options.db,
      model: options.model,
      baseUrl: options.baseUrl,
      scopePaths: options.ticket.allowedPaths,
    });

    if (indexResult.chunkCount === 0) {
      return {
        codeContext: "",
        docContext: "",
        totalTokenEstimate: 0,
        retrievalMode: "keyword",
        chunkCount: 0,
      };
    }

    // Build query from ticket
    const query =
      [
        options.ticket.title,
        options.ticket.description,
        options.ticket.acceptanceCriteria.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 1000); // Cap query at 1000 chars

    // Retrieve scoped to allowed paths
    const primaryBudget = Math.floor(maxTokens * 0.75);
    const primaryTopK = maxTokens >= 12000 ? 24 : 14;
    const secondaryTopK = maxTokens >= 12000 ? 12 : 8;

    const primaryChunks = await retrieveChunks({
      query,
      db: options.db,
      indexId: indexResult.id!,
      topK: primaryTopK,
      scopePaths: options.ticket.allowedPaths,
      maxTokens: primaryBudget,
      model: options.model,
      baseUrl: options.baseUrl,
    });

    // Retrieve broader context (unscoped) if budget allows
    const secondaryBudget = maxTokens - primaryBudget;
    const secondaryChunks = secondaryBudget > 500
      ? await retrieveChunks({
          query,
          db: options.db,
          indexId: indexResult.id!,
          topK: secondaryTopK,
          scopePaths: undefined,
          maxTokens: secondaryBudget,
          model: options.model,
          baseUrl: options.baseUrl,
        }).then((chunks) =>
          // Filter out files already in primary
          chunks.filter(
            (c) => !primaryChunks.some((p) => p.filePath === c.filePath)
          )
        )
      : [];

    const allChunks = [...primaryChunks, ...secondaryChunks];

    // Separate by type
    const codeChunks = allChunks.filter((c) =>
      ["imports", "signature", "full_file", "config"].includes(c.chunkType)
    );
    const docChunks = allChunks.filter((c) =>
      ["doc_section", "doc"].includes(c.chunkType)
    );

    // Format context
    const codeContext = formatCodeContext(codeChunks);
    const docContext = formatDocContext(docChunks);

    // Determine retrieval mode
    const retrievalMode = indexResult.cached ? "semantic" : "keyword";

    return {
      codeContext,
      docContext,
      totalTokenEstimate: allChunks.reduce((sum, c) => sum + c.tokenEstimate, 0),
      retrievalMode,
      chunkCount: allChunks.length,
    };
  } catch (err) {
    console.error(`[RAG] Context build error: ${err}`);
    return {
      codeContext: "",
      docContext: "",
      totalTokenEstimate: 0,
      retrievalMode: "keyword",
      chunkCount: 0,
    };
  }
}

export interface QueryContextBuildOptions {
  query: string;
  db: AppDatabase;
  repoRoot: string;
  commitHash: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  scopePaths?: string[];
  onProgress?: (message: string) => void;
}

/**
 * Build pre-computed context from a plain query string (for epic decoder/reviewer)
 */
export async function buildContextForQuery(
  options: QueryContextBuildOptions
): Promise<BuiltContext & { indexId: number | null }> {
  const maxTokens = resolveRagBudget(options.model, options.maxTokens);

  try {
    const indexResult = await getOrCreateIndex({
      repoRoot: options.repoRoot,
      commitHash: options.commitHash,
      db: options.db,
      model: options.model,
      baseUrl: options.baseUrl,
      scopePaths: options.scopePaths,
      onProgress: options.onProgress,
    });

    if (indexResult.chunkCount === 0) {
      return {
        codeContext: "",
        docContext: "",
        totalTokenEstimate: 0,
        retrievalMode: "keyword",
        chunkCount: 0,
        indexId: indexResult.id,
      };
    }

    const query = options.query.slice(0, 1000);

    const chunks = await retrieveChunks({
      query,
      db: options.db,
      indexId: indexResult.id!,
      topK: maxTokens >= 12000 ? 22 : 14,
      scopePaths: options.scopePaths,
      maxTokens,
      model: options.model,
      baseUrl: options.baseUrl,
    });

    const codeChunks = chunks.filter((c) =>
      ["imports", "signature", "full_file", "config"].includes(c.chunkType)
    );
    const docChunks = chunks.filter((c) =>
      ["doc_section", "doc"].includes(c.chunkType)
    );

    return {
      codeContext: formatCodeContext(codeChunks),
      docContext: formatDocContext(docChunks),
      totalTokenEstimate: chunks.reduce((sum, c) => sum + c.tokenEstimate, 0),
      retrievalMode: indexResult.cached ? "semantic" : "keyword",
      chunkCount: chunks.length,
      indexId: indexResult.id,
    };
  } catch (err) {
    console.error(`[RAG] Query context build error: ${err}`);
    return {
      codeContext: "",
      docContext: "",
      totalTokenEstimate: 0,
      retrievalMode: "keyword",
      chunkCount: 0,
      indexId: null,
    };
  }
}

function formatCodeContext(chunks: Array<{
  filePath: string;
  chunkType: string;
  content: string;
  startLine?: number;
  endLine?: number;
  score: number;
}>): string {
  if (chunks.length === 0) return "";

  const lines = ["=== Relevant Code ==="];

  for (const chunk of chunks) {
    const header = chunk.startLine
      ? `--- ${chunk.filePath} (lines ${chunk.startLine}-${chunk.endLine}) [${chunk.chunkType}] ---`
      : `--- ${chunk.filePath} [${chunk.chunkType}] ---`;
    lines.push(header);
    lines.push(chunk.content.slice(0, 2000)); // Truncate large chunks
    lines.push("");
  }

  return lines.join("\n");
}

function formatDocContext(chunks: Array<{
  filePath: string;
  chunkType: string;
  content: string;
}>): string {
  if (chunks.length === 0) return "";

  const lines = ["=== Relevant Documentation ==="];

  for (const chunk of chunks) {
    lines.push(`--- ${chunk.filePath} [${chunk.chunkType}] ---`);
    lines.push(chunk.content.slice(0, 1500));
    lines.push("");
  }

  return lines.join("\n");
}
