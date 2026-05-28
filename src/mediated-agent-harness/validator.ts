import type { ToolCall, ToolDef, CompleteToolCall } from "./types.ts";
import { ToolValidationError, StagnationError } from "./errors.ts";
import { TOOL_ALIASES } from "./tools.ts";

// ─── Call history for stagnation detection ──────────────────────────────────

export interface CallRecord {
  name: string;
  argsHash: string;
  isError: boolean;
  timestamp: number;
}

const PATH_TOOLS = new Set([
  "read_file", "read_files", "write_file", "write_files",
  "search_replace", "list_dir", "glob_files", "grep_files",
]);

export class CallHistory {
  private records: CallRecord[] = [];
  private consecutiveErrors = 0;
  private recentPaths: string[] = [];
  private readPaths: string[] = [];
  private errorMessages: Map<string, string> = new Map();

  record(name: string, args: Record<string, unknown>, isError: boolean, errorMsg?: string): void {
    const argsHash = stableStringify(args);
    this.records.push({ name, argsHash, isError, timestamp: Date.now() });

    if (isError) {
      this.consecutiveErrors++;
      if (errorMsg) {
        this.errorMessages.set(`${name}:${argsHash}`, errorMsg);
      }
    } else {
      this.consecutiveErrors = 0;
    }

    if (!isError && PATH_TOOLS.has(name)) {
      const p = extractPathFromArgs(name, args);
      if (p) {
        this.recentPaths.push(p);
        if (this.recentPaths.length > 10) this.recentPaths.shift();
      }
      if (name === "read_file" || name === "read_files") {
        const p = extractPathFromArgs(name, args);
        if (p) {
          this.readPaths.push(p);
          if (this.readPaths.length > 10) this.readPaths.shift();
        }
      }
    }
  }

  getConsecutiveErrors(): number {
    return this.consecutiveErrors;
  }

  hasRepeatedCalls(maxRepeats: number): boolean {
    if (this.records.length < maxRepeats) return false;

    const lastN = this.records.slice(-maxRepeats);
    const first = lastN[0];
    return lastN.every(r => r.name === first.name && r.argsHash === first.argsHash);
  }

  hasNoProgress(maxWindow: number): boolean {
    if (this.records.length < maxWindow) return false;

    // No progress = all errors in the last N calls
    const lastN = this.records.slice(-maxWindow);
    return lastN.every(r => r.isError);
  }

  getRecentCalls(count: number): CallRecord[] {
    return this.records.slice(-count);
  }

  getRecentPaths(): string[] {
    return [...this.recentPaths];
  }

  getLastReadPath(): string | null {
    return this.readPaths.length > 0 ? this.readPaths[this.readPaths.length - 1] : null;
  }

  getErrorMessage(name: string, argsHash: string): string | undefined {
    return this.errorMessages.get(`${name}:${argsHash}`);
  }

  getErrorMessages(): Map<string, string> {
    return this.errorMessages;
  }

  reset(): void {
    this.records = [];
    this.consecutiveErrors = 0;
    this.recentPaths = [];
    this.readPaths = [];
  }
}

// ─── Path extraction helper ─────────────────────────────────────────────────

function extractPathFromArgs(name: string, args: Record<string, unknown>): string | null {
  if (name === "read_files") {
    const paths = args.paths;
    if (Array.isArray(paths) && paths.length > 0) return String(paths[0]);
  }
  if (name === "write_files") {
    const files = args.files;
    if (Array.isArray(files) && files[0]?.path) return String(files[0].path);
  }
  if (args.path && typeof args.path === "string") return args.path;
  if (args.pattern && typeof args.pattern === "string") return args.pattern;
  return null;
}

// ─── Path inference ──────────────────────────────────────────────────────────

export interface PathInferenceContext {
  recentPaths: string[];
  lastReadPath: string | null;
}

function looksLikeFilePath(value: string): boolean {
  if (!value) return false;
  return /[./\\]/.test(value) && !value.includes("*") && !value.includes("|");
}

