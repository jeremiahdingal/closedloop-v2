import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Json } from "./types.ts";

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export function safeJoin(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
  return resolved;
}

export async function writeJson(filePath: string, value: Json | Record<string, unknown> | unknown[]): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function truncate(value: string, max = 16_000): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + `\n...truncated ${value.length - max} chars`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FuzzyMatchResult {
  index: number;
  matchedLength: number;
}

const normalizeWs = (s: string): string =>
  s.replace(/\r\n/g, "\n").replace(/\t/g, "  ").replace(/[ \t]+$/gm, "");

export function fuzzyMatch(content: string, search: string): FuzzyMatchResult | null {
  const normContent = normalizeWs(content);
  const normSearch = normalizeWs(search);
  const normIndex = normContent.indexOf(normSearch);
  if (normIndex === -1) return null;

  for (let scanStart = Math.max(0, normIndex - 50); scanStart < Math.min(content.length, normIndex + 200); scanStart++) {
    const candidate = content.slice(scanStart, scanStart + search.length + 100);
    const normCandidate = normalizeWs(candidate);
    if (normCandidate.startsWith(normSearch)) {
      let endOffset = 0;
      let normOffset = 0;
      while (normOffset < normSearch.length && scanStart + endOffset < content.length) {
        const ch = content[scanStart + endOffset];
        endOffset++;
        normOffset += normalizeWs(ch).length;
      }
      return { index: scanStart, matchedLength: endOffset };
    }
  }
  return null;
}
