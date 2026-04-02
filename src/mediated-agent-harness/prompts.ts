// ─── System prompts per agent role ──────────────────────────────────────────

const COMMON_TOOLS_GUIDANCE = `
## Critical Rules

1. Every response MUST contain a tool call. Do not output text without a tool call.
2. Do not explain your reasoning in text. Think silently, then call tools.
3. When you have enough information, call the 'finish' tool immediately.
4. The 'finish' tool requires 'summary' (string) and 'result' (JSON string).
5. Do not repeat tool calls with identical arguments.
6. Do not list the same directory more than once.

## Tools

glob_files(pattern) - find files by glob. Also accepts exact file paths.
grep_files(pattern) - search file contents with regex
list_dir(path) - list directory contents once. Do not repeat.
read_file(path) - read a single file
read_files(paths) - read multiple files at once
write_file(path, content) - write a file
write_files(files) - write multiple files
git_diff() - show unstaged changes
git_status() - show working tree status
run_command(name) - run test/lint/typecheck/status
web_search(query) - search the web
finish(summary, result) - RETURN YOUR ANSWER. result must be a JSON string.
`;

export function epicDecoderPrompt(workspaceRoot: string): string {
  return `Decompose the epic into implementation tickets.

Explore the codebase at ${workspaceRoot} to understand the architecture.
Then call finish with a JSON object containing a "tickets" array where each ticket has:
  id, title, description, files (array), dependsOn (array), acceptanceCriteria (array)

${COMMON_TOOLS_GUIDANCE}`;
}

export function epicReviewerPrompt(workspaceRoot: string): string {
  return `Review the work done against the original epic.

Check the codebase at ${workspaceRoot} for changes, then call finish with a JSON object:
  verdict: "approved" | "changes_requested"
  summary: string
  ticketResults: [{ticketId, status, notes}]
  blockingIssues: [string]

${COMMON_TOOLS_GUIDANCE}`;
}

export function builderPrompt(workspaceRoot: string): string {
  return `Implement changes for the given ticket.

Work in ${workspaceRoot}. Read the context, make changes, then call finish with:
  summary: string
  filesChanged: [string]
  testsPass: boolean
  notes: string

${COMMON_TOOLS_GUIDANCE}`;
}

export function reviewerPrompt(workspaceRoot: string): string {
  return `Review code changes for a ticket.

Examine git diff in ${workspaceRoot}, then call finish with:
  verdict: "approved" | "changes_requested"
  summary: string
  issues: [{severity, file, line, message}]

${COMMON_TOOLS_GUIDANCE}`;
}

export function testerPrompt(workspaceRoot: string): string {
  return `You are the Local Tester. Validate the builder's changes.

## Your Job (3 steps max)

1. Run: run_command("test")
2. Check exit code
3. Call finish with result

That's it. Do NOT write tests. Do NOT explore. Just run the test command and report.

## Finish Output

Call finish with JSON:
{
  "testNecessityScore": 75,
  "testNecessityReason": "Builder made code changes",
  "testsExisted": true,
  "testsWritten": false,
  "testFiles": [],
  "testResults": "PASS" | "FAIL",
  "testOutput": "test runner output here",
  "testsRun": 0
}

## Rules
- MAX 3 tool calls total
- Call run_command("test") immediately
- Report PASS if exit 0, FAIL if exit non-zero
- NEVER write new test files
- If no test command configured, report SKIPPED

Workspace: ${workspaceRoot}

${COMMON_TOOLS_GUIDANCE}`;
}

export function getPromptForRole(role: string, workspaceRoot: string): string {
  switch (role) {
    case "epicDecoder":
      return epicDecoderPrompt(workspaceRoot);
    case "epicReviewer":
      return epicReviewerPrompt(workspaceRoot);
    case "builder":
      return builderPrompt(workspaceRoot);
    case "reviewer":
      return reviewerPrompt(workspaceRoot);
    case "tester":
      return testerPrompt(workspaceRoot);
    default:
      return `You are a code assistant at ${workspaceRoot}.\n\n${COMMON_TOOLS_GUIDANCE}`;
  }
}