function tryInferPath(
  toolName: string,
  args: Record<string, unknown>,
  missingParam: string,
  ctx: PathInferenceContext,
): Record<string, unknown> | null {
  const { recentPaths, lastReadPath } = ctx;
  const lastPath = recentPaths.length > 0 ? recentPaths[recentPaths.length - 1] : null;

  switch (toolName) {
    case "read_file": {
      if (missingParam === "path") {
        // Model confused params: passed pattern instead of path
        if (args.pattern && typeof args.pattern === "string" && looksLikeFilePath(args.pattern)) {
          return { ...args, path: args.pattern };
        }
        // Use most recent path
        if (lastPath && looksLikeFilePath(lastPath)) {
          return { ...args, path: lastPath };
        }
      }
      break;
    }

    case "write_file": {
      if (missingParam === "path") {
        // Only infer if content is present (model knows what to write, just forgot where)
        if (args.content && lastPath && looksLikeFilePath(lastPath)) {
          return { ...args, path: lastPath };
        }
      }
      break;
    }

    case "search_replace": {
      if (missingParam === "path") {
        // search/replace needs the file that was last read
        if ((args.search || args.replace) && lastReadPath && looksLikeFilePath(lastReadPath)) {
          return { ...args, path: lastReadPath };
        }
        if ((args.search || args.replace) && lastPath && looksLikeFilePath(lastPath)) {
          return { ...args, path: lastPath };
        }
      }
      break;
    }

    case "glob_files": {
      if (missingParam === "pattern") {
        // Model swapped: passed path instead of pattern
        if (args.path && typeof args.path === "string") {
          return { ...args, pattern: args.path };
        }
      }
      break;
    }

    case "grep_files": {
      if (missingParam === "pattern") {
        // Model passed regex in scope instead of pattern
        if (args.scope && typeof args.scope === "string" && /[|*(+]/.test(args.scope)) {
          return { ...args, pattern: args.scope };
        }
      }
      break;
    }

    case "list_dir": {
      if (missingParam === "path") {
        // list_dir path is optional, default to "."
        return { ...args, path: "." };
      }
      break;
    }
  }

  return null;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface ValidationInput {
  name: string;
  arguments: string; // raw JSON string from model
}

export interface ValidatedCall {
  name: string;
  args: Record<string, unknown>;
}

const BLOCKED_WRITE_PATHS = [
  ".git",
  "node_modules",
  "/etc",
  "/proc",
  "/sys",
  "C:\\Windows",
  "C:\\Program Files",
];

export function validateAndRepair(
  input: ValidationInput,
  knownTools: Map<string, ToolDef>,
  history: CallHistory,
  allowedPaths: string[],
  inferCtx?: PathInferenceContext
): ValidatedCall | ToolValidationError | StagnationError {
  const iterationCount = history.getRecentCalls(Infinity).length;

  // 1. Check stagnation
  if (history.hasRepeatedCalls(10)) {
    return new StagnationError(
      `Tool "${input.name}" called with identical arguments 10 times in a row`,
      iterationCount,
      "repeated_call"
    );
  }

  if (history.getConsecutiveErrors() >= 5) {
    return new StagnationError(
      "5 consecutive tool errors — aborting",
      iterationCount,
      "consecutive_errors"
    );
  }

  if (history.hasNoProgress(3)) {
    return new StagnationError(
      "No tool results in the last 3 calls — aborting",
      iterationCount,
      "no_progress"
    );
  }

  // 2. Remap aliases
  let name = input.name?.trim() ?? "";
  if (TOOL_ALIASES[name]) {
    name = TOOL_ALIASES[name];
  }

  // 2b. Handle empty or whitespace-only name
  if (!name) {
    return new ToolValidationError(
      "Tool call has no name — model emitted a tool call without specifying which tool",
      "",
      input.arguments,
      `Available tools: ${[...knownTools.keys()].join(", ")}`
    );
  }

  // 3. Check tool exists
  if (!knownTools.has(name)) {
    return new ToolValidationError(
      `Unknown tool: ${input.name}`,
      input.name,
      input.arguments,
      `Available tools: ${[...knownTools.keys()].join(", ")}`
    );
  }

  // 4. Parse arguments
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(input.arguments);
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new Error("arguments must be an object");
    }
  } catch (err) {
    // Try basic repair
    const repaired = repairJson(input.arguments);
    if (repaired) {
      args = repaired;
    } else {
      return new ToolValidationError(
        `Invalid JSON arguments: ${err instanceof Error ? err.message : String(err)}`,
        name,
        input.arguments,
        "Arguments must be a valid JSON object"
      );
    }
  }

  // 5. Validate required parameters — with path inference repair
  const toolDef = knownTools.get(name)!;
  const requiredParams = toolDef.function.parameters.required ?? [];
  for (const param of requiredParams) {
    if (args[param] === undefined || args[param] === null) {
      // Try to infer the missing parameter before rejecting
      if (inferCtx) {
        const repaired = tryInferPath(name, args, param, inferCtx);
        if (repaired) {
          console.log(`[PATH-REPAIR] ${name}: inferred missing "${param}" → "${repaired[param]}"`);
          args = repaired;
          continue;
        }
      }

      const example = buildExampleCall(name, toolDef);
      const paramDesc = (toolDef.function.parameters.properties[param] as any)?.description ?? "";
      return new ToolValidationError(
        `Missing required parameter: ${param} for ${name}. Parameter "${param}": ${paramDesc || `(${typeof args[param]})`}. Example: Call ${name} with: ${example}`,
        name,
        input.arguments,
        `Call ${name} with: ${example}`
      );
    }
  }

  // 5b. Validate argument types against schema
  const typeError = validateArgTypes(name, args, toolDef);
  if (typeError) return typeError;

  // 6. Path policy checks for file-related tools
  if (hasPathArg(name)) {
    const pathArg = getPathArg(name, args);
    if (pathArg) {
      const pathError = checkPathPolicy(pathArg, allowedPaths);
      if (pathError) return pathError;
    }

    // Check for files array (write_files)
    if (name === "write_files" && Array.isArray(args.files)) {
      for (const file of args.files) {
        if (file && typeof file.path === "string") {
          const pathError = checkPathPolicy(file.path, allowedPaths);
          if (pathError) return pathError;
        }
      }
    }
  }

  return { name, args };
}

