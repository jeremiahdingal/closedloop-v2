# Playwright Loop — Implementation Spec (Verbose Edition)

**Project:** ClosedLoop — Autonomous Local-First Coding Agent
**Date:** 2026-04-06
**Status:** Ready for implementation
**Audience:** This document is written for a model that has never seen this codebase. Every step is explicit. Do not skip steps. Do not infer. Follow exactly.

---

## What You Are Building

Two new agents that run **after the Epic Reviewer has finished**, forming a self-healing verification loop:

1. **Play Writer** — Reads the epic goal and the consolidated changes the Epic Reviewer produced. Generates Playwright e2e test files specifically for this epic. Outputs the exact list of test files it created.

2. **Play Tester** — Receives the exact list of test files from Play Writer. Starts the dev servers. Runs each test file strictly using Playwright MCP browser tools (NOT `npx playwright test`, NOT shell commands). Reports which tests passed and which failed.

**Why Play Loop comes AFTER Epic Reviewer:**
The Epic Reviewer is responsible for consolidating all ticket branches, fixing cross-ticket issues, and ensuring the codebase is coherent. Only after that consolidated state exists does it make sense to verify it with real browser tests. Play Loop is the **verification** of Epic Reviewer's output — not a pre-check before it.

**Loop behaviour:**
- If ALL tests pass → END. The epic is complete.
- If ANY test fails → feed the failing test details back into the Epic Decoder → Epic Decoder creates new fix tickets → tickets are built → Epic Reviewer runs again → Play Writer runs again → Play Tester runs again
- This loop has a **hard limit of 3 iterations**. After 3 failures, escalate and stop.

---

## Full Pipeline (After This Change)

```
[Epic Decoder] → creates tickets
      ↓
[Builder + Reviewer] per ticket (existing, do not change)
      ↓
All tickets approved?
      ↓ YES
[Epic Reviewer]  (existing, do not change)
  - Consolidates all ticket changes
  - Fixes cross-ticket issues
  - Applies fixes to ticket PR branches
      ↓
[Play Writer]  ← NEW (runs AFTER Epic Reviewer)
  - Reads the consolidated epic state
  - Generates Playwright test files for this epic
  - Output: list of test files created
      ↓
[Play Tester]  ← NEW
  - Start dev servers
  - Run each test file using Playwright MCP tools
  - Stop dev servers
  - Output: passed/failed per test
      ↓
All tests pass?
  YES → END. Epic is complete and verified.
  NO  → loop attempt < 3?
          YES → [Epic Decoder] with failing test context
                → new fix tickets
                → [Builder + Reviewer] per new ticket
                → [Epic Reviewer] again
                → [Play Writer] again
                → [Play Tester] again
                → repeat
          NO  → Escalate epic as failed with test failure details → END
```

**CRITICAL NOTE FOR IMPLEMENTER:**
The Play Loop does NOT run before `runEpicReview()`. It runs AFTER `runEpicReview()` returns. Find where `runEpicReview()` is called and insert `runPlayLoop()` immediately after it, not before. The sequence in code must be:

```typescript
// 1. Epic Reviewer consolidates (existing)
await this.runEpicReview(epic, tickets, runId);

// 2. Play Loop verifies (NEW — insert after runEpicReview)
const playLoopPassed = await this.runPlayLoop(epic, tickets, runId);
if (!playLoopPassed) {
  // escalate
}
// END
```

---

## Exact Files to Modify or Create

### Files to MODIFY (they already exist — read them first):
- `src/types.ts` — add two new agent roles
- `src/config.ts` — add two new model config keys + dev server URLs
- `src/apps/api.ts` — add two new entries to SWITCHABLE_ADAPTORS
- `src/orchestration/prompts.ts` — add two new prompt functions
- `src/orchestration/goal-runner.ts` — add Play Writer, Play Tester, loop logic, integrate into epic orchestration

### Files to CREATE (they do not exist yet):
- None. Everything goes into existing files.

---

## Step 1 — Add Agent Roles to `src/types.ts`

Open `src/types.ts`. Find the `AgentRole` type. It currently looks like:

```typescript
export type AgentRole =
  | "epicDecoder"
  | "builder"
  | "reviewer"
  | "tester"
  | "epicReviewer"
  | "doctor"
  | "system";
```

Add `"playWriter"` and `"playTester"` to it:

```typescript
export type AgentRole =
  | "epicDecoder"
  | "builder"
  | "reviewer"
  | "tester"
  | "epicReviewer"
  | "playWriter"
  | "playTester"
  | "doctor"
  | "system";
```

---

## Step 2 — Add Config Keys to `src/config.ts`

Open `src/config.ts`. Find the `AppConfig` type definition. Add these two fields:

```typescript
playWriterModel: string;       // e.g. "qwen-cli"
playTesterModel: string;       // e.g. "mediated:qwen3:4b"
playwrightDevServerCommand: string;  // command to start dev servers, e.g. "yarn dev"
playwrightDevServerUrl: string;      // URL to wait for, e.g. "http://localhost:3000"
playwrightDevServerReadyMs: number;  // ms to wait after starting server, default 8000
```

Then find the `loadConfig()` function where it reads from `process.env`. Add these entries alongside the existing ones:

