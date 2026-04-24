import path from "node:path";
import { readFile, readdir, stat, writeFile, mkdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef, ToolExecutionContext, ToolCall, ToolResult } from "./types.ts";
import { ToolExecutionError } from "./errors.ts";
import { retrieveChunks } from "../rag/retriever.ts";
import { fuzzyMatch } from "../utils.ts";
import { chromium, type Browser, type Page, type BrowserContext } from "playwright";

const execFileAsync = promisify(execFile);

// Read-before-write tracking: maps cwd -> Set of file paths read this session
const filesReadBySession = new Map<string, Set<string>>();

export function trackFileRead(cwd: string, filePath: string): void {
  let set = filesReadBySession.get(cwd);
  if (!set) { set = new Set(); filesReadBySession.set(cwd, set); }
  set.add(filePath);
}

export function hasFileBeenRead(cwd: string, filePath: string): boolean {
  return filesReadBySession.get(cwd)?.has(filePath) ?? false;
}

export function resetSessionTracking(cwd: string): void {
  filesReadBySession.delete(cwd);
}

// Browser state management
const browserState = new Map<string, { browser: Browser; context: BrowserContext; page: Page }>();

function getBrowserState(workspaceId: string) {
  return browserState.get(workspaceId);
}

function setBrowserState(workspaceId: string, state: { browser: Browser; context: BrowserContext; page: Page }) {
  browserState.set(workspaceId, state);
}

function clearBrowserState(workspaceId: string) {
  const state = browserState.get(workspaceId);
  if (state) {
    state.context.close().catch(() => {});
    state.browser.close().catch(() => {});
    browserState.delete(workspaceId);
  }
}

async function getOrCreateBrowser(workspaceId: string, headless = true): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  let state = browserState.get(workspaceId);
  if (state) return state;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  state = { browser, context, page };
  browserState.set(workspaceId, state);
  return state;
}