// ─── Path policy ────────────────────────────────────────────────────────────

function hasPathArg(toolName: string): boolean {
  return [
    "read_file", "read_files", "write_file", "write_files",
    "list_dir", "glob_files", "grep_files", "save_artifact"
  ].includes(toolName);
}

function getPathArg(toolName: string, args: Record<string, unknown>): string | null {
  // Check for both 'path' and 'paths'
  let rawPath = args.path || args.paths;
  if (Array.isArray(rawPath)) rawPath = rawPath[0];
  
  const pathStr = typeof rawPath === "string" ? rawPath : null;

  switch (toolName) {
    case "read_file":
    case "write_file":
    case "list_dir":
    case "remove_file":
      return pathStr;
    case "read_files":
      return pathStr; // Already handled above
    case "write_files":
      return Array.isArray(args.files) && args.files[0]?.path ? args.files[0].path : null;
    case "glob_files":
    case "grep_files":
      return null;
    case "save_artifact":
      return null;
    default:
      return null;
  }
}

function checkPathPolicy(
  filePath: string,
  allowedPaths: string[]
): ToolValidationError | null {
  // Normalize
  const normalized = filePath.replace(/\\/g, "/");

  // Block absolute paths
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return new ToolValidationError(
      `Absolute paths are forbidden: ${filePath}`,
      "",
      filePath,
      "Use relative paths within the workspace"
    );
  }

  // Block parent traversal
  if (normalized.includes("..")) {
    return new ToolValidationError(
      `Parent traversal is forbidden: ${filePath}`,
      "",
      filePath,
      "Stay within the workspace directory"
    );
  }

  // Block writes to .git and node_modules
  for (const blocked of BLOCKED_WRITE_PATHS) {
    const normalizedBlocked = blocked.replace(/\\/g, "/");
    if (
      normalized === normalizedBlocked ||
      normalized.startsWith(normalizedBlocked + "/") ||
      normalized.startsWith(normalizedBlocked + "\\")
    ) {
      return new ToolValidationError(
        `Writes to ${blocked} are forbidden: ${filePath}`,
        "",
        filePath,
        `${blocked} is protected`
      );
    }
  }

  // Check allowed paths if configured
  if (allowedPaths.length > 0 && !allowedPaths.includes("*")) {
    const isAllowed = allowedPaths.some(prefix => {
      const norm = prefix.replace(/\\/g, "/");
      return normalized === norm || normalized.startsWith(norm.endsWith("/") ? norm : norm + "/");
    });
    if (!isAllowed) {
      return new ToolValidationError(
        `Path not allowed by policy: ${filePath}`,
        "",
        filePath,
        `Allowed paths: ${allowedPaths.join(", ")}`
      );
    }
  }

  return null;
}

// ─── JSON repair ────────────────────────────────────────────────────────────

