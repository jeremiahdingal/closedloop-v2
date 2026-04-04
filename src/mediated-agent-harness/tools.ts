import path from "node:path";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef, ToolExecutionContext, ToolCall, ToolResult } from "./types.ts";
import { ToolExecutionError } from "./errors.ts";
import { retrieveChunks } from "../rag/retriever.ts";

const execFileAsync = promisify(execFile);

// ─── Tool definitions (OpenAI function-calling format) ──────────────────────

export const WORKSPACE_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "glob_files",
      description: "Find files matching a glob pattern in the workspace. Returns matching file paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern relative to workspace root, e.g. 'src/**/*.ts' or '*.json'"
          }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep_files",
      description: "Search file contents for a pattern using ripgrep. Optionally scope to a subdirectory.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern to search for in file contents"
          },
          scope: {
            type: "string",
            description: "Optional subdirectory to scope the search to, e.g. 'src/'"
          }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories at a given path in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to workspace root. Defaults to root if omitted."
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a single file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to workspace root"
          }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_files",
      description: "Read multiple files at once. Returns a map of path to content.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Array of file paths relative to workspace root"
          }
        },
        required: ["paths"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file in the workspace. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to workspace root"
          },
          content: {
            type: "string",
            description: "File content to write"
          }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_files",
      description: "Write multiple files at once. Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              },
              required: ["path", "content"],
              additionalProperties: false
            },
            description: "Array of file objects with path and content"
          }
        },
        required: ["files"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show the plain workspace diff (unstaged changes).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_diff_staged",
      description: "Show the staged diff (changes added with git add).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show the short git status of the workspace.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_changed_files",
      description: "List file paths that have been modified (from git diff --name-only).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a whitelisted command (e.g. test, lint, typecheck, status). The command name must be in the workspace's available commands.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the whitelisted command to run (e.g. 'test', 'lint', 'typecheck')"
          }
        },
        required: ["name"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_context_packet",
      description: "Read the context.json file from the workspace root. Contains ticket context and workspace metadata.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_artifact",
      description: "Read a previously saved artifact by name or kind.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Artifact name to look up"
          },
          kind: {
            type: "string",
            description: "Artifact kind to filter by"
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_artifact",
      description: "Save a named artifact to the workspace artifacts directory.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Artifact name"
          },
          content: {
            type: "string",
            description: "Artifact content"
          },
          kind: {
            type: "string",
            description: "Optional artifact kind (e.g. 'spec', 'test-output', 'report')"
          }
        },
        required: ["name", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web using Brave Search API. Returns search results with titles, URLs, and snippets. Use this when you need current information not available in the codebase.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query"
          },
          count: {
            type: "number",
            description: "Number of results to return (1-20, default 5)"
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Signal that the task is complete. Provide a summary and the final result as a JSON string.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Brief summary of what was accomplished"
          },
          result: {
            type: "string",
            description: "The final result, as a JSON string matching the expected output schema"
          }
        },
        required: ["summary", "result"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "semantic_search",
      description: "Search the codebase using semantic similarity. Finds conceptually related code and documentation beyond simple text matching. Use when grep doesn't find what you need.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language description of what you're looking for"
          },
          scope: {
            type: "string",
            description: "Optional subdirectory to scope search to"
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  }
];

// ─── Tool name alias map ────────────────────────────────────────────────────

export const TOOL_ALIASES: Record<string, string> = {
  ls: "glob_files",
  find: "glob_files",
  cat: "read_file",
  head: "read_file",
  tail: "read_file",
  touch: "write_file",
  bash: "run_command",
  sh: "run_command",
  shell: "run_command",
  exec: "run_command",
  run: "run_command",
  mkdir: "write_file",
  rm: "run_command",
  cp: "run_command",
  mv: "run_command",
  npm: "run_command",
  npx: "run_command",
  node: "run_command",
  python: "run_command",
  python3: "run_command",
  echo: "run_command",
  tee: "write_file",
  write: "write_file",
  append: "write_file",
  sed: "run_command",
  awk: "run_command",
  sort: "run_command",
  wc: "run_command",
  diff: "git_diff",
  git: "run_command",
  edit: "write_file",
  create: "write_file",
  update: "write_file",
  delete: "run_command",
  search: "grep_files",
  grep: "grep_files",
  rg: "grep_files",
  walk: "glob_files",
  glob: "glob_files",
  tree: "list_dir",
  dir: "list_dir",
  ls_dir: "list_dir",
  search_web: "web_search",
  brave: "web_search",
  websearch: "web_search",
  lookup: "web_search",
  google: "web_search",
};