```typescript
playWriterModel: process.env.PLAY_WRITER_MODEL || "qwen-cli",
playTesterModel: process.env.PLAY_TESTER_MODEL || "mediated:qwen3:4b",
playwrightDevServerCommand: process.env.PLAYWRIGHT_DEV_SERVER_COMMAND || "yarn dev",
playwrightDevServerUrl: process.env.PLAYWRIGHT_DEV_SERVER_URL || "http://localhost:3000",
playwrightDevServerReadyMs: Number(process.env.PLAYWRIGHT_DEV_SERVER_READY_MS || 8000),
```

---

## Step 3 — Add Model Options to `src/apps/api.ts`

Open `src/apps/api.ts`. Find the `SWITCHABLE_ADAPTORS` object. It has keys like `epicDecoder`, `builder`, `reviewer`, etc. Add two new keys at the end of the object (before the closing `}`):

```typescript
  playWriter: [
    { id: "qwen-cli", label: "Qwen CLI", description: "Workspace-aware local Qwen CLI execution" },
    { id: "codex-cli", label: "Codex CLI", description: "Workspace-aware, bash + file tools via ChatGPT subscription" }
  ],
  playTester: [
    { id: "mediated:qwen3:4b", label: "Mediated (qwen3:4b)", description: "Runs Playwright MCP tools via local Ollama" },
    { id: "mediated:qwen3.5:9b", label: "Mediated (qwen3.5:9b)", description: "Runs Playwright MCP tools via local Ollama" },
    { id: "mediated:glm-4.7-flash:q4_K_M", label: "Mediated (glm-4.7-flash)", description: "Runs Playwright MCP tools via local Ollama" }
  ],
```

Also find the `isAgentRole()` function and add the two new roles to its array:

```typescript
function isAgentRole(value: string): value is AgentRole {
  return ["epicDecoder", "builder", "reviewer", "tester", "epicReviewer", "playWriter", "playTester", "doctor", "system"].includes(value);
}
```

---

## Step 4 — Add Prompts to `src/orchestration/prompts.ts`

Open `src/orchestration/prompts.ts`. Add these two functions anywhere before the closing of the file (after the last export is fine).

### 4a — `playWriterPrompt()`

```typescript
/**
 * Prompt for Play Writer agent.
 * This agent runs after all tickets are approved.
 * It fixes remaining build errors and generates Playwright e2e tests for the epic.
 * It must output FINAL_JSON with the list of test files it created.
 */
export function playWriterPrompt(
  epic: EpicRecord,
  tickets: TicketRecord[],
  existingTestFiles: string[],   // list of .spec.ts filenames already in tests/ directory
  buildErrors: string | null,    // output of typecheck command, or null if build is clean
  ragContext?: { codeContext: string; docContext: string } | null
): string {
  const ticketSummary = tickets
    .map(t => `  - ${t.id}: ${t.title}\n    Files: ${(t.allowedPaths ?? []).join(", ")}`)
    .join("\n");

  const existingTestsBlock = existingTestFiles.length > 0
    ? existingTestFiles.map(f => `  - ${f}`).join("\n")
    : "  (none found)";

  const buildErrorsBlock = buildErrors
    ? `## Build Errors to Fix First\n\nThe codebase currently has build/typecheck errors. Fix these BEFORE generating tests:\n\`\`\`\n${buildErrors}\n\`\`\``
    : `## Build Status\n\nThe build is clean. No build errors to fix.`;

  const sections = [
    "You are Play Writer — an autonomous coding agent.",
    "",
    "Your job has TWO parts:",
    "  1. Fix any remaining build errors in the codebase (if any exist).",
    "  2. Generate Playwright e2e test files that test the features this epic implemented.",
    "",
    `## Epic: ${epic.title}`,
    epic.goalText,
    "",
    "## Tickets Completed in This Epic",
    "(These are the changes that were made to the codebase. Your tests must cover them.)",
    ticketSummary,
    "",
    buildErrorsBlock,
    "",
    "## Existing Test Files in tests/ Directory",
    "(Look at these for style, structure, and import patterns to follow.)",
    existingTestsBlock,
  ];

  if (ragContext?.codeContext) sections.push("\n## Relevant Code Context\n" + ragContext.codeContext);

  sections.push(
    "",
    "## Your Instructions",
    "",
    "### Part 1: Fix Build Errors",
    "If there are build errors listed above:",
    "  1. Read each file mentioned in the errors.",
    "  2. Fix the errors by editing those files.",
    "  3. You may edit ANY file in the codebase to fix the errors.",
    "  4. Do not skip this — tests cannot run if the build is broken.",
    "",
    "If there are no build errors, skip to Part 2.",
    "",
    "### Part 2: Generate Playwright Tests",
    "  1. Read 2-3 of the existing test files to understand the project's testing patterns.",
    "  2. Understand what each completed ticket actually changed in the codebase.",
    "  3. Generate Playwright test files in the `tests/` directory.",
    "  4. Each test file should test the user-visible behaviour of the epic's features.",
    "  5. Tests must use `import { test, expect } from '@playwright/test'`.",
    "  6. Each test must navigate to a real URL and interact with the actual UI.",
    "  7. Give each test file a descriptive name, e.g. `tests/epic-theming.spec.ts`.",
    "  8. Write at least 1 test per major feature the epic introduced.",
    "",
    "### Important Constraints",
    "  - Do NOT use `page.waitForTimeout()` — use `page.waitForSelector()` or `expect(locator).toBeVisible()` instead.",
    "  - Do NOT hardcode credentials — read from environment variables if needed.",
    "  - Do NOT write tests that depend on specific database state — tests should work on a fresh app.",
    "  - Tests will be run by a separate agent using Playwright MCP browser tools, so write standard Playwright syntax.",
    "",
    "## Required Output",
    "",
    "After completing both parts, you MUST output exactly one FINAL_JSON block.",
    "The FINAL_JSON must list every test file you created (relative paths from repo root).",
    "Do not list files you did not create. Do not list pre-existing test files.",
    "",
    "Format:",
    '<FINAL_JSON>{"testsCreated":["tests/epic-theming.spec.ts","tests/epic-theming-cashier.spec.ts"],"buildFixed":true,"summary":"Fixed 2 import errors. Generated 2 test files covering dynamic theming and cashier gradient."}</FINAL_JSON>',
    "",
    "If you could not fix the build errors, still output FINAL_JSON but set testsCreated to empty array:",
    '<FINAL_JSON>{"testsCreated":[],"buildFixed":false,"summary":"Could not resolve circular import in src/theme/shopTheme.ts. Tests not generated."}</FINAL_JSON>',
  );

  return sections.join("\n");
}
```

### 4b — `playTesterPrompt()`

```typescript
/**
 * Prompt for Play Tester agent.
 * This agent receives the exact list of test files created by Play Writer.
 * It starts the dev servers, runs each test using Playwright MCP browser tools,
 * and outputs a structured pass/fail report.
 *
 * IMPORTANT: Play Tester uses Playwright MCP browser tools ONLY.
 * It does NOT run `npx playwright test`. It does NOT use shell commands to run tests.
 * It manually navigates the browser and checks UI state for each test case.
 */