// Browser tool implementations
async function execBrowserNavigate(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const url = String(args.url);
  if (!url) return { callId, name: "browser_navigate", output: "Error: url is required", isError: true };
  try {
    const state = await getOrCreateBrowser(ctx.workspaceId);
    await state.page.goto(url, { waitUntil: "domcontentloaded" });
    const title = await state.page.title().catch(() => "unknown");
    return { callId, name: "browser_navigate", output: `Navigated to ${url}. Page title: ${title}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_navigate", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserClick(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const selector = String(args.selector);
  if (!selector) return { callId, name: "browser_click", output: "Error: selector is required", isError: true };
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_click", output: "Error: Browser not initialized. Navigate first.", isError: true };
    const modifiers = args.modifiers || [];
    await state.page.click(selector, { modifiers });
    return { callId, name: "browser_click", output: `Clicked element: ${selector}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_click", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserType(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const selector = String(args.selector);
  const text = String(args.text);
  if (!selector || !text) return { callId, name: "browser_type", output: "Error: selector and text are required", isError: true };
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_type", output: "Error: Browser not initialized", isError: true };
    await state.page.type(selector, text);
    return { callId, name: "browser_type", output: `Typed "${text}" into ${selector}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_type", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserFill(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const selector = String(args.selector);
  const text = String(args.text);
  if (!selector || !text) return { callId, name: "browser_fill", output: "Error: selector and text are required", isError: true };
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_fill", output: "Error: Browser not initialized", isError: true };
    await state.page.fill(selector, text);
    return { callId, name: "browser_fill", output: `Filled ${selector} with "${text}"`, isError: false };
  } catch (err) {
    return { callId, name: "browser_fill", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserSnapshot(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_snapshot", output: "Error: Browser not initialized. Navigate first.", isError: true };
    const element = args.element ? String(args.element) : null;
    const html = element ? (await state.page.$(element))?.innerHTML() || "Element not found" : await state.page.content();
    return { callId, name: "browser_snapshot", output: `HTML (truncated): ${String(html).slice(0, 3000)}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_snapshot", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserEvaluate(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const expression = String(args.expression);
  if (!expression) return { callId, name: "browser_evaluate", output: "Error: expression is required", isError: true };
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_evaluate", output: "Error: Browser not initialized", isError: true };
    const result = await state.page.evaluate(expression);
    return { callId, name: "browser_evaluate", output: `Result: ${JSON.stringify(result).slice(0, 1000)}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_evaluate", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserGetText(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const selector = String(args.selector);
  if (!selector) return { callId, name: "browser_get_text", output: "Error: selector is required", isError: true };
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_get_text", output: "Error: Browser not initialized", isError: true };
    const text = await state.page.textContent(selector);
    return { callId, name: "browser_get_text", output: text || "(no text)", isError: false };
  } catch (err) {
    return { callId, name: "browser_get_text", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserWaitFor(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const text = args.text ? String(args.text) : null;
  const selector = args.selector ? String(args.selector) : null;
  const time = args.time ? Number(args.time) : 10;
  if (!text && !selector) return { callId, name: "browser_wait_for", output: "Error: text or selector is required", isError: true };
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_wait_for", output: "Error: Browser not initialized", isError: true };
    if (selector) await state.page.waitForSelector(selector, { timeout: time * 1000 });
    if (text) await state.page.waitForSelector(`text=${text}`, { timeout: time * 1000 });
    return { callId, name: "browser_wait_for", output: `Waited for ${selector || text}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_wait_for", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserSelectOption(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const selector = String(args.selector);
  const value = String(args.value);
  if (!selector || !value) return { callId, name: "browser_select_option", output: "Error: selector and value are required", isError: true };
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_select_option", output: "Error: Browser not initialized", isError: true };
    await state.page.selectOption(selector, value);
    return { callId, name: "browser_select_option", output: `Selected ${value} in ${selector}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_select_option", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserTabs(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const action = String(args.action);
  const index = args.index !== undefined ? Number(args.index) : 0;
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_tabs", output: "Error: Browser not initialized", isError: true };
    if (action === "list") {
      const pages = state.context.pages();
      return { callId, name: "browser_tabs", output: `Tabs: ${pages.map((p, i) => `${i}: ${p.url()}`).join("\n")}`, isError: false };
    } else if (action === "switch") {
      const pages = state.context.pages();
      if (index >= pages.length) return { callId, name: "browser_tabs", output: `Error: Tab index ${index} out of range`, isError: true };
      await pages[index].bringToFront();
      return { callId, name: "browser_tabs", output: `Switched to tab ${index}`, isError: false };
    }
    return { callId, name: "browser_tabs", output: "Error: action must be 'list' or 'switch'", isError: true };
  } catch (err) {
    return { callId, name: "browser_tabs", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserClose(callId: string, ctx: ToolExecutionContext): Promise<ToolResult> {
  clearBrowserState(ctx.workspaceId);
  return { callId, name: "browser_close", output: "Browser closed", isError: false };
}

async function execBrowserTakeScreenshot(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const filename = String(args.filename);
  const fullPage = args.fullPage === true;
  if (!filename) return { callId, name: "browser_take_screenshot", output: "Error: filename is required", isError: true };
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_take_screenshot", output: "Error: Browser not initialized", isError: true };
    const filepath = path.join(ctx.cwd, filename);
    await state.page.screenshot({ path: filepath, fullPage });
    return { callId, name: "browser_take_screenshot", output: `Screenshot saved to ${filename}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_take_screenshot", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserHover(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const selector = String(args.selector);
  if (!selector) return { callId, name: "browser_hover", output: "Error: selector is required", isError: true };
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_hover", output: "Error: Browser not initialized", isError: true };
    await state.page.hover(selector);
    return { callId, name: "browser_hover", output: `Hovered over ${selector}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_hover", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserPressKey(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const key = String(args.key);
  if (!key) return { callId, name: "browser_press_key", output: "Error: key is required", isError: true };
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_press_key", output: "Error: Browser not initialized", isError: true };
    await state.page.keyboard.press(key);
    return { callId, name: "browser_press_key", output: `Pressed key: ${key}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_press_key", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function execBrowserNetworkRequests(callId: string, args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const filter = args.filter ? String(args.filter) : null;
  try {
    const state = getBrowserState(ctx.workspaceId);
    if (!state) return { callId, name: "browser_network_requests", output: "Error: Browser not initialized", isError: true };
    const requests = state.page.url() ? [state.page.url()] : [];
    return { callId, name: "browser_network_requests", output: `Current URL: ${requests[0] || "(none)"}`, isError: false };
  } catch (err) {
    return { callId, name: "browser_network_requests", output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ─── Tool definitions (OpenAI function-calling format) ──────────────────────

export const WORKSPACE_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "explore_mode",
      description: "Batch multiple read-only tool calls into a single response for rapid context gathering.",
      parameters: {
        type: "object",
        properties: {
          calls: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tool: { type: "string", description: "Name of the tool to call (e.g., read_file, list_dir, grep_files)" },
                args: { type: "object", description: "Arguments for the tool" }
              },
              required: ["tool", "args"]
            },
            description: "List of tool calls to execute in sequence."
          }
        },
        required: ["calls"],
        additionalProperties: false
      }
    }
  },
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
      name: "remove_file",
      description: "Delete a single file in the workspace. Only files are allowed (not directories).",
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
      name: "search_replace",
      description: "Find and replace a block of text in an existing file. The 'search' string must match content in the file (fuzzy whitespace matching is applied). Prefer this over write_file for targeted edits to existing files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to workspace root"
          },
          search: {
            type: "string",
            description: "Exact text to find in the file"
          },
          replace: {
            type: "string",
            description: "Replacement text"
          }
        },
        required: ["path", "search", "replace"],
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
      description: "Run a whitelisted command (e.g. test, lint, typecheck, build, status). The command name must be in the workspace's available commands.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the whitelisted command to run (e.g. 'test', 'lint', 'typecheck', 'build')"
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
        required: ["result"],
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

export const BROWSER_TOOLS: ToolDef[] = [
  { type: "function", function: { name: "browser_navigate", description: "Navigate to a URL in the browser.", parameters: { type: "object", properties: { url: { type: "string", description: "The URL to navigate to" } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_click", description: "Click an element on the page.", parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector for the element to click" }, modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] } } }, required: ["selector"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_type", description: "Type text into an input field.", parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector for the input element" }, text: { type: "string", description: "Text to type" } }, required: ["selector", "text"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_fill", description: "Fill an input field with text.", parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector for the input element" }, text: { type: "string", description: "Text to fill" } }, required: ["selector", "text"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_snapshot", description: "Take a snapshot of the current page state.", parameters: { type: "object", properties: { element: { type: "string", description: "Optional: element to snapshot" } }, required: [], additionalProperties: false } } },
  { type: "function", function: { name: "browser_evaluate", description: "Execute JavaScript in the browser context.", parameters: { type: "object", properties: { expression: { type: "string", description: "JavaScript expression to execute" } }, required: ["expression"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_get_text", description: "Get text content from an element.", parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector for the element" } }, required: ["selector"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_wait_for", description: "Wait for an element or text to be visible.", parameters: { type: "object", properties: { text: { type: "string", description: "Text to wait for" }, selector: { type: "string", description: "Optional: element to wait for" }, time: { type: "number", description: "Optional: max wait time in seconds (default 10)" } }, required: ["text"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_select_option", description: "Select an option from a dropdown.", parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector for the select element" }, value: { type: "string", description: "Value to select" } }, required: ["selector", "value"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_tabs", description: "List or switch between browser tabs.", parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "switch"], description: "Action: list or switch" }, index: { type: "number", description: "Tab index to switch to" } }, required: ["action"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_close", description: "Close the browser and clean up.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } },
  { type: "function", function: { name: "browser_take_screenshot", description: "Take a screenshot of the current page.", parameters: { type: "object", properties: { filename: { type: "string", description: "Filename to save screenshot" }, fullPage: { type: "boolean", description: "Capture full scrollable page" } }, required: ["filename"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_hover", description: "Hover over an element.", parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector for the element" } }, required: ["selector"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_press_key", description: "Press a keyboard key.", parameters: { type: "object", properties: { key: { type: "string", description: "Key name (Enter, Escape, ArrowDown, etc.)" } }, required: ["key"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_network_requests", description: "Get network requests made by the page.", parameters: { type: "object", properties: { filter: { type: "string", description: "Optional: regex to filter URLs" } }, required: [], additionalProperties: false } } },
];

