/**
 * RAG Workspace Indexer
 * Walks a workspace, chunks files, embeds them, and stores in SQLite
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { AppDatabase } from "../db/database.ts";
import { embedTexts, isEmbeddingModelAvailable, serializeEmbedding } from "./embeddings.ts";

const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const MAX_FILE_SIZE = 50 * 1024; // 50KB
const SKIP_PATTERNS = /node_modules|\.git|\.next|dist|build|\.env|\.lock/;

export interface IndexOptions {
  repoRoot: string;
  commitHash: string;
  db: AppDatabase;
  model?: string;
  baseUrl?: string;
  scopePaths?: string[];
}

export interface IndexResult {
  id: number;
  chunkCount: number;
  cached: boolean;
}

/**
 * Check if index exists; if not, create it
 */
export async function getOrCreateIndex(options: IndexOptions): Promise<IndexResult> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const existing = options.db.findRagIndex(options.repoRoot, options.commitHash, model);

  if (existing) {
    return {
      id: existing.id,
      chunkCount: existing.chunkCount,
      cached: true,
    };
  }

  const indexed = await indexWorkspace(options);
  return {
    id: indexed.indexId,
    chunkCount: indexed.chunkCount,
    cached: false,
  };
}

/**
 * Walk workspace, chunk files, embed, and store
 */
export async function indexWorkspace(options: IndexOptions): Promise<{ indexId: number; chunkCount: number }> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;

  const isAvailable = await isEmbeddingModelAvailable({ model, baseUrl });
  if (!isAvailable) {
    console.warn(`[RAG] Embedding model ${model} not available at ${baseUrl}. Skipping RAG indexing.`);
    // Create an index with 0 chunks to avoid re-trying
    const indexId = options.db.createRagIndex({
      repoRoot: options.repoRoot,
      commitHash: options.commitHash,
      chunkCount: 0,
      modelName: model,
    });
    return { indexId, chunkCount: 0 };
  }

  const chunks = await collectAndChunkFiles(options.repoRoot, options.scopePaths);

  if (chunks.length === 0) {
    const indexId = options.db.createRagIndex({
      repoRoot: options.repoRoot,
      commitHash: options.commitHash,
      chunkCount: 0,
      modelName: model,
    });
    return { indexId, chunkCount: 0 };
  }

  // Embed all chunk contents
  const contents = chunks.map((c) => c.content);
  const embeddings = await embedTexts(contents, { model, baseUrl });

  // Create index record
  const indexId = options.db.createRagIndex({
    repoRoot: options.repoRoot,
    commitHash: options.commitHash,
    chunkCount: chunks.length,
    modelName: model,
  });

  // Insert chunks with embeddings
  const chunksWithEmbeddings = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: serializeEmbedding(embeddings[i]),
  }));

  options.db.insertRagChunks(indexId, chunksWithEmbeddings);

  return { indexId, chunkCount: chunks.length };
}

interface Chunk {
  filePath: string;
  chunkType: string;
  startLine?: number;
  endLine?: number;
  content: string;
  tokenEstimate: number;
}

/**
 * Walk directory, collect files, chunk them
 */
async function collectAndChunkFiles(repoRoot: string, scopePaths?: string[]): Promise<Chunk[]> {
  const files = await walkDir(repoRoot, scopePaths);
  const chunks: Chunk[] = [];

  for (const file of files) {
    try {
      const content = await readFile(file, "utf-8");
      const relPath = relative(repoRoot, file);

      // Determine file type and chunk accordingly
      if (isCodeFile(file)) {
        chunks.push(...chunkCodeFile(relPath, content));
      } else if (isDocFile(file)) {
        chunks.push(...chunkDocFile(relPath, content));
      } else if (isConfigFile(file)) {
        chunks.push({
          filePath: relPath,
          chunkType: "config",
          content,
          tokenEstimate: estimateTokens(content),
        });
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return chunks;
}

/**
 * Recursively walk directory
 */
async function walkDir(dir: string, scopePaths?: string[]): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Skip patterns
    if (SKIP_PATTERNS.test(entry.name)) continue;

    // Scope filter
    if (scopePaths && scopePaths.length > 0) {
      const relPath = relative(dir, fullPath);
      if (!scopePaths.some((p) => relPath.startsWith(p))) {
        continue;
      }
    }

    if (entry.isDirectory()) {
      files.push(...(await walkDir(fullPath, scopePaths)));
    } else if (entry.isFile()) {
      const stat = await readFile(fullPath, { flag: "r" }).catch(() => null);
      if (stat) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function isCodeFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|c|cpp|java)$/.test(path);
}

function isDocFile(path: string): boolean {
  return /\.(md|markdown|txt|rst)$/i.test(path) || /README|CHANGELOG|AUTHORS/.test(path);
}

function isConfigFile(path: string): boolean {
  return /package\.json|tsconfig\.json|\.env|\.gitignore|\.npmrc|\.editorconfig|Makefile/.test(path);
}

/**
 * Chunk TypeScript/JavaScript files
 */
function chunkCodeFile(filePath: string, content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  // Extract imports block
  const importEnd = lines.findIndex((l, i) => i > 0 && !l.startsWith("import ") && l.trim());
  if (importEnd > 0) {
    const importContent = lines.slice(0, importEnd).join("\n");
    chunks.push({
      filePath,
      chunkType: "imports",
      startLine: 1,
      endLine: importEnd,
      content: importContent,
      tokenEstimate: estimateTokens(importContent),
    });
  }

  // Extract exports and functions
  let currentJsDoc = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith("/**")) {
      currentJsDoc = line;
      while (i < lines.length - 1 && !line.includes("*/")) {
        currentJsDoc += "\n" + lines[++i];
      }
    }

    if (/^export\s+(function|class|const|type|interface|enum|default)/.test(line)) {
      const sig = currentJsDoc + "\n" + line;
      chunks.push({
        filePath,
        chunkType: "signature",
        startLine: i + 1,
        endLine: i + 1,
        content: sig,
        tokenEstimate: estimateTokens(sig),
      });
      currentJsDoc = "";
    }
  }

  // If file is small, add full content
  if (lines.length < 100) {
    chunks.push({
      filePath,
      chunkType: "full_file",
      startLine: 1,
      endLine: lines.length,
      content,
      tokenEstimate: estimateTokens(content),
    });
  }

  return chunks;
}

/**
 * Chunk Markdown files by headings
 */
function chunkDocFile(filePath: string, content: string): Chunk[] {
  const sections = content.split(/\n(#{1,3} .+)/);
  const chunks: Chunk[] = [];

  for (let i = 0; i < sections.length; i += 2) {
    const heading = sections[i];
    const body = sections[i + 1];
    if (!body) continue;

    const sectionContent = heading + "\n" + body;
    chunks.push({
      filePath,
      chunkType: "doc_section",
      content: sectionContent,
      tokenEstimate: estimateTokens(sectionContent),
    });
  }

  if (chunks.length === 0) {
    chunks.push({
      filePath,
      chunkType: "doc",
      content,
      tokenEstimate: estimateTokens(content),
    });
  }

  return chunks;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