export function playTesterPrompt(
  epic: EpicRecord,
  testFiles: string[],           // exact list from Play Writer's FINAL_JSON.testsCreated
  devServerUrl: string,          // e.g. "http://localhost:3000"
  devServerCommand: string,      // e.g. "yarn dev" — for reference only, harness starts it
  loopAttempt: number,           // 1, 2, or 3
  previousFailures?: string | null  // JSON string of failures from previous loop, if any
): string {
  const testFilesList = testFiles.map(f => `  - ${f}`).join("\n");

  const previousFailuresBlock = previousFailures
    ? `## Previous Loop Failures (Attempt ${loopAttempt - 1})\n\nThese tests failed in the previous attempt. Pay attention to them:\n${previousFailures}`
    : "";

  return [
    "You are Play Tester — an autonomous test execution agent.",
    "",
    `This is loop attempt ${loopAttempt} of 3.`,
    "",
    "## Your Job",
    "Run each Playwright test file listed below using Playwright MCP browser tools.",
    "The dev servers are already running. You do NOT need to start them.",
    `The app is available at: ${devServerUrl}`,
    "",
    "## Test Files to Run",
    "(These were generated by Play Writer specifically for this epic. Run ALL of them.)",
    testFilesList,
    "",
    previousFailuresBlock,
    "",
    `## Epic: ${epic.title}`,
    epic.goalText,
    "",
    "## How to Execute Each Test",
    "",
    "For each test file:",
    "  1. Read the test file content using your read_file tool.",
    "  2. Identify each `test(...)` block and what it does.",
    "  3. For each test:",
    "     a. Use `browser_navigate` to go to the page under test.",
    "     b. Use `browser_click`, `browser_type`, `browser_snapshot` etc. to perform the test steps.",
    "     c. Use `browser_snapshot` to capture the page state for assertions.",
    "     d. Compare the actual UI state to what the test expects.",
    "     e. Mark the test as PASSED if everything matches expectations.",
    "     f. Mark the test as FAILED if any step fails, with the exact error.",
    "",
    "## Critical Rules",
    "  - Do NOT run `npx playwright test` or any shell command to run tests.",
    "  - Do NOT use the `run_command` tool to execute tests.",
    "  - Use ONLY Playwright MCP browser tools: `browser_navigate`, `browser_click`,",
    "    `browser_type`, `browser_fill`, `browser_snapshot`, `browser_evaluate`,",
    "    `browser_get_text`, `browser_wait_for`.",
    "  - Run every test file listed above. Do not skip any.",
    "  - If a test file has multiple `test(...)` blocks, run ALL of them.",
    "  - Do not suggest fixes. Do not edit any files. Only report results.",
    "",
    "## Required Output Format",
    "",
    "After running ALL tests, output exactly one FINAL_JSON block.",
    "Include every test you ran, whether it passed or failed.",
    "",
    "Format:",
    `<FINAL_JSON>{
  "status": "passed",
  "summary": { "total": 4, "passed": 4, "failed": 0 },
  "results": [
    {
      "testFile": "tests/epic-theming.spec.ts",
      "testName": "dashboard has correct gradient background",
      "status": "passed",
      "steps": 5,
      "error": null
    },
    {
      "testFile": "tests/epic-theming.spec.ts",
      "testName": "cashier splash shows correct theme",
      "status": "failed",
      "steps": 3,
      "error": "Expected element .cashier-splash to have background #FF5500 but got transparent"
    }
  ]
}</FINAL_JSON>`,
    "",
    "Rules for FINAL_JSON:",
    "  - `status` at the top level is `passed` only if ALL tests passed, otherwise `failed`.",
    "  - `error` is null for passing tests.",
    "  - `error` must be the exact failure message for failing tests — be specific.",
    "  - Include every test. Do not omit passing tests from the results array.",
  ].join("\n");
}
```

---

## Step 5 — Add Methods to `src/orchestration/goal-runner.ts`

This is the most complex step. Read the entire `goal-runner.ts` file before making changes so you understand the existing patterns.

### 5a — Add imports at the top

At the top of the file, the `node:fs/promises` import currently looks like:
```typescript
import { writeFile, mkdir, symlink, stat } from "node:fs/promises";
```

Add `readdir` and `spawn` (you will need `readdir` to list test files, and `spawn` to start dev servers):
```typescript
import { writeFile, mkdir, symlink, stat, readdir } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
```

Add the two new prompts to the existing prompts import:
```typescript
// Find this import and add playWriterPrompt, playTesterPrompt to it:
import {
  epicDecoderPrompt,
  epicDecoderToolingPrompt,
  epicReviewerPrompt,
  epicReviewerToolingPrompt,
  epicReviewerCodexPrompt,
  epicReviewerBuildFixPrompt,
  playWriterPrompt,
  playTesterPrompt,
  ticketRedecomposerPrompt
} from "./prompts.ts";
```

### 5b — Add the Play Writer result type

Near the top of the file, after the existing type definitions, add:

```typescript
type PlayWriterResult = {
  testsCreated: string[];  // relative paths like ["tests/epic-theming.spec.ts"]
  buildFixed: boolean;
  summary: string;
};