// ─── Tool execution ─────────────────────────────────────────────────────────

export async function executeToolCall(
  call: ToolCall,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const args = call.args;
  const name = call.name;

  try {
    switch (name) {
      case "glob_files":
        return await execGlobFiles(call.id, args, ctx);
      case "grep_files":
        return await execGrepFiles(call.id, args, ctx);
      case "list_dir":
        return await execListDir(call.id, args, ctx);
      case "read_file":
        return await execReadFile(call.id, args, ctx);
      case "read_files":
        return await execReadFiles(call.id, args, ctx);
      case "write_file":
        return await execWriteFile(call.id, args, ctx);
      case "write_files":
        return await execWriteFiles(call.id, args, ctx);
      case "git_diff":
        return await execGitDiff(call.id, ctx);
      case "git_diff_staged":
        return await execGitDiffStaged(call.id, ctx);
      case "git_status":
        return await execGitStatus(call.id, ctx);
      case "list_changed_files":
        return await execListChangedFiles(call.id, ctx);
      case "run_command":
        return await execRunCommand(call.id, args, ctx);
      case "read_context_packet":
        return await execReadContextPacket(call.id, ctx);
      case "read_artifact":
        return await execReadArtifact(call.id, args, ctx);
      case "save_artifact":
        return await execSaveArtifact(call.id, args, ctx);
      case "web_search":
        return await execWebSearch(call.id, args, ctx);
      case "semantic_search":
        return await execSemanticSearch(call.id, args, ctx);
      case "finish":
        // finish is handled by the loop, not here
        return { callId: call.id, name, output: JSON.stringify(args), isError: false };
      default:
        throw new ToolExecutionError(
          `Unknown tool: ${name}`,
          name,
          call.id
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      callId: call.id,
      name,
      output: `Error: ${message}`,
      isError: true
    };
  }
}

// ─── Individual tool implementations ────────────────────────────────────────

async function execGlobFiles(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "**/*");
  const cwd = ctx.cwd;

  // If the pattern has no glob characters, check if it's a direct file path
  if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) {
    const directPath = path.join(cwd, pattern);
    try {
      const st = await stat(directPath);
      const rel = path.relative(cwd, directPath);
      return {
        callId,
        name: "glob_files",
        output: st.isDirectory() ? `${rel}/` : rel,
        isError: false
      };
    } catch {
      // Not a direct path, fall through to glob matching
    }
  }

  // Use rg (ripgrep) for fast glob if available, fallback to node:fs walk
  const results: string[] = [];
  try {
    const { stdout } = await execFileAsync("rg", [
      "--files",
      "--glob", pattern,
      "--glob", "!.git/**",
      "--glob", "!node_modules/**",
      cwd
    ], { cwd, timeout: 10000, maxBuffer: 1024 * 1024 });
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) results.push(path.relative(cwd, trimmed));
    }
  } catch {
    // Fallback to node:fs recursive walk
    const entries = await readdir(cwd, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(entry.parentPath ?? cwd, entry.name);
      const rel = path.relative(cwd, entryPath);
      if (rel.startsWith(".git") || rel.startsWith("node_modules") || rel.includes(`${path.sep}.git${path.sep}`)) continue;
      if (matchGlob(rel, pattern)) {
        results.push(rel);
      }
    }
  }

  // Limit to first 100 results to avoid overwhelming context
  const limited = results.sort().slice(0, 100);
  return {
    callId,
    name: "glob_files",
    output: limited.length > 0
      ? limited.join("\n")
      : `No files matched the pattern "${pattern}".`,
    isError: false
  };
}

