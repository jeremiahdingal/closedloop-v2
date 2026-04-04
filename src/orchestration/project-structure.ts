/**
 * Project Structure Generator
 * Generates PROJECT_STRUCTURE.md if missing or stale, for injection into big-CLI prompts.
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const SKIP_PATTERNS = /node_modules|\.git|\.next|dist|build|\.env|\.lock|__pycache__/;
const MAX_DEPTH = 3;
const STALE_MS = 60 * 60 * 1000; // 1 hour
const FILE_NAME = "PROJECT_STRUCTURE.md";

/**
 * Generate markdown project structure for a repo root.
 */
export async function generateProjectStructure(repoRoot: string): Promise<string> {
  const lines: string[] = [`# Project Structure`, ``, `Generated from: ${repoRoot}`, ``];

  // ASCII tree section
  lines.push(`## Directory Tree`, ``);
  const treeLines: string[] = [];
  await buildTree(repoRoot, repoRoot, 0, treeLines);
  lines.push(...treeLines, ``);

  // Flat file index
  lines.push(`## File Index`, ``);
  const allFiles: string[] = [];
  await collectFiles(repoRoot, repoRoot, 0, allFiles);
  for (const f of allFiles) lines.push(`- ${f}`);
  lines.push(``);

  return lines.join("\n");
}

async function buildTree(rootDir: string, currentDir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(currentDir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return;
  }

  const filtered = entries
    .filter((e) => !SKIP_PATTERNS.test(String(e.name)))
    .sort((a, b) => {
      // Directories first
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return String(a.name).localeCompare(String(b.name));
    });

  const prefix = "  ".repeat(depth);
  for (const entry of filtered) {
    const name = String(entry.name);
    const icon = entry.isDirectory() ? "📁" : "📄";
    out.push(`${prefix}${icon} ${name}`);
    if (entry.isDirectory() && depth < MAX_DEPTH) {
      await buildTree(rootDir, join(currentDir, name), depth + 1, out);
    }
  }
}

async function collectFiles(rootDir: string, currentDir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(currentDir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return;
  }

  for (const entry of entries) {
    const name = String(entry.name);
    if (SKIP_PATTERNS.test(name)) continue;
    const fullPath = join(currentDir, name);
    const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      await collectFiles(rootDir, fullPath, depth + 1, out);
    } else {
      out.push(relPath);
    }
  }
}

/**
 * Ensure PROJECT_STRUCTURE.md exists and is fresh.
 * Generates and writes it if missing or stale.
 * Returns the file content.
 */
export async function ensureProjectStructureFile(repoRoot: string, staleAfterMs = STALE_MS): Promise<string> {
  const filePath = join(repoRoot, FILE_NAME);

  try {
    const info = await stat(filePath);
    const ageMs = Date.now() - info.mtimeMs;
    if (ageMs < staleAfterMs) {
      // Fresh — return cached content
      return await readFile(filePath, "utf-8");
    }
  } catch {
    // File doesn't exist — generate it
  }

  const content = await generateProjectStructure(repoRoot);
  try {
    await writeFile(filePath, content, "utf-8");
  } catch {
    // Can't write — just return the content without persisting
  }
  return content;
}
