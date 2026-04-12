/**
 * Project Structure Generator
 * Stores the generated snapshot inside the target repo at .closedloop/PROJECT_STRUCTURE.md.
 * The file is seeded only when missing so user-managed content is not overwritten.
 * When generating new content, it asks local Ollama (qwen3.5:9b by default) to
 * infer project-specific guidance instead of using a hardcoded framework template.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SKIP_NAME_PATTERNS = /node_modules|\.git|\.next|dist|build|\.env|\.lock|__pycache__|\.yarn|cache|tmp|\.temp|coverage|out/;
const SKIP_RELATIVE_PATH_PATTERNS = /^(\.closedloop|data\/workspaces|data\/artifacts)(\/|$)/;
const MAX_DEPTH = 3;
const CLOSED_LOOP_DIR = ".closedloop";
const FILE_NAME = "PROJECT_STRUCTURE.md";
const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const DEFAULT_PROJECT_STRUCTURE_MODEL = process.env.PROJECT_STRUCTURE_MODEL || "qwen3.5:9b";

export function getProjectStructurePath(repoRoot: string): string {
  return join(repoRoot, CLOSED_LOOP_DIR, FILE_NAME);
}

/**
 * Generate ONLY the directory tree and file index strings.
 */
export async function generateTreeAndIndex(repoRoot: string): Promise<string> {
  const lines: string[] = [];

  lines.push("## Directory Tree", "");
  const treeLines: string[] = [];
  await buildTree(repoRoot, repoRoot, 0, treeLines);
  lines.push(...treeLines, "");

  lines.push("## File Index", "");
  const allFiles: string[] = [];
  await collectFiles(repoRoot, repoRoot, 0, allFiles);
  for (const filePath of allFiles) lines.push(`- ${filePath}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate markdown project structure for a repo root (full file).
 */
export async function generateProjectStructure(repoRoot: string): Promise<string> {
  const body = await generateTreeAndIndex(repoRoot);
  const adaptivePrefix = await generateAdaptiveProjectStructurePrefix(repoRoot, body);

  return [
    "# Project Structure",
    "",
    `Generated from: ${repoRoot}`,
    "",
    adaptivePrefix.trim(),
    "",
    "<!-- START_GENERATED_TREE -->",
    body,
    "<!-- END_GENERATED_TREE -->",
    "",
  ].join("\n");
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
    .filter((entry) => !shouldSkipEntry(rootDir, join(currentDir, String(entry.name)), String(entry.name)))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return String(a.name).localeCompare(String(b.name));
    });

  const prefix = "  ".repeat(depth);
  for (const entry of filtered) {
    const name = String(entry.name);
    const icon = entry.isDirectory() ? "[DIR]" : "[FILE]";
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
    const fullPath = join(currentDir, name);
    if (shouldSkipEntry(rootDir, fullPath, name)) continue;
    const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      await collectFiles(rootDir, fullPath, depth + 1, out);
    } else {
      out.push(relPath);
    }
  }
}

export async function writeProjectStructureIfMissing(repoRoot: string): Promise<{
  filePath: string;
  written: boolean;
  content: string;
}> {
  const filePath = getProjectStructurePath(repoRoot);

  try {
    const content = await readFile(filePath, "utf-8");
    return { filePath, written: false, content };
  } catch {
    const content = await generateProjectStructure(repoRoot);
    await mkdir(join(repoRoot, CLOSED_LOOP_DIR), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return { filePath, written: true, content };
  }
}

export async function writeProjectStructure(repoRoot: string): Promise<{
  filePath: string;
  content: string;
}> {
  const filePath = getProjectStructurePath(repoRoot);
  const content = await generateProjectStructure(repoRoot);
  await mkdir(join(repoRoot, CLOSED_LOOP_DIR), { recursive: true });
  await writeFile(filePath, content, "utf-8");
  return { filePath, content };
}

/**
 * Ensure the project-structure file exists in .closedloop without overwriting it.
 * Returns the existing or newly generated content.
 */
export async function ensureProjectStructureFile(repoRoot: string): Promise<string> {
  const result = await writeProjectStructureIfMissing(repoRoot);
  return result.content;
}

async function generateAdaptiveProjectStructurePrefix(repoRoot: string, treeAndIndex: string): Promise<string> {
  try {
    const prompt = await buildAdaptivePrompt(repoRoot, treeAndIndex);
    const response = await fetch(`${DEFAULT_OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_PROJECT_STRUCTURE_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.2,
          top_p: 0.9,
          top_k: 40,
          num_ctx: 16384
        }
      })
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json() as { response?: string };
    const prefix = sanitizeAdaptivePrefix(payload.response || "");
    if (!prefix) throw new Error("Adaptive prefix generation returned empty content.");
    return prefix;
  } catch {
    return buildFallbackPrefix();
  }
}