async function execGrepFiles(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  const scope = args.scope ? String(args.scope) : undefined;

  if (!pattern) {
    return { callId, name: "grep_files", output: "Error: pattern is required", isError: true };
  }

  const searchPath = scope ? path.join(ctx.cwd, scope) : ctx.cwd;

  try {
    const { stdout } = await execFileAsync("rg", [
      "--line-number",
      "--no-heading",
      "--max-count", "100",
      "--glob", "!.git/**",
      "--glob", "!node_modules/**",
      pattern,
      searchPath
    ], {
      cwd: ctx.cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });

    const output = stdout.trim();
    return {
      callId,
      name: "grep_files",
      output: output || "No matches found.",
      isError: false
    };
  } catch (err: any) {
    if (err.code === 1) {
      // ripgrep exits 1 when no matches
      return { callId, name: "grep_files", output: "No matches found.", isError: false };
    }
    // rg not available — fallback to node-based search
    return await execGrepFallback(callId, pattern, searchPath, ctx);
  }
}

async function execGrepFallback(
  callId: string,
  pattern: string,
  searchPath: string,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const results: string[] = [];
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "gi");
  } catch {
    return { callId, name: "grep_files", output: `Error: invalid regex: ${pattern}`, isError: true };
  }

  const entries = await readdir(searchPath, { recursive: true, withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (count >= 100) break;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (!entry.isFile()) continue;

    const fullPath = path.join(entry.parentPath ?? searchPath, entry.name);
    const relPath = path.relative(ctx.cwd, fullPath);

    try {
      const content = await readFile(fullPath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && count < 100; i++) {
        if (regex.test(lines[i])) {
          results.push(`${relPath}:${i + 1}:${lines[i].trim()}`);
          count++;
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return {
    callId,
    name: "grep_files",
    output: results.length > 0 ? results.join("\n") : "No matches found."
  };
}

async function execListDir(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const dirPath = args.path ? String(args.path) : ".";
  const fullPath = path.join(ctx.cwd, dirPath);

  try {
    const entries = await readdir(fullPath, { withFileTypes: true });
    const lines = entries
      .filter(e => !e.name.startsWith(".") || dirPath === ".")
      .map(e => {
        const suffix = e.isDirectory() ? "/" : "";
        return `${e.name}${suffix}`;
      })
      .sort();

    return {
      callId,
      name: "list_dir",
      output: lines.length > 0 ? lines.join("\n") : "(empty directory)"
    };
  } catch (err: any) {
    return {
      callId,
      name: "list_dir",
      output: `Error listing directory: ${err.message}`,
      isError: true
    };
  }
}

async function execReadFile(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  if (!filePath) {
    return { callId, name: "read_file", output: "Error: path is required", isError: true };
  }

  const result = await ctx.readFiles([filePath]);
  const content = result[filePath];

  if (content === undefined) {
    return { callId, name: "read_file", output: `Error: file not found: ${filePath}`, isError: true };
  }

  // Truncate large files
  const maxLen = 50000;
  const output = content.length > maxLen
    ? content.slice(0, maxLen) + `\n... [truncated at ${maxLen} chars, file is ${content.length} chars]`
    : content;

  return {
    callId,
    name: "read_file",
    output
  };
}

async function execReadFiles(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const filePaths = (args.paths as string[] ?? []).map(String);
  if (filePaths.length === 0) {
    return { callId, name: "read_files", output: "Error: paths array is required", isError: true };
  }

  const result = await ctx.readFiles(filePaths);
  const parts: string[] = [];

  for (const fp of filePaths) {
    const content = result[fp];
    if (content === undefined) {
      parts.push(`--- ${fp} ---\n(Error: file not found)`);
    } else {
      const maxLen = 30000;
      const output = content.length > maxLen
        ? content.slice(0, maxLen) + `\n... [truncated]`
        : content;
      parts.push(`--- ${fp} ---\n${output}`);
    }
  }

  return { callId, name: "read_files", output: parts.join("\n\n") };
}

async function execWriteFile(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  const content = String(args.content ?? "");

  if (!filePath) {
    return { callId, name: "write_file", output: "Error: path is required", isError: true };
  }

  // Safety: block writes to .git and node_modules
  if (filePath.startsWith(".git/") || filePath.includes("/.git/") ||
      filePath.startsWith("node_modules/") || filePath.includes("/node_modules/")) {
    return {
      callId,
      name: "write_file",
      output: "Error: writes to .git/ and node_modules/ are forbidden",
      isError: true
    };
  }

  await ctx.writeFiles([{ path: filePath, content }]);
  return {
    callId,
    name: "write_file",
    output: `Wrote ${filePath} (${content.length} chars)`
  };
}

async function execWriteFiles(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const files = (args.files as Array<{ path: string; content: string }> ?? []);
  if (files.length === 0) {
    return { callId, name: "write_files", output: "Error: files array is required", isError: true };
  }

  // Safety check
  for (const f of files) {
    if (f.path.startsWith(".git/") || f.path.includes("/.git/") ||
        f.path.startsWith("node_modules/") || f.path.includes("/node_modules/")) {
      return {
        callId,
        name: "write_files",
        output: `Error: writes to .git/ and node_modules/ are forbidden (got: ${f.path})`,
        isError: true
      };
    }
  }

  await ctx.writeFiles(files);
  const summary = files.map(f => `${f.path} (${f.content.length} chars)`).join(", ");
  return {
    callId,
    name: "write_files",
    output: `Wrote ${files.length} files: ${summary}`
  };
}

async function execGitDiff(
  callId: string,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const diff = await ctx.gitDiff();
  const maxLen = 30000;
  const output = diff.length > maxLen
    ? diff.slice(0, maxLen) + `\n... [truncated, diff is ${diff.length} chars]`
    : diff || "(no changes)";

  return { callId, name: "git_diff", output };
}

async function execGitDiffStaged(
  callId: string,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (ctx.gitDiffStaged) {
    const diff = await ctx.gitDiffStaged();
    return { callId, name: "git_diff_staged", output: diff || "(no staged changes)" };
  }

  // Fallback: direct git exec
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--staged"], {
      cwd: ctx.cwd,
      timeout: 10000
    });
    return { callId, name: "git_diff_staged", output: stdout.trim() || "(no staged changes)" };
  } catch (err: any) {
    return { callId, name: "git_diff_staged", output: `Error: ${err.message}`, isError: true };
  }
}

async function execGitStatus(
  callId: string,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const status = await ctx.gitStatus();
  return { callId, name: "git_status", output: status || "(clean working tree)" };
}

async function execListChangedFiles(
  callId: string,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const diff = await ctx.gitDiff();
  if (!diff) {
    return { callId, name: "list_changed_files", output: "(no changed files)" };
  }

  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      if (match) files.add(match[2]);
    }
  }

  return {
    callId,
    name: "list_changed_files",
    output: files.size > 0 ? [...files].sort().join("\n") : "(no changed files)"
  };
}