type PlayTesterTestResult = {
  testFile: string;
  testName: string;
  status: "passed" | "failed";
  steps: number;
  error: string | null;
};

type PlayTesterResult = {
  status: "passed" | "failed";
  summary: { total: number; passed: number; failed: number };
  results: PlayTesterTestResult[];
};
```

### 5c — Add helper: `startDevServer()`

Add this private method to the `GoalRunner` class. It starts the dev server as a background process and waits for it to be ready.

```typescript
private async startDevServer(
  cwd: string,
  command: string,
  readyMs: number
): Promise<ChildProcess> {
  const [cmd, ...args] = command.split(" ");
  const proc = spawn(cmd, args, {
    cwd,
    stdio: "ignore",
    detached: false,
    shell: process.platform === "win32"
  });
  proc.on("error", (err) => {
    console.warn(`[PlayTester] Dev server process error: ${err.message}`);
  });
  // Wait for the server to be ready before returning
  await new Promise<void>(resolve => setTimeout(resolve, readyMs));
  return proc;
}

private stopDevServer(proc: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch (err) {
    console.warn(`[PlayTester] Failed to stop dev server: ${err}`);
  }
}
```

### 5d — Add helper: `listExistingTestFiles()`

This lists existing `.spec.ts` files in the target project's `tests/` directory. Used so Play Writer knows what patterns to follow.

```typescript
private async listExistingTestFiles(targetDir: string): Promise<string[]> {
  const testsDir = `${targetDir}/tests`;
  try {
    const entries = await readdir(testsDir);
    return entries
      .filter(f => f.endsWith(".spec.ts"))
      .map(f => `tests/${f}`);
  } catch {
    return [];
  }
}
```

### 5e — Add helper: `parsePlayWriterResult()`

Play Writer outputs a FINAL_JSON block. This parses it.

```typescript
private parsePlayWriterResult(rawText: string): PlayWriterResult | null {
  const match = rawText.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    return {
      testsCreated: Array.isArray(parsed.testsCreated) ? parsed.testsCreated : [],
      buildFixed: Boolean(parsed.buildFixed),
      summary: String(parsed.summary ?? "")
    };
  } catch {
    return null;
  }
}
```

### 5f — Add helper: `parsePlayTesterResult()`

Play Tester outputs a FINAL_JSON block. This parses it.

```typescript
private parsePlayTesterResult(rawText: string): PlayTesterResult | null {
  const match = rawText.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    return {
      status: parsed.status === "passed" ? "passed" : "failed",
      summary: {
        total: Number(parsed.summary?.total ?? 0),
        passed: Number(parsed.summary?.passed ?? 0),
        failed: Number(parsed.summary?.failed ?? 0)
      },
      results: Array.isArray(parsed.results) ? parsed.results.map((r: any) => ({
        testFile: String(r.testFile ?? ""),
        testName: String(r.testName ?? ""),
        status: r.status === "passed" ? "passed" : "failed",
        steps: Number(r.steps ?? 0),
        error: r.error ?? null
      })) : []
    };
  } catch {
    return null;
  }
}
```

### 5g — Add `runPlayWriter()` method

This method runs the Play Writer agent in the review workspace. It uses qwen-cli as the primary backend, codex-cli as fallback.

```typescript
private async runPlayWriter(
  epic: EpicRecord,
  tickets: TicketRecord[],
  reviewWorkspaceId: string,
  runId: string
): Promise<PlayWriterResult> {
  const config = loadConfig();
  const worktreePath = this.db.getWorkspace(reviewWorkspaceId)!.worktreePath;

  // Run typecheck to get current build errors (if any)
  const tcResult = await this.bridge.runNamedCommand({
    workspaceId: reviewWorkspaceId,
    runId,
    ticketId: `${epic.id}__PLAY_WRITER`,
    nodeName: "playWriter",
    commandName: "typecheck",
    timeoutMs: 120_000
  }).catch(() => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }));

  const buildErrors = tcResult.exitCode !== 0
    ? `${tcResult.stdout}\n${tcResult.stderr}`.trim()
    : null;

  const existingTestFiles = await this.listExistingTestFiles(epic.targetDir);
  const ragCtx = await this.buildRagContext(epic.targetDir, `${epic.title} ${epic.goalText}`);

  const prompt = playWriterPrompt(
    { ...epic, targetDir: worktreePath },
    tickets,
    existingTestFiles,
    buildErrors,
    ragCtx
  );

  this.recordAgentStream({
    agentRole: "playWriter",
    source: "orchestrator",
    streamKind: "status",
    content: `Play Writer started${buildErrors ? " (build errors found, fixing first)" : " (build clean)"}...`,
    runId,
    epicId: epic.id
  });

  let rawText = "";

  // Primary: qwen-cli
  if (this.gateway.runEpicReviewerCodex && config.playWriterModel === "qwen-cli") {
    try {
      const result = await this.withTimeout(
        this.gateway.runEpicReviewerCodex({
          cwd: worktreePath,
          prompt,
          runId,
          epicId: epic.id,
          onStream: (e: AgentStreamPayload) => {
            this.recordAgentStream({ ...e, agentRole: "playWriter" });
            rawText += e.content ?? "";
          }
        }),
        this.epicReviewTimeoutMs,
        "Play Writer timed out"
      );
      rawText = JSON.stringify(result);
    } catch (err) {
      this.recordAgentStream({
        agentRole: "playWriter",
        source: "orchestrator",
        streamKind: "stderr",
        content: `qwen-cli failed: ${err instanceof Error ? err.message : String(err)}. Falling back to codex-cli.`,
        runId,
        epicId: epic.id
      });
      rawText = "";
    }
  }

  // Fallback: codex-cli
  if (!rawText && this.gateway.runEpicReviewerCodex) {
    try {
      const result = await this.withTimeout(
        this.gateway.runEpicReviewerCodex({
          cwd: worktreePath,
          prompt,
          runId,
          epicId: epic.id,
          onStream: (e: AgentStreamPayload) => {
            this.recordAgentStream({ ...e, agentRole: "playWriter" });
            rawText += e.content ?? "";
          }
        }),
        this.epicReviewTimeoutMs,
        "Play Writer (codex fallback) timed out"
      );
      rawText = JSON.stringify(result);
    } catch (err) {
      this.recordAgentStream({
        agentRole: "playWriter",
        source: "orchestrator",
        streamKind: "stderr",
        content: `codex-cli fallback also failed: ${err instanceof Error ? err.message : String(err)}`,
        runId,
        epicId: epic.id
      });
    }
  }

  const parsed = this.parsePlayWriterResult(rawText);

  if (!parsed || parsed.testsCreated.length === 0) {
    this.recordAgentStream({
      agentRole: "playWriter",
      source: "orchestrator",
      streamKind: "stderr",
      content: "Play Writer did not produce any test files. Skipping Play Tester loop.",
      runId,
      epicId: epic.id
    });
    return { testsCreated: [], buildFixed: false, summary: "No tests generated." };
  }

  this.recordAgentStream({
    agentRole: "playWriter",
    source: "orchestrator",
    streamKind: "assistant",
    content: `Play Writer complete. Tests created: ${parsed.testsCreated.join(", ")}. ${parsed.summary}`,
    runId,
    epicId: epic.id,
    done: true
  });

  return parsed;
}
```

### 5h — Add `runPlayTester()` method

This method runs the Play Tester agent. It starts the dev server, then runs the mediated harness with Playwright MCP tools available.

```typescript
private async runPlayTester(
  epic: EpicRecord,
  testFiles: string[],
  reviewWorkspaceId: string,
  runId: string,
  loopAttempt: number,
  previousFailures?: PlayTesterTestResult[]
): Promise<PlayTesterResult> {
  const config = loadConfig();
  const worktreePath = this.db.getWorkspace(reviewWorkspaceId)!.worktreePath;

  const previousFailuresJson = previousFailures && previousFailures.length > 0
    ? JSON.stringify(previousFailures, null, 2)
    : null;

  const prompt = playTesterPrompt(
    { ...epic, targetDir: worktreePath },
    testFiles,
    config.playwrightDevServerUrl,
    config.playwrightDevServerCommand,
    loopAttempt,
    previousFailuresJson
  );

  this.recordAgentStream({
    agentRole: "playTester",
    source: "orchestrator",
    streamKind: "status",
    content: `Play Tester started (attempt ${loopAttempt}/3). Starting dev server: ${config.playwrightDevServerCommand}`,
    runId,
    epicId: epic.id
  });

  // Start dev server in the worktree
  const devServer = await this.startDevServer(
    worktreePath,
    config.playwrightDevServerCommand,
    config.playwrightDevServerReadyMs
  );

  let rawText = "";

  try {
    // Play Tester MUST use the mediated harness so it has access to Playwright MCP tools.
    // The mediated harness is accessed via this.gateway.runGoalReviewInWorkspace.
    if (!this.gateway.runGoalReviewInWorkspace) {
      throw new Error("Mediated harness not available. Play Tester requires a mediated model.");
    }

    const result = await this.withTimeout(
      this.gateway.runGoalReviewInWorkspace({
        cwd: worktreePath,
        prompt,
        runId,
        epicId: epic.id,
        db: this.db,
        onStream: (e: AgentStreamPayload) => {
          this.recordAgentStream({ ...e, agentRole: "playTester" });
          rawText += e.content ?? "";
        }
      }),
      // Give Play Tester plenty of time — browser interactions are slow
      30 * 60 * 1000,  // 30 minutes
      "Play Tester timed out after 30 minutes"
    );
    rawText = rawText || JSON.stringify(result);
  } catch (err) {
    this.recordAgentStream({
      agentRole: "playTester",
      source: "orchestrator",
      streamKind: "stderr",
      content: `Play Tester failed: ${err instanceof Error ? err.message : String(err)}`,
      runId,
      epicId: epic.id
    });
    // Return a failed result so the loop can handle it
    return {
      status: "failed",
      summary: { total: testFiles.length, passed: 0, failed: testFiles.length },
      results: testFiles.map(f => ({
        testFile: f,
        testName: "unknown",
        status: "failed",
        steps: 0,
        error: `Play Tester agent crashed: ${err instanceof Error ? err.message : String(err)}`
      }))
    };
  } finally {
    // Always stop the dev server, even if Play Tester failed
    this.stopDevServer(devServer);
    this.recordAgentStream({
      agentRole: "playTester",
      source: "orchestrator",
      streamKind: "status",
      content: "Dev server stopped.",
      runId,
      epicId: epic.id
    });
  }

  const parsed = this.parsePlayTesterResult(rawText);

  if (!parsed) {
    this.recordAgentStream({
      agentRole: "playTester",
      source: "orchestrator",
      streamKind: "stderr",
      content: "Play Tester did not produce a valid FINAL_JSON. Treating as full failure.",
      runId,
      epicId: epic.id
    });
    return {
      status: "failed",
      summary: { total: testFiles.length, passed: 0, failed: testFiles.length },
      results: testFiles.map(f => ({
        testFile: f,
        testName: "unknown",
        status: "failed",
        steps: 0,
        error: "Play Tester produced no parseable output"
      }))
    };
  }

  this.recordAgentStream({
    agentRole: "playTester",
    source: "orchestrator",
    streamKind: "assistant",
    content: `Play Tester complete (attempt ${loopAttempt}). ${parsed.summary.passed}/${parsed.summary.total} passed.`,
    runId,
    epicId: epic.id,
    done: true
  });

  return parsed;
}
```

### 5i — Add `runPlayLoop()` method

This is the main orchestrator. It calls Play Writer once, then loops Play Tester up to 3 times. On failure it calls the Epic Decoder to re-decompose.

```typescript
/**
 * The Play Loop runs after all tickets are approved.
 * 1. Play Writer generates tests (once).
 * 2. Play Tester runs those tests.
 * 3. If tests fail, Epic Decoder re-decomposes with failure context → new tickets → repeat.
 * 4. After 3 failed attempts, escalate.
 *
 * Returns true if all tests eventually passed (caller should proceed to epic review).
 * Returns false if escalated (caller should mark epic as failed).
 */
