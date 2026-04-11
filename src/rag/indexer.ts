/**
 * RAG Workspace Indexer
 * Walks a workspace, chunks files, embeds them, and stores in SQLite
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, posix } from "node:path";
import { AppDatabase } from "../db/database.ts";
import { embedTexts, isEmbeddingModelAvailable, serializeEmbedding } from "./embeddings.ts";
import { parseAst } from "./ast-parser.ts";

const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const MAX_FILE_SIZE = 50 * 1024; // 50KB
const SKIP_PATTERNS = /node_modules|\.git|\.next|dist|build|\.env|\.lock/;
const EMBEDDING_BATCH_SIZE = 64;
const EMBEDDING_MAX_CHARS = 4000;

export interface IndexOptions {
  repoRoot: string;
  commitHash: string;
  db: AppDatabase;
  model?: string;
  baseUrl?: string;
  scopePaths?: string[];
  onProgress?: (message: string) => void;
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
  const existing = options.db.getRagIndex(options.repoRoot, options.commitHash, model);

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
  if (options.onProgress) options.onProgress(`Chunked ${chunks.length} files.`);

  if (chunks.length === 0) {
    const indexId = options.db.createRagIndex({
      repoRoot: options.repoRoot,
      commitHash: options.commitHash,
      chunkCount: 0,
      modelName: model,
    });
    return { indexId, chunkCount: 0 };
  }

  // Embed chunk contents in batches to avoid oversized Ollama requests.
  const contents = chunks.map((c) =>
    c.content.length > EMBEDDING_MAX_CHARS ? c.content.slice(0, EMBEDDING_MAX_CHARS) : c.content
  );
  const embeddings: Float32Array[] = [];
  const totalBatches = Math.ceil(contents.length / EMBEDDING_BATCH_SIZE);
  
  for (let i = 0; i < contents.length; i += EMBEDDING_BATCH_SIZE) {
    const currentBatch = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;
    if (options.onProgress) options.onProgress(`Embedding batch ${currentBatch}/${totalBatches}...`);
    
    const batch = contents.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchEmbeddings = await embedTexts(batch, { model, baseUrl });
    embeddings.push(...batchEmbeddings);
  }

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

  // AST pass: extract dependency graph from TypeScript files
  try {
    await buildAndStoreAst(options.repoRoot, indexId, options.db, options.scopePaths);
  } catch (err) {
    console.warn(`[RAG] AST pass failed: ${err}`);
  }

  return { indexId, chunkCount: chunks.length };
}

/**
 * Walk TypeScript/TSX files, parse AST, and store nodes + edges
 */
async function buildAndStoreAst(
  repoRoot: string,
  indexId: number,
  db: AppDatabase,
  scopePaths?: string[]
): Promise<void> {
  const files = await walkDir(repoRoot, repoRoot, scopePaths);
  const tsFiles = files.filter((f) => /\.(ts|tsx)$/.test(f));

  const nodes: Parameters<AppDatabase["insertAstNodes"]>[1] = [];
  const edges: Parameters<AppDatabase["insertAstEdges"]>[1] = [];

  for (const file of tsFiles) {
    try {
      const source = await readFile(file, "utf-8");
      const relPath = relative(repoRoot, file).replace(/\\/g, "/");
      const result = parseAst(relPath, source);

      // Collect nodes (exported symbols)
      for (const exp of result.exports) {
        nodes.push({
          filePath: relPath,
          symbolName: exp.name,
          symbolKind: exp.kind,
          startLine: 1,
        });
      }
      for (const sig of result.signatures) {
        // Update startLine for matching nodes or add signature text
        const existing = nodes.find((n) => n.filePath === relPath && n.symbolName === sig.name);
        if (existing) {
          existing.startLine = sig.line;
          existing.signatureText = sig.text;
        }
      }

      // Collect edges (import relationships)
      const dirPath = posix.dirname(relPath);
      for (const imp of result.imports) {
        // Only resolve relative imports (skip npm packages)
        if (!imp.from.startsWith(".")) continue;

        let resolved = posix.normalize(posix.join(dirPath, imp.from));
        // Try to resolve with .ts extension if no extension present
        if (!/\.(ts|tsx|js|jsx)$/.test(resolved)) {
          resolved = resolved + ".ts";
        }

        const depType = imp.isTypeOnly ? "type-import" : "import";
        edges.push({ sourceFile: relPath, targetFile: resolved, depType });
      }
    } catch {
      // Skip unparseable files
    }
  }

  if (nodes.length > 0) db.insertAstNodes(indexId, nodes);
  if (edges.length > 0) db.insertAstEdges(indexId, edges);
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
  const files = await walkDir(repoRoot, repoRoot, scopePaths);
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
function normalizeScopePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

function isInScope(relPath: string, scopePaths?: string[]): boolean {
  if (!scopePaths || scopePaths.length === 0) return true;
  const normalizedRel = normalizeScopePath(relPath);
  const normalizedScopes = scopePaths.map(normalizeScopePath).filter(Boolean);
  if (normalizedScopes.length === 0) return true;
  if (normalizedScopes.includes("*")) return true;
  return normalizedScopes.some((scope) => normalizedRel === scope || normalizedRel.startsWith(`${scope}/`));
}

function shouldTraverseDir(relDir: string, scopePaths?: string[]): boolean {
  if (!scopePaths || scopePaths.length === 0) return true;
  const normalizedDir = normalizeScopePath(relDir);
  const normalizedScopes = scopePaths.map(normalizeScopePath).filter(Boolean);
  if (normalizedScopes.length === 0) return true;
  if (normalizedScopes.includes("*")) return true;
  // Traverse when this directory is inside a scoped path OR is an ancestor of one.
  return normalizedScopes.some(
    (scope) =>
      normalizedDir === scope ||
      normalizedDir.startsWith(`${scope}/`) ||
      scope.startsWith(`${normalizedDir}/`)
  );
}

async function walkDir(repoRoot: string, dir: string, scopePaths?: string[]): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Skip patterns
    if (SKIP_PATTERNS.test(entry.name)) continue;

    // Scope filter
    const relPathFromRoot = relative(repoRoot, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (!shouldTraverseDir(relPathFromRoot, scopePaths)) continue;
      files.push(...(await walkDir(repoRoot, fullPath, scopePaths)));
    } else if (entry.isFile()) {
      if (!isInScope(relPathFromRoot, scopePaths)) continue;
      files.push(fullPath);
    }
  }

  return files;
}

function isCodeFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|c|cpp|java)$/.test(path);
}

export function isDocFile(path: string): boolean {
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
export function chunkDocFile(filePath: string, content: string): Chunk[] {
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