async function buildAdaptivePrompt(repoRoot: string, treeAndIndex: string): Promise<string> {
  const packageJson = await readOptionalFile(join(repoRoot, "package.json"), 8000);
  const readme = await readOptionalFile(join(repoRoot, "README.md"), 12000);

  return [
    "You are writing the preamble for a repository's PROJECT_STRUCTURE.md file.",
    "Infer the real stack and conventions from the provided context.",
    "Do not assume any specific framework unless the repository context supports it.",
    "Write concise Markdown for these sections only, in this order:",
    "## Styling And UI Rules",
    "## Elements And Component Rules",
    "## Review Contract",
    "## REVIEW_CONTRACT",
    "The REVIEW_CONTRACT section must contain a fenced JSON object with keys:",
    "schemaSources, derivedSchemas, generatedReadOnlyPaths, folderOwnership, strictFolderBoundaries",
    "Use conservative defaults when there is not enough evidence.",
    "Do not include the top-level title, Generated from line, or START/END_GENERATED_TREE markers.",
    "Do not wrap the whole answer in a Markdown code fence.",
    "",
    `Repo root: ${repoRoot}`,
    "",
    "## package.json",
    packageJson || "(missing)",
    "",
    "## README excerpt",
    readme || "(missing)",
    "",
    "## Directory Tree And File Index Excerpt",
    treeAndIndex.slice(0, 12000)
  ].join("\n");
}

function sanitizeAdaptivePrefix(raw: string): string {
  const cleaned = raw
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  if (!cleaned.includes("## Styling And UI Rules")) return "";
  if (!cleaned.includes("## Elements And Component Rules")) return "";
  if (!cleaned.includes("## REVIEW_CONTRACT")) return "";
  return normalizeReviewContractSection(cleaned);
}

function buildFallbackPrefix(): string {
  return [
    "## Styling And UI Rules",
    "",
    "- Preserve the existing design system, styling conventions, and visual language.",
    "- Prefer extending existing shared tokens, themes, spacing, typography, and component variants over introducing ad hoc styles.",
    "- Reuse existing UI primitives and shared components before creating new ones.",
    "- Match the styling patterns already used in the surrounding feature area.",
    "",
    "## Elements And Component Rules",
    "",
    "- Follow the project's established component primitives, wrapper patterns, and framework conventions.",
    "- Use the native UI stack already present in the target files instead of mixing incompatible element systems.",
    "- Do not introduce raw HTML tags in files that are clearly mobile-only or built on non-DOM UI primitives.",
    "- Keep component APIs compatible with existing app patterns, navigation, and state conventions.",
    "",
    "## Review Contract",
    "",
    "The reviewer and builder should treat the following contract as the source of truth when present.",
    "",
    "## REVIEW_CONTRACT",
    "```json",
    "{",
    '  "schemaSources": [],',
    '  "derivedSchemas": [],',
    '  "generatedReadOnlyPaths": [],',
    '  "folderOwnership": [],',
    '  "strictFolderBoundaries": false',
    "}",
    "```",
  ].join("\n");
}

async function readOptionalFile(filePath: string, maxChars: number): Promise<string> {
  try {
    const content = await readFile(filePath, "utf-8");
    return content.slice(0, maxChars);
  } catch {
    return "";
  }
}

function normalizeReviewContractSection(markdown: string): string {
  const contractMatch = markdown.match(/## REVIEW_CONTRACT\s*```json\s*([\s\S]*?)\s*```/i);
  if (!contractMatch) {
    return replaceOrAppendReviewContract(markdown, defaultReviewContractBlock());
  }

  try {
    const parsed = JSON.parse(contractMatch[1].trim()) as Record<string, unknown>;
    const normalized = JSON.stringify({
      schemaSources: Array.isArray(parsed.schemaSources) ? parsed.schemaSources.filter((v) => typeof v === "string") : [],
      derivedSchemas: Array.isArray(parsed.derivedSchemas) ? parsed.derivedSchemas : [],
      generatedReadOnlyPaths: Array.isArray(parsed.generatedReadOnlyPaths) ? parsed.generatedReadOnlyPaths.filter((v) => typeof v === "string") : [],
      folderOwnership: Array.isArray(parsed.folderOwnership) ? parsed.folderOwnership : [],
      strictFolderBoundaries: parsed.strictFolderBoundaries === true
    }, null, 2);
    return markdown.replace(/## REVIEW_CONTRACT\s*```json\s*([\s\S]*?)\s*```/i, `## REVIEW_CONTRACT\n\`\`\`json\n${normalized}\n\`\`\``);
  } catch {
    return replaceOrAppendReviewContract(markdown, defaultReviewContractBlock());
  }
}

function replaceOrAppendReviewContract(markdown: string, reviewContractBlock: string): string {
  if (/## REVIEW_CONTRACT\b/i.test(markdown)) {
    return markdown.replace(/## REVIEW_CONTRACT[\s\S]*$/i, reviewContractBlock);
  }
  return `${markdown.trim()}\n\n${reviewContractBlock}`;
}

function defaultReviewContractBlock(): string {
  return [
    "## REVIEW_CONTRACT",
    "```json",
    "{",
    '  "schemaSources": [],',
    '  "derivedSchemas": [],',
    '  "generatedReadOnlyPaths": [],',
    '  "folderOwnership": [],',
    '  "strictFolderBoundaries": false',
    "}",
    "```"
  ].join("\n");
}

function shouldSkipEntry(rootDir: string, fullPath: string, name: string): boolean {
  if (SKIP_NAME_PATTERNS.test(name)) return true;
  const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
  return SKIP_RELATIVE_PATH_PATTERNS.test(relPath);
}