private async runPlayLoop(
  epic: EpicRecord,
  tickets: TicketRecord[],
  reviewWorkspaceId: string,
  runId: string
): Promise<boolean> {
  const MAX_LOOP_ATTEMPTS = 3;

  // --- Play Writer (runs once, generates test files) ---
  const writerResult = await this.runPlayWriter(epic, tickets, reviewWorkspaceId, runId);

  if (writerResult.testsCreated.length === 0) {
    // No tests were generated. This could mean build errors were unresolvable,
    // or Play Writer just didn't write any tests. Skip the loop entirely.
    this.recordAgentStream({
      agentRole: "playWriter",
      source: "orchestrator",
      streamKind: "assistant",
      content: "No test files generated. Skipping Play Tester loop. Proceeding to Epic Reviewer.",
      runId,
      epicId: epic.id
    });
    return true; // Proceed to epic review
  }

  let currentTestFiles = writerResult.testsCreated;
  let previousFailures: PlayTesterTestResult[] | undefined = undefined;
  let currentTickets = tickets;

  // --- Play Tester loop ---
  for (let attempt = 1; attempt <= MAX_LOOP_ATTEMPTS; attempt++) {
    const testerResult = await this.runPlayTester(
      epic,
      currentTestFiles,
      reviewWorkspaceId,
      runId,
      attempt,
      previousFailures
    );

    if (testerResult.status === "passed") {
      // All tests passed! Proceed to Epic Reviewer.
      this.recordAgentStream({
        agentRole: "playTester",
        source: "orchestrator",
        streamKind: "assistant",
        content: `All ${testerResult.summary.total} tests passed on attempt ${attempt}. Proceeding to Epic Reviewer.`,
        runId,
        epicId: epic.id,
        done: true
      });
      return true;
    }

    // Some tests failed.
    const failingTests = testerResult.results.filter(r => r.status === "failed");
    previousFailures = failingTests;

    this.recordAgentStream({
      agentRole: "playTester",
      source: "orchestrator",
      streamKind: "stderr",
      content: `Attempt ${attempt}/${MAX_LOOP_ATTEMPTS}: ${failingTests.length} test(s) failed:\n` +
        failingTests.map(f => `  - ${f.testName} in ${f.testFile}: ${f.error}`).join("\n"),
      runId,
      epicId: epic.id
    });

    if (attempt >= MAX_LOOP_ATTEMPTS) {
      // Exhausted all attempts. Escalate.
      const failureSummary = failingTests
        .map(f => `${f.testName} (${f.testFile}): ${f.error}`)
        .join("\n");

      this.recordAgentStream({
        agentRole: "playTester",
        source: "orchestrator",
        streamKind: "stderr",
        content: `Exhausted ${MAX_LOOP_ATTEMPTS} Play Tester attempts. Escalating epic.\n\nFailing tests:\n${failureSummary}`,
        runId,
        epicId: epic.id,
        done: true
      });
      return false; // Caller will mark epic as failed
    }

    // Re-feed failures into the Epic Decoder.
    // Build a context string that tells the decoder exactly what failed and why.
    const failureContext = [
      `## Playwright Test Failures (Attempt ${attempt})`,
      "",
      "The following tests were generated for this epic and are now failing.",
      "You must decompose new tickets to fix ONLY these failing tests.",
      "Do not change tickets that are already working.",
      "",
      "## Failing Tests",
      ...failingTests.map(f => [
        `### ${f.testName}`,
        `**File:** ${f.testFile}`,
        `**Error:** ${f.error}`,
        `**Steps executed before failure:** ${f.steps}`,
      ].join("\n")),
      "",
      "## Instructions for Re-Decomposition",
      "Create tickets that fix the root cause of each failing test.",
      "Each ticket should fix exactly one failing test.",
      "Do not create tickets for tests that already pass.",
      "The test files themselves should generally NOT be changed — fix the app code instead.",
      "Only change a test file if the test itself is wrong (e.g. wrong selector, wrong URL).",
    ].join("\n");

    this.recordAgentStream({
      agentRole: "playWriter",
      source: "orchestrator",
      streamKind: "status",
      content: `Re-feeding ${failingTests.length} failures into Epic Decoder for attempt ${attempt + 1}...`,
      runId,
      epicId: epic.id
    });

    // Append the failure context to the epic's user messages and re-run the decoder.
    // The decoder will produce new tickets. We then need to execute those tickets
    // before the next Play Tester attempt.
    //
    // HOW TO DO THIS:
    // 1. Call this.runEpicDecoder(epic, runId, failureContext) — it returns new GoalDecomposition
    // 2. Save the new tickets to the DB
    // 3. Execute the new tickets (build + review) just like the initial tickets
    // 4. Then loop back to Play Tester

    const newTickets = await this.reDecomposeWithFailures(epic, failureContext, runId);

    if (newTickets.length === 0) {
      this.recordAgentStream({
        agentRole: "playWriter",
        source: "orchestrator",
        streamKind: "stderr",
        content: "Epic Decoder produced no new tickets. Skipping re-execution.",
        runId,
        epicId: epic.id
      });
      continue;
    }

    // Execute the new tickets (build + per-ticket review)
    await this.executeTickets(epic, newTickets, runId);

    // Run Epic Reviewer again on the updated state before re-testing.
    // The Epic Reviewer must consolidate the new fix tickets before Play Tester verifies.
    await this.runEpicReview(epic, [...currentTickets, ...newTickets], runId);

    // Update our ticket list
    currentTickets = [...currentTickets, ...newTickets];

    // Play Writer re-runs to update/add tests if needed, then Play Tester runs again
    // (the for loop continues to the next attempt)
  }

  return false;
}
```

### 5j — Add `reDecomposeWithFailures()` method

This calls the Epic Decoder with additional context about what failed, creates new tickets in the DB, and returns them.

```typescript
/**
 * Re-runs the Epic Decoder with failing test context appended.
 * Creates new tickets in the DB and returns them.
 * This is called when Play Tester finds failures and we need new fix tickets.
 */
