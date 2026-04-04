/**
 * RAG Retrieval Engine
 * Semantic search with keyword fallback
 */

import { AppDatabase } from "../db/database.ts";
import { embedTexts, cosineSimilarity, deserializeEmbedding, isEmbeddingModelAvailable } from "./embeddings.ts";

const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TOP_K = 15;
const DEFAULT_MAX_TOKENS = 8000;

export interface RetrievalOptions {
  query: string;
  db: AppDatabase;
  indexId: number;
  topK?: number;
  scopePaths?: string[];
  maxTokens?: number;
  model?: string;
  baseUrl?: string;
}

export interface RetrievedChunk {
  filePath: string;
  chunkType: string;
  content: string;
  score: number;
  startLine?: number;
  endLine?: number;
  tokenEstimate: number;
}

/**
 * Retrieve relevant chunks for a query
 * Uses semantic search if embeddings available, falls back to keyword search
 */
export async function retrieveChunks(options: RetrievalOptions): Promise<RetrievedChunk[]> {
  const topK = options.topK || DEFAULT_TOP_K;
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;

  // Load all chunks for the index
  const dbChunks = options.db.loadRagChunks(options.indexId, options.scopePaths);

  if (dbChunks.length === 0) {
    return [];
  }

  // Try semantic search first
  const isAvailable = await isEmbeddingModelAvailable({ model, baseUrl });
  if (isAvailable) {
    try {
      const queryEmbeddings = await embedTexts([options.query], { model, baseUrl });
      const queryVec = queryEmbeddings[0];

      const scored = dbChunks.map((chunk) => ({
        ...chunk,
        score: cosineSimilarity(queryVec, deserializeEmbedding(chunk.embedding)),
      }));

      scored.sort((a, b) => b.score - a.score);

      // Apply AST dependency boost if available
      try {
        await applyAstBoost(scored, options.db, options.indexId);
        scored.sort((a, b) => b.score - a.score);
      } catch {
        // skip boost on error
      }

      return deduplicateAndBudget(scored, topK, maxTokens);
    } catch (err) {
      console.warn(`[RAG] Semantic search failed: ${err}. Falling back to keyword search.`);
    }
  }

  // Keyword fallback
  return keywordRetrieve(options.query, dbChunks, topK, maxTokens);
}

/**
 * Keyword-based retrieval (grep-style)
 */
export function keywordRetrieve(
  query: string,
  chunks: Array<{
    filePath: string;
    chunkType: string;
    content: string;
    tokenEstimate: number;
  }>,
  topK: number,
  maxTokens: number
): RetrievedChunk[] {
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const scored = chunks.map((chunk) => {
    let score = 0;
    for (const kw of keywords) {
      const matches = (chunk.content.toLowerCase().match(new RegExp(kw, "g")) || []).length;
      score += matches;
    }
    return {
      ...chunk,
      score: score > 0 ? Math.log(score + 1) : 0, // log scale
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return deduplicateAndBudget(scored, topK, maxTokens);
}

/**
 * Boost scores based on AST import relationships
 * Direct neighbor (file imported by/from top-k file) → +0.15
 * 2-hop transitive neighbor → +0.05
 */
async function applyAstBoost(
  scored: Array<{ filePath: string; score: number }>,
  db: AppDatabase,
  indexId: number
): Promise<void> {
  const edges = db.loadAstEdgesForIndex(indexId);
  if (edges.length === 0) return;

  // Build adjacency map: file → set of direct neighbors
  const adj = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adj.has(edge.sourceFile)) adj.set(edge.sourceFile, new Set());
    if (!adj.has(edge.targetFile)) adj.set(edge.targetFile, new Set());
    adj.get(edge.sourceFile)!.add(edge.targetFile);
    adj.get(edge.targetFile)!.add(edge.sourceFile);
  }

  // Collect file paths of top-K chunks (first 15 or all if fewer)
  const topFiles = new Set(scored.slice(0, 15).map((c) => c.filePath));

  // Build 2-hop set from top files
  const twoHopFiles = new Set<string>();
  for (const f of topFiles) {
    const neighbors = adj.get(f);
    if (!neighbors) continue;
    for (const n of neighbors) {
      if (!topFiles.has(n)) {
        twoHopFiles.add(n);
        const secondNeighbors = adj.get(n);
        if (secondNeighbors) {
          for (const nn of secondNeighbors) {
            if (!topFiles.has(nn)) twoHopFiles.add(nn);
          }
        }
      }
    }
  }

  // Apply boosts
  for (const chunk of scored) {
    if (topFiles.has(chunk.filePath)) continue; // already in top
    const neighbors = adj.get(chunk.filePath);
    if (neighbors && [...neighbors].some((n) => topFiles.has(n))) {
      chunk.score += 0.15;
    } else if (twoHopFiles.has(chunk.filePath)) {
      chunk.score += 0.05;
    }
  }
}

/**
 * Deduplicate chunks from same file and respect token budget
 */
function deduplicateAndBudget(
  chunks: any[],
  topK: number,
  maxTokens: number
): RetrievedChunk[] {
  const fileCount = new Map<string, number>();
  const result: RetrievedChunk[] = [];
  let totalTokens = 0;
  const MAX_PER_FILE = 3;

  for (const chunk of chunks) {
    if (result.length >= topK) break;
    if (totalTokens >= maxTokens) break;

    const count = fileCount.get(chunk.filePath) || 0;
    if (count >= MAX_PER_FILE) continue;

    totalTokens += chunk.tokenEstimate;
    if (totalTokens <= maxTokens) {
      result.push({
        filePath: chunk.filePath,
        chunkType: chunk.chunkType,
        content: chunk.content,
        score: chunk.score ?? 0,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        tokenEstimate: chunk.tokenEstimate,
      });
      fileCount.set(chunk.filePath, count + 1);
    }
  }

  return result;
}
