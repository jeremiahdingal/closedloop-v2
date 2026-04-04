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
  totalTokenEstimate: number;
  retrievalMode: "semantic" | "keyword";
  chunkCount: number;
}

/**
 * Build pre-computed context for a ticket
 */
export async function buildContextForTicket(options: ContextBuildOptions): Promise<BuiltContext> {
  const maxTokens = options.maxTokens || 8000;

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
    const primaryBudget = Math.floor(maxTokens * 0.7);
    const primaryChunks = await retrieveChunks({
      query,
      db: options.db,
      indexId: indexResult.id!,
      topK: 15,
      scopePaths: options.ticket.allowedPaths,
      maxTokens: primaryBudget,
      model: options.model,
      baseUrl: options.baseUrl,
    });

    // Retrieve broader context (unscoped) if budget allows
    const secondaryBudget = maxTokens - primaryBudget;
    const secondaryChunks = secondaryBudget > 1000
      ? await retrieveChunks({
          query,
          db: options.db,
          indexId: indexResult.id!,
          topK: 10,
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