private async reDecomposeWithFailures(
  epic: EpicRecord,
  failureContext: string,
  runId: string
): Promise<TicketRecord[]> {
  this.recordAgentStream({
    agentRole: "epicDecoder",
    source: "orchestrator",
    streamKind: "status",
    content: "Re-decomposing epic with test failure context...",
    runId,
    epicId: epic.id
  });

  // Build a modified epic with the failure context appended to the goal
  const epicWithContext: EpicRecord = {
    ...epic,
    goalText: `${epic.goalText}\n\n${failureContext}`
  };

  try {
    // Use the existing epic decoder. It will produce a GoalDecomposition with new tickets.
    // We use the same method that the initial decode uses.
    const decomposition = await this.runEpicDecoder(epicWithContext, runId);

    if (!decomposition || !decomposition.tickets || decomposition.tickets.length === 0) {
      this.recordAgentStream({
        agentRole: "epicDecoder",
        source: "orchestrator",
        streamKind: "stderr",
        content: "Epic Decoder returned no tickets for the failure context.",
        runId,
        epicId: epic.id
      });
      return [];
    }

    // Create the new tickets in the DB
    const newTickets: TicketRecord[] = [];
    for (const ticketPlan of decomposition.tickets) {
      // Give each ticket an ID that makes it clear it's a repair ticket
      const repairId = `${ticketPlan.id}-REPAIR-${Date.now()}`;
      const ticket = this.db.createTicket({
        id: repairId,
        epicId: epic.id,
        title: ticketPlan.title,
        description: ticketPlan.description,
        acceptanceCriteria: ticketPlan.acceptanceCriteria ?? [],
        dependencies: [],
        allowedPaths: ticketPlan.allowedPaths ?? [],
        priority: ticketPlan.priority ?? "high",
        status: "queued",
        metadata: { maxBuildAttempts: 3, sourceTicketId: repairId, isRepairTicket: true }
      });
      newTickets.push(ticket);
    }

    this.recordAgentStream({
      agentRole: "epicDecoder",
      source: "orchestrator",
      streamKind: "assistant",
      content: `Re-decomposition created ${newTickets.length} repair ticket(s): ${newTickets.map(t => t.id).join(", ")}`,
      runId,
      epicId: epic.id,
      done: true
    });

    return newTickets;

  } catch (err) {
    this.recordAgentStream({
      agentRole: "epicDecoder",
      source: "orchestrator",
      streamKind: "stderr",
      content: `Re-decomposition failed: ${err instanceof Error ? err.message : String(err)}`,
      runId,
      epicId: epic.id
    });
    return [];
  }
}
```

### 5k — Integrate `runPlayLoop()` into the epic execution flow

Find the method in `goal-runner.ts` that handles the main epic execution. It will look something like this — a method that:
1. Runs the epic decoder
2. Executes all tickets
3. Runs the epic reviewer

You need to insert `runPlayLoop()` AFTER step 3 (after the epic reviewer finishes), NOT before it.

**The Epic Reviewer runs first. Play Loop runs after.** This is because the Epic Reviewer consolidates all ticket branches into a coherent state. The Play Loop then verifies that consolidated state with real browser tests.

Look for code that looks like this pattern:

```typescript
// After all tickets complete...
await this.runEpicReview(epic, tickets, runId);
```

Change it to:

```typescript
// 1. Epic Reviewer consolidates all ticket work (existing — do not change this call)
await this.runEpicReview(epic, tickets, runId);