async function execRunCommand(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const name = String(args.name ?? "");
  if (!name) {
    return { callId, name: "run_command", output: "Error: name is required", isError: true };
  }

  const result = await ctx.runNamedCommand(name);
  const output = [
    result.stdout.trim(),
    result.stderr.trim(),
    result.exitCode !== 0 ? `\nExit code: ${result.exitCode}` : ""
  ].filter(Boolean).join("\n");

  return {
    callId,
    name: "run_command",
    output: output || "(no output)",
    isError: result.exitCode !== 0
  };
}

async function execReadContextPacket(
  callId: string,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const contextPath = path.join(ctx.cwd, "context.json");
  try {
    const content = await readFile(contextPath, "utf-8");
    return { callId, name: "read_context_packet", output: content };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { callId, name: "read_context_packet", output: "(no context.json found)" };
    }
    return { callId, name: "read_context_packet", output: `Error: ${err.message}`, isError: true };
  }
}

async function execReadArtifact(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (!ctx.readArtifact) {
    return { callId, name: "read_artifact", output: "Error: readArtifact not available in this context", isError: true };
  }

  const name = args.name ? String(args.name) : undefined;
  const kind = args.kind ? String(args.kind) : undefined;

  const content = await ctx.readArtifact({ name, kind });
  if (content === null) {
    return { callId, name: "read_artifact", output: "(artifact not found)" };
  }

  return { callId, name: "read_artifact", output: content };
}