export const BROWSER_TOOL_ALIASES: Record<string, string> = {
  navigate: "browser_navigate",
  click: "browser_click",
  type: "browser_type",
  fill: "browser_fill",
  snapshot: "browser_snapshot",
  evaluate: "browser_evaluate",
  getText: "browser_get_text",
  waitFor: "browser_wait_for",
  select: "browser_select_option",
  tabs: "browser_tabs",
  close: "browser_close",
  screenshot: "browser_take_screenshot",
  hover: "browser_hover",
  press: "browser_press_key",
  network: "browser_network_requests",
};

export const TOOL_ALIASES: Record<string, string> = {
  // Standard aliases
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
  rm: "remove_file",
  unlink: "remove_file",
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
  replace: "search_replace",
  search_and_replace: "search_replace",
  create: "write_file",
  update: "write_file",
  delete: "remove_file",
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
  // GLM-4.7 specific variants
  invoke: "read_file",
  execute: "read_file",
  function: "read_file",
  argument: "read_file",
  "read-context-packet": "read_context_packet",
  "save-artifact": "save_artifact",
  "read-artifact": "read_artifact",
  finish: "finish",
  done: "finish",
  complete: "finish",
  function_call: "git_diff",
  "call-tool": "git_diff",
  "call": "run_command",
  "function-calls": "git_diff",
  tool: "git_diff",
  arguments: "git_diff",
  tool_name: "git_status",
  "xsi:type": "git_diff",
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
      case "explore_mode":
        return await execExploreMode(call.id, args, ctx);
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
      case "remove_file":
        return await execRemoveFile(call.id, args, ctx);
      case "search_replace":
        return await execSearchReplace(call.id, args, ctx);
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
      // Browser tools
      case "browser_navigate":
        return await execBrowserNavigate(call.id, args, ctx);
      case "browser_click":
        return await execBrowserClick(call.id, args, ctx);
      case "browser_type":
        return await execBrowserType(call.id, args, ctx);
      case "browser_fill":
        return await execBrowserFill(call.id, args, ctx);
      case "browser_snapshot":
        return await execBrowserSnapshot(call.id, args, ctx);
      case "browser_evaluate":
        return await execBrowserEvaluate(call.id, args, ctx);
      case "browser_get_text":
        return await execBrowserGetText(call.id, args, ctx);
      case "browser_wait_for":
        return await execBrowserWaitFor(call.id, args, ctx);
      case "browser_select_option":
        return await execBrowserSelectOption(call.id, args, ctx);
      case "browser_tabs":
        return await execBrowserTabs(call.id, args, ctx);
      case "browser_close":
        return await execBrowserClose(call.id, ctx);
      case "browser_take_screenshot":
        return await execBrowserTakeScreenshot(call.id, args, ctx);
      case "browser_hover":
        return await execBrowserHover(call.id, args, ctx);
      case "browser_press_key":
        return await execBrowserPressKey(call.id, args, ctx);
      case "browser_network_requests":
        return await execBrowserNetworkRequests(call.id, args, ctx);
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

// Track files already read by explore_mode to prevent re-reading
const exploreModeReadFiles: Set<string> = new Set();

export function resetExploreModeFiles(): void {
  exploreModeReadFiles.clear();
}
async function execExploreMode(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  let calls = (args.calls as Array<{ tool: string; args: Record<string, unknown> }> ?? []);

  // Robustness for nested models
  if (!Array.isArray(calls) && typeof args.calls === 'object' && args.calls !== null) {
    const maybeCalls = (args.calls as any).calls;
    if (Array.isArray(maybeCalls)) {
      calls = maybeCalls;
    }
  }

  // Case 2: args itself is { args: { calls: [...] } } or { parameters: { calls: [...] } }
  if (calls.length === 0) {
    const nested = (args.args || args.parameters || args.arguments) as any;
    if (nested && typeof nested === 'object') {
      const maybeCalls = nested.calls;
      if (Array.isArray(maybeCalls)) {
        calls = maybeCalls;
      }
    }
  }

  if (!Array.isArray(calls) || calls.length === 0) {
    return { callId, name: "explore_mode", output: "Error: calls array is required", isError: true };
  }

  const allowedTools = new Set(["glob_files", "grep_files", "list_dir", "read_file", "read_files", "semantic_search", "git_status", "list_changed_files", "read_context_packet", "read_artifact", "web_search"]);
  const results: string[] = [];

  for (const [index, call] of calls.entries()) {
    const toolName = String(call.tool);
    if (!allowedTools.has(toolName)) {
      results.push(`--- [${index}] ${toolName} ---\nError: Tool not allowed in explore_mode (read-only only).`);
      continue;
    }

    // Deduplication: skip files already read
    const filePath = (call.args?.path as string) || (call.args?.pattern as string) || "";
    if ((toolName === "read_file" || toolName === "read_files") && filePath && exploreModeReadFiles.has(filePath)) {
      results.push(`--- [${index}] ${toolName}(${JSON.stringify(call.args)}) ---\n[SKIPPED] File already read in a previous iteration. Use the information you already have.`);
      continue;
    }

    try {
      const result = await executeToolCall({ id: `${callId}_${index}`, name: toolName, args: call.args }, ctx);
      results.push(`--- [${index}] ${toolName}(${JSON.stringify(call.args)}) ---\n${result.output}`);
      // Track read files for dedup
      if ((toolName === "read_file" || toolName === "read_files") && filePath) {
        if (toolName === "read_files" && Array.isArray(call.args?.paths)) {
          (call.args.paths as string[]).forEach((p: string) => exploreModeReadFiles.add(p));
        } else {
          exploreModeReadFiles.add(filePath);
        }
      }
    } catch (err) {
      results.push(`--- [${index}] ${toolName} ---\nError: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    callId,
    name: "explore_mode",
    output: results.join("\n\n")
  };
}

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
      ? limited.map(p => p.replace(/\\/g, "/")).join("\n")
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
  let dirPath = args.path ? String(args.path) : ".";
  
  // Strip surrounding or trailing quotes/noise if model included them
  dirPath = dirPath.replace(/^["']|["']$/g, "").trim();
  if (dirPath.endsWith('"') || dirPath.endsWith("'")) dirPath = dirPath.slice(0, -1);
  
  if (dirPath === "" || dirPath === "/" || dirPath === "./") dirPath = ".";
  
  let fullPath: string;
  if (dirPath === ".") {
    fullPath = path.resolve(ctx.cwd);
  } else {
    fullPath = path.resolve(ctx.cwd, dirPath);
  }
  
  // Safety: ensure within workspace
  const resolvedCwd = path.resolve(ctx.cwd);
  if (!fullPath.startsWith(resolvedCwd) && fullPath !== resolvedCwd) {
     return { callId, name: "list_dir", output: "Error: path is outside workspace", isError: true };
  }

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
    // On ENOENT, try to list the parent so the model can course-correct instead of stalling
    if (err.code === "ENOENT" && fullPath !== resolvedCwd) {
      try {
        const parentPath = path.dirname(fullPath);
        if (parentPath.startsWith(resolvedCwd)) {
          const parentEntries = await readdir(parentPath, { withFileTypes: true });
          const parentLines = parentEntries
            .filter(e => !e.name.startsWith("."))
            .map(e => `${e.name}${e.isDirectory() ? "/" : ""}`)
            .sort();
          return {
            callId,
            name: "list_dir",
            output: `Path not found: ${dirPath}\nDid you mean one of these?\n${parentLines.join("\n")}`,
            isError: true
          };
        }
      } catch { /* parent also not accessible */ }
    }
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
  let filePath = String(args.path ?? "");
  
  // Robustness for models providing 'paths' (array or string) to single read_file
  if (!filePath && args.paths) {
    if (Array.isArray(args.paths)) {
      filePath = String(args.paths[0] ?? "");
    } else {
      filePath = String(args.paths);
    }
  }

  if (!filePath) {
    return { callId, name: "read_file", output: "Error: path is required", isError: true };
  }

  const result = await ctx.readFiles([filePath]);
  const content = result[filePath];

  if (content === undefined) {
    return { callId, name: "read_file", output: `Error: file not found: ${filePath}`, isError: true };
  }

  trackFileRead(ctx.cwd, filePath);

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
  let filePaths = (args.paths as string[] ?? []);
  
  // Robustness for nested models
  if (!Array.isArray(filePaths) && typeof args.paths === 'object' && args.paths !== null) {
    const maybePaths = (args.paths as any).paths;
    if (Array.isArray(maybePaths)) {
      filePaths = maybePaths;
    }
  }

  filePaths = filePaths.map(String);

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
      trackFileRead(ctx.cwd, fp);
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

  // Read-before-write guard: hard block if overwriting existing file that wasn't read
  const targetPath = path.resolve(ctx.cwd, filePath);
  try {
    const st = await stat(targetPath);
    if (st.isFile() && !hasFileBeenRead(ctx.cwd, filePath)) {
      return {
        callId,
        name: "write_file",
        output: `Error: You must read "${filePath}" before overwriting it. Use read_file first.`,
        isError: true
      };
    }
  } catch {
    // File doesn't exist — new file, no guard needed
  }

  // Validate JSON files before writing
  if (filePath.replace(/\\/g, "/").endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch (parseErr) {
      return {
        callId,
        name: "write_file",
        output: `Error: invalid JSON for ${filePath}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Fix syntax (check trailing commas, double commas, missing quotes) and retry.`,
        isError: true
      };
    }
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
  let files = (args.files as Array<{ path: string; content: string }> ?? []);

  // Robustness for nested models
  // Case 1: args.files is { files: [...] }
  if (!Array.isArray(files) && typeof args.files === 'object' && args.files !== null) {
    const maybeFiles = (args.files as any).files;
    if (Array.isArray(maybeFiles)) {
      files = maybeFiles;
    }
  }
  
  // Case 2: args itself is { args: { files: [...] } } or { parameters: { files: [...] } }
  if (files.length === 0) {
    const nested = (args.args || args.parameters || args.arguments) as any;
    if (nested && typeof nested === 'object') {
      const maybeFiles = nested.files;
      if (Array.isArray(maybeFiles)) {
        files = maybeFiles;
      }
    }
  }

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

  // Read-before-write guard: check each existing file was read
  for (const f of files) {
    const targetPath = path.resolve(ctx.cwd, f.path);
    try {
      const st = await stat(targetPath);
      if (st.isFile() && !hasFileBeenRead(ctx.cwd, f.path)) {
        return {
          callId,
          name: "write_files",
          output: `Error: You must read "${f.path}" before overwriting it. Use read_file first.`,
          isError: true
        };
      }
    } catch {
      // File doesn't exist — new file, no guard needed
    }
  }

  // Validate JSON files before writing
  for (const f of files) {
    if (f.path.replace(/\\/g, "/").endsWith(".json")) {
      try {
        JSON.parse(f.content);
      } catch (parseErr) {
        return {
          callId,
          name: "write_files",
          output: `Error: invalid JSON for ${f.path}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Fix syntax and retry.`,
          isError: true
        };
      }
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

async function execRemoveFile(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  if (!filePath) {
    return { callId, name: "remove_file", output: "Error: path is required", isError: true };
  }

  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith(".git/") || normalized.includes("/.git/") ||
      normalized.startsWith("node_modules/") || normalized.includes("/node_modules/")) {
    return {
      callId,
      name: "remove_file",
      output: "Error: deletes in .git/ and node_modules/ are forbidden",
      isError: true
    };
  }

  const cwdResolved = path.resolve(ctx.cwd);
  const targetPath = path.resolve(ctx.cwd, filePath);
  if (targetPath !== cwdResolved && !targetPath.startsWith(`${cwdResolved}${path.sep}`)) {
    return { callId, name: "remove_file", output: "Error: path is outside workspace", isError: true };
  }

  try {
    const st = await stat(targetPath);
    if (st.isDirectory()) {
      return {
        callId,
        name: "remove_file",
        output: `Error: ${filePath} is a directory (use a command tool if recursive deletion is truly intended)`,
        isError: true
      };
    }
    await unlink(targetPath);
    return { callId, name: "remove_file", output: `Removed ${filePath}` };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { callId, name: "remove_file", output: `Error: file not found: ${filePath}`, isError: true };
    }
    return {
      callId,
      name: "remove_file",
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true
    };
  }
}

async function execSearchReplace(
  callId: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  const search = String(args.search ?? "");
  const replace = String(args.replace ?? "");

  if (!filePath || !search) {
    return { callId, name: "search_replace", output: "Error: path and search are required", isError: true };
  }

  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith(".git/") || normalized.includes("/.git/") ||
      normalized.startsWith("node_modules/") || normalized.includes("/node_modules/")) {
    return { callId, name: "search_replace", output: "Error: writes to .git/ and node_modules/ are forbidden", isError: true };
  }

  const cwdResolved = path.resolve(ctx.cwd);
  const targetPath = path.resolve(ctx.cwd, filePath);
  if (targetPath !== cwdResolved && !targetPath.startsWith(`${cwdResolved}${path.sep}`)) {
    return { callId, name: "search_replace", output: "Error: path is outside workspace", isError: true };
  }

  // Identity check
  if (search === replace) {
    return { callId, name: "search_replace", output: `Skipped identity transform for ${filePath} (search === replace)` };
  }

  // Read existing content
  let content: string;
  try {
    content = await readFile(targetPath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { callId, name: "search_replace", output: `Error: file not found: ${filePath}`, isError: true };
    }
    return { callId, name: "search_replace", output: `Error reading file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }

  // Exact match
  let index = content.indexOf(search);
  let usedFuzzy = false;

  // Fuzzy whitespace fallback
  if (index === -1) {
    const fuzzyResult = fuzzyMatch(content, search);
    if (fuzzyResult) {
      index = fuzzyResult.index;
      usedFuzzy = true;
    }
  }

  if (index === -1) {
    return {
      callId,
      name: "search_replace",
      output: `Error: search block not found in ${filePath}. First 200 chars of search: ${search.slice(0, 200)}. First 200 chars of file: ${content.slice(0, 200)}`,
      isError: true
    };
  }

  const newContent = content.slice(0, index) + replace + content.slice(index + search.length);
  await mkdir(path.dirname(targetPath), { recursive: true });

  // Validate JSON files — auto-repair common issues, reject if still broken
  let finalContent = newContent;
  if (normalized.endsWith(".json")) {
    try {
      JSON.parse(newContent);
    } catch (firstErr) {
      // Try auto-repair: double commas, trailing commas before } or ]
      let repaired = newContent
        .replace(/,\s*([}\]])/g, "$1")   // trailing comma before } or ]
        .replace(/,+\s*,/g, ",")          // double/triple commas → single
        .replace(/,\s*,/g, ",");          // comma-whitespace-comma
      try {
        JSON.parse(repaired);
        finalContent = repaired;
        console.log(`[search_replace] Auto-repaired JSON in ${filePath}`);
      } catch (repairErr) {
        const errMsg = repairErr instanceof Error ? repairErr.message : String(repairErr);
        return {
          callId,
          name: "search_replace",
          output: `Error: search_replace would produce invalid JSON in ${filePath}. NOT written. Parse error: ${errMsg}. Use write_file with the complete valid JSON instead.`,
          isError: true
        };
      }
    }
  }

  await writeFile(targetPath, finalContent, "utf8");

  const repaired = finalContent !== newContent ? " (JSON auto-repaired)" : "";
  return {
    callId,
    name: "search_replace",
    output: `Applied search_replace to ${filePath}${usedFuzzy ? " (fuzzy whitespace match)" : ""}${repaired} (${search.length} chars replaced with ${replace.length} chars)`
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
  const name = String(args.name ?? args.command ?? "");
  if (!name) {
    return { callId, name: "run_command", output: "Error: name is required", isError: true };
  }

  const availableCommands = ctx.getAvailableCommands?.() ?? ctx.availableCommands ?? [];
  if (availableCommands.length > 0 && !availableCommands.includes(name)) {
    return {
      callId,
      name: "run_command",
      output: `Error: command '${name}' is not available in this workspace. Available commands: ${availableCommands.join(", ")}`,
      isError: true
    };
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

// ─── Tool contract generation ──────────────────────────────────────────────

export function getCompactToolContract(toolNames: string[]): string {
  const allTools = [...WORKSPACE_TOOLS, ...BROWSER_TOOLS];
  const selected = allTools.filter((t) => toolNames.includes(t.function.name));

  if (selected.length === 0) return "";

  const lines = ["Available tools this run:"];
  for (const t of selected) {
    const f = t.function;
    const args: Record<string, string> = {};
    for (const [name, prop] of Object.entries(f.parameters.properties)) {
      args[name] = (prop as any).type || "any";
    }
    const desc = f.description ? ` - ${f.description.split('.')[0]}.` : "";
    lines.push(`- ${f.name}${JSON.stringify(args)}${desc}`);
  }
  return lines.join("\n");
}

export function getAvailableToolsList(role: string, options?: { availableCommands?: string[] }): string[] {
  const availableCommands = new Set(options?.availableCommands ?? []);
  const common = ["explore_mode", "read_file", "read_files", "glob_files", "grep_files", "list_dir", "semantic_search", "finish"];
  if (role === "builder") {
    return [...common, "write_file", "write_files", "remove_file", "git_status", "git_diff", "git_diff_staged", "run_command", "list_changed_files"];
  }
  if (role === "explorer") {
    return availableCommands.has("install")
      ? [...common, "run_command"]
      : ["explore_mode", "read_file", "read_files", "glob_files", "grep_files", "list_dir", "semantic_search", "finish"];
  }
  if (role === "coder") {
    const writeTools = ["write_file", "write_files", "search_replace"];
    return availableCommands.has("install")
      ? [...common, ...writeTools, "run_command"]
      : [...common, ...writeTools];
  }
  if (role === "reviewer") {
    return ["read_file", "list_dir", "remove_file", "git_status", "git_diff", "git_diff_staged", "run_command", "list_changed_files", "finish"];
  }
  if (role === "epic-decoder" || role === "epicDecoder") {
    return ["read_file", "glob_files", "grep_files", "list_dir", "semantic_search", "web_search", "finish"];
  }
  if (role === "epic-reviewer" || role === "epicReviewer") {
    return ["read_file", "list_dir", "write_file", "write_files", "remove_file", "run_command", "git_diff", "git_diff_staged", "git_status", "list_changed_files", "finish"];
  }
  return common;
}

// ─── Simple glob matching fallback ──────────────────────────────────────────

function matchGlob(filePath: string, pattern: string): boolean {
  // Normalize to forward slashes for cross-platform matching (Windows uses backslashes)
  const normalized = filePath.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  // Convert simple glob to regex
  const regex = normalizedPattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*")
    .replace(/\?/g, "[^/]");

  return new RegExp(`^${regex}$`).test(normalized);
}