// 2. Play Loop verifies the consolidated result with real browser tests (NEW)
const playLoopPassed = await this.runPlayLoop(epic, tickets, runId);

if (!playLoopPassed) {
  // Tests still failing after 3 attempts. Mark epic as failed.
  this.db.updateEpic({ epicId: epic.id, status: "failed" });
  this.recordAgentStream({
    agentRole: "playTester",
    source: "orchestrator",
    streamKind: "stderr",
    content: "Epic failed: Play Tester could not get all tests passing after 3 loop attempts.",
    runId,
    epicId: epic.id,
    done: true
  });
  return;
}

// All tests passed — epic is complete and verified.
this.recordAgentStream({
  agentRole: "playTester",
  source: "orchestrator",
  streamKind: "assistant",
  content: "Epic complete. All Playwright tests passed.",
  runId,
  epicId: epic.id,
  done: true
});
```

**IMPORTANT:** The Play Loop needs its own review workspace for Play Writer and Play Tester to run in. This is a SEPARATE workspace from the one `runEpicReview()` creates internally. The `runPlayLoop()` method should create its own workspace at the start (or accept one as a parameter). Do not reuse the Epic Reviewer's internal workspace — that workspace is archived when `runEpicReview()` returns. Create a fresh one inside `runPlayLoop()` at the top, and archive it at the end.

---

## Step 6 — Environment Variables to Document

Add these to your `.env.example` file:

```bash
# Play Writer — which backend to use (qwen-cli or codex-cli)
PLAY_WRITER_MODEL=qwen-cli