async function execSaveArtifact(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const name = String(args.name ?? "");
  const content = String(args.content ?? "");
  const kind = args.kind ? String(args.kind) : undefined;

  if (!name || !content) {
    return { callId, name: "save_artifact", output: "Error: name and content are required", isError: true };
  }

  const artifactPath = await ctx.saveArtifact({ name, content, kind });
  return {
    callId,
    name: "save_artifact",
    output: `Saved artifact: ${name} → ${artifactPath}`
  };
}

async function execWebSearch(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const query = String(args.query ?? "");
  const count = Math.min(Math.max(Number(args.count ?? 5), 1), 20);

  if (!query) {
    return { callId, name: "web_search", output: "Error: query is required", isError: true };
  }

  const apiKey = ctx.braveApiKey ?? process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return {
      callId,
      name: "web_search",
      output: "Error: Brave Search API key not configured. Set BRAVE_API_KEY in .env",
      isError: true
    };
  }

  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    const response = await fetch(url.toString(), {
      headers: {
        "X-Subscription-Token": apiKey,
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        callId,
        name: "web_search",
        output: `Error: Brave API returned ${response.status}: ${body.slice(0, 200)}`,
        isError: true
      };
    }

    const data: any = await response.json();
    const results = data.web?.results ?? [];

    if (results.length === 0) {
      return { callId, name: "web_search", output: "No results found." };
    }

    const lines = results.map((r: any, i: number) => {
      const title = r.title ?? "Untitled";
      const url = r.url ?? "";
      const snippet = r.description ?? "";
      return `${i + 1}. ${title}\n   ${url}\n   ${snippet}`;
    });

    return {
      callId,
      name: "web_search",
      output: `Search results for "${query}":\n\n${lines.join("\n\n")}`,
      isError: false
    };
  } catch (err: any) {
    return {
      callId,
      name: "web_search",
      output: `Error: ${err.message}`,
      isError: true
    };
  }
}

async function execSemanticSearch(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const query = String(args.query ?? "");
  const scope = args.scope ? String(args.scope) : undefined;

  if (!query) {
    return {
      callId,
      name: "semantic_search",
      output: "Error: query is required",
      isError: true
    };
  }

  // If no RAG index available, fall back to grep
  if (!ctx.ragIndexId || !ctx.db) {
    return await execGrepFiles(callId, { pattern: query.split(/\s+/).slice(0, 3).join("|"), scope }, ctx);
  }

  try {
    const chunks = await retrieveChunks({
      query,
      db: ctx.db,
      indexId: ctx.ragIndexId,
      topK: 10,
      scopePaths: scope ? [scope] : undefined,
      maxTokens: 6000,
      model: ctx.embeddingModel,
      baseUrl: ctx.embeddingBaseUrl
    });

    if (chunks.length === 0) {
      return {
        callId,
        name: "semantic_search",
        output: "No semantically similar code found.",
        isError: false
      };
    }

    const formatted = chunks
      .map(
        (c, i) =>
          `${i + 1}. ${c.filePath}${c.startLine ? `:${c.startLine}` : ""} [${c.chunkType}] (score: ${c.score.toFixed(3)})\n${c.content.slice(0, 2000)}`
      )
      .join("\n\n");

    return {
      callId,
      name: "semantic_search",
      output: formatted,
      isError: false
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      callId,
      name: "semantic_search",
      output: `Error: ${msg}. Falling back to text search.`,
      isError: true
    };
  }
}

// ─── Simple glob matching fallback ──────────────────────────────────────────

function matchGlob(filePath: string, pattern: string): boolean {
  // Convert simple glob to regex
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*")
    .replace(/\?/g, "[^/]");

  return new RegExp(`^${regex}$`).test(filePath);
}