function repairJson(raw: string): Record<string, unknown> | null {
  let repaired = raw.trim();

  // 1. Remove markdown code blocks if present
  repaired = repaired.replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1").trim();

  // 2. Basic single quote to double quote conversion
  // Only if it looks like a JSON-ish string
  if (repaired.includes("'")) {
    // This is risky but often helpful for small models
    // Convert 'key': 'value' or 'key': "value"
    repaired = repaired.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
  }

  // 3. Handle unquoted keys (e.g. { path: "..." } instead of { "path": "..." })
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');

  // 4. Remove trailing commas
  repaired = repaired.replace(/,(\s*[}\]])/g, "$1");

  // 5. Count braces/brackets
  let opens = 0;
  let closes = 0;
  for (const ch of repaired) {
    if (ch === "{" || ch === "[") opens++;
    if (ch === "}" || ch === "]") closes++;
  }

  // 6. Close unclosed structures
  const diff = opens - closes;
  for (let i = 0; i < diff; i++) {
    const lastBrace = repaired.lastIndexOf("{");
    const lastBracket = repaired.lastIndexOf("[");
    if (lastBrace > lastBracket) {
      repaired += "}";
    } else {
      repaired += "]";
    }
  }

  try {
    const parsed = JSON.parse(repaired);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Final attempt: find the first { and last }
    const start = repaired.indexOf("{");
    const end = repaired.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const slice = repaired.slice(start, end + 1);
        const parsed = JSON.parse(slice);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {}
    }
  }

  return null;
}

// ─── Argument type validation ───────────────────────────────────────────────

function validateArgTypes(
  toolName: string,
  args: Record<string, unknown>,
  toolDef: ToolDef
): ToolValidationError | null {
  const properties = toolDef.function.parameters.properties;

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;

    const propSchema = properties[key];
    if (!propSchema) continue; // unknown param, let the tool handle it

    const expectedType = propSchema.type;
    const actualType = Array.isArray(value) ? "array" : typeof value;

    if (expectedType === "string" && actualType !== "string") {
      return new ToolValidationError(
        `Parameter "${key}" must be a string, got ${actualType}`,
        toolName,
        JSON.stringify(args),
        `Expected: ${key}: string`
      );
    }

    if (expectedType === "number" && actualType !== "number") {
      return new ToolValidationError(
        `Parameter "${key}" must be a number, got ${actualType}`,
        toolName,
        JSON.stringify(args),
        `Expected: ${key}: number`
      );
    }

    if (expectedType === "boolean" && actualType !== "boolean") {
      return new ToolValidationError(
        `Parameter "${key}" must be a boolean, got ${actualType}`,
        toolName,
        JSON.stringify(args),
        `Expected: ${key}: boolean`
      );
    }

    if (expectedType === "array" && actualType !== "array") {
      return new ToolValidationError(
        `Parameter "${key}" must be an array, got ${actualType}`,
        toolName,
        JSON.stringify(args),
        `Expected: ${key}: array`
      );
    }
  }

  return null;
}

// ─── Deterministic JSON stringify for hashing ───────────────────────────────

export function stableStringify(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, key) => {
    const val = obj[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      acc[key] = JSON.parse(stableStringify(val as Record<string, unknown>));
    } else {
      acc[key] = val;
    }
    return acc;
  }, {});
  return JSON.stringify(sorted);
}

function buildExampleCall(toolName: string, toolDef: ToolDef): string {
  const props = toolDef.function.parameters.properties;
  const example: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(props)) {
    const desc = ((schema as any).description ?? "").toLowerCase();
    const type = (schema as any).type;
    if (type === "array") {
      const itemDesc = ((schema as any).items?.description ?? "").toLowerCase();
      if (itemDesc.includes("path") || key === "paths") (example as any)[key] = ["file1.ts", "file2.ts"];
      else if (itemDesc.includes("glob") || key === "patterns") (example as any)[key] = ["src/**/*.ts"];
      else (example as any)[key] = ["value"];
    } else if (type === "string") {
      if (desc.includes("glob") || key === "pattern") example[key] = "src/**/*.ts";
      else if (desc.includes("path")) example[key] = "src/main.ts";
      else if (desc.includes("search") || desc.includes("query")) example[key] = "search term";
      else if (desc.includes("content") || desc.includes("text") || desc.includes("code")) example[key] = "your content here";
      else if (desc.includes("command")) example[key] = "npm test";
      else if (desc.includes("summary")) example[key] = "brief summary";
      else if (desc.includes("result")) example[key] = "result data";
      else if (desc.includes("url")) example[key] = "https://example.com";
      else if (desc.includes("message") || desc.includes("reason")) example[key] = "explanation";
      else example[key] = "value";
    } else if (type === "boolean") {
      (example as any)[key] = true;
    } else if (type === "number") {
      (example as any)[key] = 1;
    } else {
      example[key] = "value";
    }
  }
  return JSON.stringify(example);
}