# Play Tester — which mediated model to use (must be a mediated: model)
PLAY_TESTER_MODEL=mediated:qwen3:4b

# Dev server — command to start all required servers before running Playwright tests
# This runs inside the review worktree
PLAYWRIGHT_DEV_SERVER_COMMAND=yarn dev

# Dev server — URL that the app will be available at
PLAYWRIGHT_DEV_SERVER_URL=http://localhost:3000

# Dev server — how many milliseconds to wait after starting the server before running tests
# Increase this if your dev server is slow to start
PLAYWRIGHT_DEV_SERVER_READY_MS=8000
```

---

## Step 7 — TypeScript Check

After making all the above changes, run:

```bash
npx tsc --noEmit
```

Fix every error before committing. Common errors to expect:
- Missing imports (add them)
- Method doesn't exist on `GoalRunner` (check you added it to the class, not outside it)
- `runEpicDecoder` or `executeTickets` might be named differently in the actual file — read the file and use the correct method name
- The `db.updateEpic()` call might have a different signature — check `src/db/database.ts`

---

## What NOT to Change

- Do NOT change the existing `runEpicReview()` method
- Do NOT change the per-ticket builder or reviewer
- Do NOT change the ticket runner
- Do NOT change the recovery service
- Do NOT change the frontend

---

## Summary of All Changes

| File | What Changes |
|------|-------------|
| `src/types.ts` | Add `"playWriter"` and `"playTester"` to `AgentRole` |
| `src/config.ts` | Add 5 new config fields + env var reads |
| `src/apps/api.ts` | Add `playWriter` and `playTester` to `SWITCHABLE_ADAPTORS`, add to `isAgentRole()` |
| `src/orchestration/prompts.ts` | Add `playWriterPrompt()` and `playTesterPrompt()` |
| `src/orchestration/goal-runner.ts` | Add 8 new methods, integrate `runPlayLoop()` between ticket execution and epic review |
| `.env.example` | Document 5 new environment variables |
