import type {
  CoderOutput,
  EditOperation,
  EpicRecord,
  ExplorerOutput,
  GoalTicketPlan,
  ReviewerVerdict,
  TicketContextPacket,
  TicketEpicReviewPacket,
  TicketRecord
} from "../types.ts";
import { type VerificationResult } from "./verifier.ts";
import { getCompactToolContract, getAvailableToolsList } from "../mediated-agent-harness/tools.ts";
import type { BuiltContext } from "../rag/context-builder.ts";

// ─── Executor constraint by coder model size ──────────────────────────────────

function executorConstraint(coderModel?: string): string {
  const m = (coderModel ?? "").toLowerCase();
  // Large cloud / remote mediated models — can handle more complex tickets
  if (m.startsWith("zai:") || m.startsWith("anthropic-mediated:glm-4.7") || m.startsWith("anthropic-mediated:glm-5.1")) {
    return [
      "EXECUTOR CONSTRAINT: Tickets will be executed by a capable remote model with strong reasoning and tool use.",
      "Tickets should be well-scoped and clear, but can be moderately complex — up to 5 files per ticket is fine.",
      "Prefer splitting large features into smaller tickets for parallelism and easier review, not because the executor is weak.",
    ].join("\n");
  }
  if (m.startsWith("anthropic-mediated:") || m.startsWith("mediated:glm-4.7") || m.startsWith("mediated:glm-5.1")) {
    return [
      "EXECUTOR CONSTRAINT: Tickets will be executed by a remote or mediated model with solid reasoning and tool use.",
      "Tickets should be well-scoped and clear, but can be moderately complex — up to 5 files per ticket is fine.",
      "Still prefer splitting large features into smaller tickets for parallelism and easier review.",
    ].join("\n");
  }
  // 30B+ models — moderate complexity
  if (m.includes("30b") || m.includes("27b") || m.includes("24b") || m.includes("26b")) {
    return [
      "EXECUTOR CONSTRAINT: Every ticket will be executed by a 20-30B model with limited reasoning. Tickets MUST be trivially simple — one cohesive change, 1-3 files max, zero ambiguity. Prefer 8-12 small tickets over 3 large ones.",
    ].join("\n");
  }
  // Small models (<14B) — strictest constraints
  return [
    "EXECUTOR CONSTRAINT: Every ticket will be executed by a small (<14B) model with very limited reasoning and a short context window. Tickets MUST be minimal — one change in 1-2 files max, zero ambiguity, no exploration needed. Prefer 12-16 tiny tickets over 4 larger ones. Each ticket description must be completely self-contained.",
  ].join("\n");
}

type EpicReviewerTicketGitContext = {
  ticketId: string;
  baseRef: string | null;
  headRef: string | null;
  allowedPaths: string[];
  branchName?: string | null;
  hasWorkspaceChanges?: boolean;
};

function promptShellQuote(value: string): string {
  return JSON.stringify(String(value ?? "").replace(/\\/g, "/"));
}

function buildPromptPathArgs(paths: string[]): string {
  const normalized = (paths ?? [])
    .map((pathValue) => String(pathValue || "").trim())
    .filter(Boolean)
    .map((pathValue) => pathValue.replace(/\\/g, "/"))
    .filter((pathValue) => pathValue !== "*" && pathValue !== ".");

  return normalized.length ? ` -- ${normalized.map(promptShellQuote).join(" ")}` : "";
}


export function epicDecoderPrompt(epic: EpicRecord, coderModel?: string): string {
  return [
    "You are the Goal Decomposer. Break the epic into detailed, self-contained tickets.",
    "",
    executorConstraint(coderModel),
    "",
    "TICKET QUALITY REQUIREMENTS:",
    "Each ticket description MUST use this EXACT format (one-liner intro, then WHAT/WHERE/HOW/WHY sections):",
    "",
    "In path/to/file.tsx, replace the X with Y — matching the existing Z pattern.",
    "",
    "WHAT: Modify file.tsx only. WHERE: Replace the block (lines 32-63) that contains X elements. HOW:",
    "- Import NewComponent from @scope/package",
    "- Replace X elements with a map rendering NewComponent with props={...}",
    "- Follow the exact pattern from path/to/existing.tsx lines 100-120",
    "- Remove the now-unused OldComponent import if no other usage remains",
    "WHY: NewComponent provides a styled, consistent UI matching the rest of the app.",
    "",
    "acceptanceCriteria MUST be specific and testable:",
    "- BAD: 'UI looks good', 'Component works correctly'",
    "- GOOD: 'Component renders a <table> with columns [Name, Qty, Revenue]', 'Clicking the Revenue toggle sorts rows descending by qty * price'",
    "",
    "TDD REQUIREMENT: Every ticket MUST include at least one test-related acceptance criterion specifying:",
    "- The test file path (e.g., 'tests/unit/foo.test.ts' or '__tests__/foo.test.ts')",
    "- The expected behavior to assert (e.g., 'foo() returns 42 when input is 7')",
    "- Example: 'Test file tests/math.test.ts passes: expect(add(2,3)).toBe(5)'",
    "",
    "dependencies: list ticket IDs that MUST complete before this one starts. Use this to enforce build order (e.g. install deps before using them, create types before importing them).",
    "",
    "Return JSON only with shape:",
    JSON.stringify({
      summary: "string — decomposition strategy",
      tickets: [
        {
          id: "string — e.g. AN-01",
          title: "string — short imperative, e.g. 'Add Revenue column to TopItemsTable'",
          description: "string — multi-line with files, patterns, imports, and implementation details",
          acceptanceCriteria: ["string — specific, testable criteria"],
          dependencies: ["string — ticket IDs"],
          priority: "high|medium|low",
          testSpecs: ["string — test assertions, e.g. 'expect(add(2,3)).toBe(5)'"]
        }
      ]
    }, null, 2),
    `Epic: ${epic.title}`,
    `Goal: ${epic.goalText}`
  ].join("\n\n");
}

export function builderPrompt(ticket: TicketRecord, packet: TicketContextPacket): string {
  const sections = [
    "You are the Local Builder.",
    "Return JSON only with shape:",
    JSON.stringify({
      summary: "string",
      intendedFiles: ["string"],
      operations: [{ kind: "replace_file", path: "string", content: "string" }]
    }, null, 2),
  ];

  // Inject RAG context if available
  if (packet.retrievedContext) {
    if (packet.retrievedContext.docContext) {
      sections.push(packet.retrievedContext.docContext);
    }
    if (packet.retrievedContext.codeContext) {
      sections.push(packet.retrievedContext.codeContext);
    }
  }

  sections.push(
    `Ticket: ${ticket.title}`,
    `Description: ${ticket.description}`,
    `Acceptance criteria: ${(ticket.acceptanceCriteria ?? []).join("; ")}`,
    `Allowed paths: ${ticket.allowedPaths.join(", ") || "(none)"}`,
    `Review blockers: ${packet.reviewBlockers.join("; ") || "(none)"}`,
    `Prior test failures: ${(packet.priorTestFailures ?? []).join("; ") || "(none)"}`,
    "Before making changes, read `.closedloop/PROJECT_STRUCTURE.md` from disk if it exists, then use the injected Project Structure snapshot.",
    "Follow the styling rules, component conventions, and UI elements described there.",
    "Preserve the existing design system and styling approach; extend it instead of inventing a new one.",
    "For Tamagui / React Native / mobile code, use Tamagui or existing native primitives and styling patterns. Do NOT introduce raw HTML tags like `div`, `span`, `button`, or `input` in mobile-facing code.",
    "Do not overwrite `.closedloop/PROJECT_STRUCTURE.md`.",
    ...(packet.retrievedContext?.projectStructure
      ? [`## Project Structure\n${packet.retrievedContext.projectStructure}`]
      : []),
    "Generate only minimal targeted changes."
  );

  return sections.join("\n\n");
}

export function builderToolingPrompt(ticket: TicketRecord, packet: TicketContextPacket): string {
  const role = "builder";
  const availableTools = getAvailableToolsList(role);
  const toolContract = getCompactToolContract(availableTools);

  const sections = [
    "Work inside the current repository using the tools that are actually available in this session.",
    toolContract,
    "Start by using the 'explore_mode' tool to rapidly gather context from the repository structure and key files.",
    "Before editing, read `.closedloop/PROJECT_STRUCTURE.md` from disk if it exists, then use the injected Project Structure snapshot.",
    "Treat `.closedloop/PROJECT_STRUCTURE.md` as the source of truth for styling, UI elements, and compatibility constraints.",
    "Preserve the existing design system and styling approach; extend it instead of inventing a new one.",
    "For Tamagui / React Native / mobile code, use Tamagui or existing native primitives and styling patterns. Do NOT introduce raw HTML tags like `div`, `span`, `button`, or `input` in mobile-facing code.",
    "Do not overwrite `.closedloop/PROJECT_STRUCTURE.md`.",
    ...(packet.retrievedContext?.projectStructure
      ? [`## Project Structure\n${packet.retrievedContext.projectStructure}`]
      : []),
    "Do not ask the user for clarification or request unavailable tools. Just inspect the workspace and make the change.",
  ];

  // Inject RAG context if available
  if (packet.retrievedContext) {
    if (packet.retrievedContext.toolContext) {
      sections.push(packet.retrievedContext.toolContext);
    }
    if (packet.retrievedContext.docContext) {
      sections.push(packet.retrievedContext.docContext);
    }
    if (packet.retrievedContext.codeContext) {
      sections.push(packet.retrievedContext.codeContext);
    }
    sections.push(
      `[Context retrieved via ${packet.retrievedContext.retrievalMode} search: ${packet.retrievedContext.chunkCount} chunks]`
    );
  }

  sections.push(
    `Ticket: ${ticket.title}`,
    `Description: ${ticket.description}`,
    `Acceptance criteria: ${(ticket.acceptanceCriteria ?? []).join("; ")}`,
    `Allowed paths: ${ticket.allowedPaths.join(", ") || "(none)"}`,
    `Review blockers: ${packet.reviewBlockers.join("; ") || "(none)"}`,
    `Prior test failures: ${(packet.priorTestFailures ?? []).join("; ") || "(none)"}`,
    "CRITICAL: You MUST make actual code changes. Do NOT decide that existing code is sufficient without reading the relevant files first.",
    "If ANY acceptance criterion is not fully met, you MUST write code to address it. Vague statements like 'existing implementation satisfies' are not acceptable.",
    "If ALL acceptance criteria are already met (you verified by reading the actual files), produce an empty operations array and explain in the summary. Do NOT write identity transforms.",
    "NEVER output 'retry_builder' or 'no changes needed'. If genuinely complete, write a trivial change and explain which criteria were already met.",
    "Make the smallest safe set of changes needed.",
    "After you finish, output exactly one FINAL_JSON block and nothing after it.",
    '<FINAL_JSON>{"summary":"brief summary of changes"}</FINAL_JSON>'
  );

  return sections.join("\n\n");
}


export function reviewerPrompt(
  ticket: TicketRecord,
  coderOutput: CoderOutput | null,
  verificationResult: VerificationResult | null,
  diff: string,
  legacyContext?: string
): string {
  return [
    "You are the Local Reviewer.",
    "A deterministic guard has already checked destructive changes, allowed paths, and project-structure invariants.",
    "Focus on semantic correctness, obvious regressions, and whether the diff satisfies the ticket.",
    "Use `.closedloop/PROJECT_STRUCTURE.md` as the source of truth for styling, UI elements, and compatibility constraints when present.",
    "IMPORTANT: The diff below shows changes in an isolated ticket workspace (a copy of the repo), NOT the original repo.",
    "Files being created/modified ARE in the correct location if they appear in the diff.",
    "Do NOT reject changes because files 'don't exist in project root' - they are being created in this workspace.",
    "CRITICAL: If the diff shows a file being created with the correct name and path, APPROVE it.",
    "Do NOT invent blockers about files 'not being in the diff' when the diff clearly shows file creation.",
    "BLOCKERS vs SUGGESTIONS:",
    "- Blockers are ONLY: syntax errors, wrong file names (e.g. wrong.js instead of right.js), wrong file paths, security issues, or changes that actively break the codebase.",
    "- In Tamagui / React Native / mobile-facing code, using raw HTML tags (div, span, button, input, etc.) is a BLOCKER unless the file is clearly web-only.",
    "- Changes that ignore the established styling system or replace existing design primitives with incompatible ones are BLOCKERS.",
    "- Missing type annotations, missing module exports, missing comments, style preferences, or 'best practices' for simple scripts are SUGGESTIONS, NOT blockers.",
    "- For simple files (hello world, scripts, standalone files), do NOT block on missing exports or type annotations. These are optional improvements.",
    "- If the diff shows a file with the expected name being created, that is sufficient evidence the file exists. APPROVE.",
    "- If the file meets the acceptance criteria at a basic level, approve it. Suggestions can be noted but must NOT prevent approval.",
    "Return JSON only with shape:",
    JSON.stringify({
      approved: true,
      blockers: ["string"],
      suggestions: ["string"],
      riskLevel: "low"
    }, null, 2),
    `Ticket: ${ticket.title}`,
    `Acceptance criteria: ${ticket.acceptanceCriteria.join("; ")}`,
    ...(coderOutput ? [`Coder Summary: ${coderOutput.summary}`, `Intended Files: ${coderOutput.intendedFiles.join(", ")}`] : []),
    ...(verificationResult ? [`Verification Result: ${verificationResult.outcome} (${verificationResult.appliedOperations.length} applied, ${verificationResult.failedOperations.length} failed)`] : []),
    "Diff:",
    diff || "(empty)",
    ...(legacyContext ? ["Legacy Context:", legacyContext] : [])
  ].join("\n\n");
}

export function reviewerToolingPrompt(ticket: TicketRecord, diff?: string): string {
  const diffSection = diff && diff.trim()
    ? [
        "## Diff to Review",
        "```diff",
        diff.slice(0, 40000),
        "```",
      ]
    : [
        "## Diff to Review",
        "Use the git_diff tool to inspect the current workspace changes. If git_diff returns empty, check git_diff_staged as well.",
      ];

  return [
    "You are the Local Reviewer.",
    "Structural rules have already been checked by a deterministic guard.",
    "Review the diff below and decide whether to approve or reject.",
    "Use `.closedloop/PROJECT_STRUCTURE.md` as the source of truth for styling, UI elements, and compatibility constraints when present.",
    "Reject diffs that introduce raw HTML tags into Tamagui / React Native / mobile-facing code unless the file is clearly web-only.",
    "Do not ask for clarification. Inspect the diff, decide, and finish.",
    "Return JSON via the finish tool with shape:",
    JSON.stringify({
      approved: true,
      blockers: ["string"],
      suggestions: ["string"],
      riskLevel: "low"
    }, null, 2),
    ...diffSection,
    `Ticket: ${ticket.title}`,
    `Description: ${ticket.description}`,
    `Acceptance criteria: ${ticket.acceptanceCriteria.join("; ")}`
  ].join("\n\n");
}



export function explorerPrompt(ticket: TicketRecord, packet: TicketContextPacket, seedFiles?: string[]): string {
  const seedSection = seedFiles && seedFiles.length > 0
    ? "PRE-DISCOVERED FILES (you do NOT need to re-read these):\n" + seedFiles.map(f => `  - ${f}`).join("\n")
    : "";

  return [
    "You are the Explorer agent.",
    "Analyze the ticket requirements and the provided context to determine which files need to be read or modified.",
    "Return a structured analysis with: relevant files, recommended files for coding, key patterns to follow, and any blockers.",
    "",
    "TOOL USAGE STRATEGY:",
    "PREFER explore_mode for ALL file discovery. It batches multiple read-only calls efficiently.",
    "Use explore_mode to: read_file, read_files, glob_files, grep_files, list_dir, semantic_search, web_search.",
    "You may also call read_file, read_files, glob_files, grep_files, list_dir, semantic_search directly outside explore_mode if needed.",
    "If you need to find related files OUTSIDE the allowed paths, use glob_files and grep_files to discover them.",
    "Example: If the ticket mentions 'Orders' and 'Items', search for those files with grep_files or glob_files.",
    "DO NOT just re-read the same files. Use glob/list_dir/grep to find related schemas, models, types, and services.",
    "",
    `Ticket: ${ticket.title}`,
    `Goal: ${ticket.description}`,
    `Acceptance criteria: ${(ticket.acceptanceCriteria ?? []).join("; ")}`,
    `Allowed paths: ${(ticket.allowedPaths ?? []).join(", ")}`,
    `Review blockers from previous attempt: ${(packet.reviewBlockers ?? []).join("; ") || "(none)"}`,
    `Prior test failures: ${(packet.priorTestFailures ?? []).join("; ") || "(none)"}`,
    seedSection,
    "Return JSON only with shape:",
    JSON.stringify({
      summary: "string",
      relevantFiles: ["string"],
      recommendedFilesForCoding: ["string"],
      keyPatterns: ["string"],
      unresolvedBlockers: ["string"]
    }, null, 2),
    "After you finish, output exactly one FINAL_JSON block and nothing after it."
  ].join("\n\n");
}

export function coderPrompt(
  ticket: TicketRecord,
  explorerOutput: ExplorerOutput | null,
  allowedPaths: string[],
  reviewerContext?: { blockers: string[]; suggestions: string[] },
  skipContext?: { skipped: boolean; reason?: string },
  packet?: TicketContextPacket | null
): string {
  const sections = [
    "You are the Coder agent. Write code changes AND tests to satisfy the ticket.",
    "",
    "## How to Edit",
    "Use search_replace for targeted edits to existing files (preferred for small changes).",
    "Use write_file for new files or when rewriting most of an existing file (you MUST read it first).",
    "Use write_files for writing multiple files at once.",
    "If you need to read file contents, use read_file - do not guess or assume file contents.",
    "Write ALL files (implementation + tests) before calling finish.",
    "",
    "## Writing Tests",
    "You MUST write test files alongside implementation files.",
    "BEFORE writing any test, read an existing test file in the project to discover the test framework (vitest, jest, mocha, etc.), import style, and assertion patterns. Do NOT assume Jest - many projects use vitest with describe/it/expect but import from 'vitest'.",
    "Follow the exact import and assertion patterns you find in existing tests.",
    "Each test file should import and test the functions/components you create.",
    "Use the acceptance criteria as test assertions - every criterion should have a corresponding test.",
    "",
    ...(reviewerContext && (reviewerContext.blockers?.length || reviewerContext.suggestions?.length)
      ? [
        "## Previous Reviewer Feedback (MUST address)",
        ...(reviewerContext.blockers?.length
          ? ["Blockers (MUST resolve):", ...reviewerContext.blockers.map(b => "- " + b)]
          : []),
        ...(reviewerContext.suggestions?.length
          ? ["Suggestions:", ...reviewerContext.suggestions.map(s => "- " + s)]
          : []),
      ]
      : []),
    ...(skipContext?.skipped ? [
      "",
      "## Explorer Was Skipped",
      skipContext.reason ?? "The explorer node was bypassed for this run.",
      "Focus on the files listed in allowedPaths. If missing context, read the files you need."
    ] : []),
  ];

  if (packet?.retrievedContext) {
    if (packet.retrievedContext.projectStructure) {
      sections.push("", "## Project Structure", packet.retrievedContext.projectStructure);
    }
    if (packet.retrievedContext.toolContext) {
      sections.push("", packet.retrievedContext.toolContext);
    }
    if (packet.retrievedContext.docContext) {
      sections.push("", packet.retrievedContext.docContext);
    }
    if (packet.retrievedContext.codeContext) {
      sections.push("", packet.retrievedContext.codeContext);
    }
    sections.push("", `[Context retrieved via ${packet.retrievedContext.retrievalMode} search: ${packet.retrievedContext.chunkCount} chunks]`);
  }

  sections.push(
    "",
    "## Explorer Analysis",
    JSON.stringify(explorerOutput, null, 2),
    "",
    "## Allowed Paths",
    "You may only edit/create files within these paths:",
    ...allowedPaths.map(p => `- ${p}`),
    "",
    "## Rules",
    "1. READ files listed in the explorer analysis FIRST - use read_file to read them. Do NOT guess or assume file contents.",
    "2. If retrieved context is present, use it as high-signal guidance before broad searching.",
    "3. Only use glob/grep/list_dir if the explorer analysis and retrieved context are missing a file you critically need. This should be rare.",
    "4. Every change MUST address at least one acceptance criterion. No scope drift.",
    "5. Do NOT delete or rename files unless explicitly permitted.",
    "6. If file content already matches what the acceptance criteria require, produce ZERO changes and explain in summary.",
    "7. Do NOT produce identity transforms where search === replace.",
    "8. You MUST write both implementation code AND test files. Every ticket should have at least one test file.",
    "",
    "## Finish Output",
    "Call finish with JSON:",
    JSON.stringify({
      summary: "brief summary of what you implemented",
      filesChanged: ["file1.ts", "file2.ts"],
      testFiles: ["tests/file1.test.ts"]
    }, null, 2),
    "",
    "============================================================",
    "## TICKET (YOUR PRIMARY OBJECTIVE)",
    `Title: ${ticket.title}`,
    `Goal: ${ticket.description}`,
    `Acceptance criteria:`,
    ...ticket.acceptanceCriteria.map(c => `  - ${c}`),
    "============================================================",
  );

  return sections.join("\n\n");
}
export function epicReviewerPrompt(epic: EpicRecord, tickets: TicketRecord[]): string {
  // Build structured ticket listing with ALL tickets
  const ticketListing = tickets
    .map(t => {
      const criteria = t.acceptanceCriteria.map(c => `  - ${c}`).join("\n");
      return [
        `${t.id} (${t.title}) - ${t.status}`,
        t.prUrl ? `PR: ${t.prUrl}` : "PR: (not created)",
        `Acceptance Criteria:\n${criteria}`
      ].join("\n");
    })
    .join("\n\n");

  return [
    "You are the Goal Reviewer.",
    "MODEL TARGET: Assume downstream ticket execution is done by ~14B parameter models. Keep recommendations and followups simple, explicit, and narrowly scoped.",
    "CRITICAL: All tickets in this epic have been reviewed and approved.",
    "Check each ticket's changes for destructive or risky patterns:",
    "- Large file deletions (>10 files or >1000 lines)",
    "- Security-sensitive changes (auth, tokens, env vars)",
    "- Database migrations that could cause data loss",
    "- Breaking API changes without deprecation warnings",
    "- Mass refactoring that touches >20 files",
    "If any ticket contains destructive changes, FIX THEM DIRECTLY in this workspace.",
    "",
    "Return JSON only with shape:",
    JSON.stringify({
      verdict: "approved",
      summary: "string",
      followupTickets: []
    }, null, 2),
    "",
    `Epic: ${epic.title}`,
    `Goal: ${epic.goalText}`,
    "",
    `Tickets (${tickets.length} total):`,
    ticketListing
  ].join("\n\n");
}

export function epicReviewerToolingPrompt(
  epic: EpicRecord,
  tickets: TicketRecord[],
  ragContext?: { codeContext: string; docContext: string } | null
): string {
  // Build structured ticket listing with ALL tickets
  const ticketListing = tickets
    .map(t => {
      const criteria = t.acceptanceCriteria.map(c => `  - ${c}`).join("\n");
      const paths = t.allowedPaths.join(", ");
      return [
        `Ticket: ${t.id}`,
        `Title: ${t.title}`,
        `Status: ${t.status} (APPROVED)`,
        t.prUrl ? `PR: ${t.prUrl}` : "PR: (not created)",
        `Allowed Paths: ${paths}`,
        `Description: ${t.description}`,
        `Acceptance Criteria:\n${criteria}`
      ].join("\n");
    })
    .join("\n\n");

  const sections: string[] = [
    "Review the overall epic result using the repository, ticket information, and any available artifacts.",
    "MODEL TARGET: Assume downstream ticket execution is done by ~14B parameter models. Any remediation guidance must be atomic, explicit, and file-scoped.",
    "CRITICAL: All tickets in this epic have been reviewed and approved. Proceed confidently to check integration.",
    "Your role is to check for destructive changes and cross-ticket integration issues.",
    "If you need the on-disk structure file, use `.closedloop/PROJECT_STRUCTURE.md`.",
  ];

  if (ragContext?.docContext) sections.push(ragContext.docContext);
  if (ragContext?.codeContext) sections.push(ragContext.codeContext);

  sections.push(
    "",
    "Destructive patterns to check for:",
    "- Large file deletions (>10 files or >1000 lines)",
    "- Security-sensitive changes (auth, tokens, env vars)",
    "- Database migrations that could cause data loss",
    "- Breaking API changes without deprecation warnings",
    "- Mass refactoring that touches >20 files",
    "",
    "IMPORTANT: When fixing issues, modify ONLY files within each ticket's allowed paths.",
    "This ensures fixes can be correctly attributed to the appropriate ticket.",
    "",
    "If you find destructive changes or integration issues, FIX THEM DIRECTLY.",
    "Do NOT ask for followups - apply the fixes yourself.",
    "Prefer the smallest safe patch that resolves conflicts between tickets.",
    "",
    "NOTE: Ticket code changes are STAGED but NOT COMMITTED in the workspace.",
    "Use `git diff --staged` (not `git diff`) to see the ticket changes.",
    "Use `git status --short` to see all modified/new files.",
    "",
    "Use the OpenCode tools that are available in-session: read, glob, grep, edit, write, task, todowrite, and skill.",
    "Do not call shell-style tools like bash, ls, find, or run unless they are explicitly available.",
    "",
    `Epic: ${epic.title}`,
    `Goal: ${epic.goalText}`,
    "",
    `Tickets in this epic (${tickets.length} total, ONLY review these):`,
    ticketListing,
    "",
    "Return exactly one FINAL_JSON block and nothing after it.",
    '<FINAL_JSON>{"verdict":"approved|needs_followups|failed","summary":"brief summary","followupTickets":[]}</FINAL_JSON>'
  );

  return sections.join("\n\n");
}

export function doctorPrompt(input: {
  ticket: TicketRecord;
  reviewerVerdict: ReviewerVerdict | null;
  testSummary: string | null;
  repeatedBlockers: boolean;
  repeatedTestFailure: boolean;
  noDiff: boolean;
  infraFailure: boolean;
  currentNode?: string | null;
  reviewApproved?: boolean;
}): string {
  return [
    "You are the Agent Doctor. Determine how to recover from a failed agent step.",
    "",
    "Return JSON only with shape:",
    JSON.stringify({ decision: "retry_builder", reason: "string" }, null, 2),
    "",
    "Decisions: retry_builder (restart coder from scratch), retry_same_node (retry current agent), escalate (give up), approve (accept current state as done)",
    "",
    "CRITICAL RULES:",
    "- NEVER choose 'approve' unless the reviewer has explicitly approved (reviewApproved=true).",
    "- noDiff=true means the coder produced NOTHING — this is a failure, not success. Always retry_builder.",
    "- Do NOT assume code from other tickets or previous runs satisfies this ticket's acceptance criteria.",
    "- If the reviewer rejected with blockers, retry_builder to let the coder try again.",
    "- Only choose 'escalate' if the same blocker or test failure has repeated multiple times.",
    "- On stalls or infra failures, always retry_builder.",
    "",
    `Ticket: ${input.ticket.title}`,
    `Current node: ${input.currentNode ?? "unknown"}`,
    `Review approved: ${String(input.reviewApproved ?? false)}`,
    `Repeated blockers: ${String(input.repeatedBlockers)}`,
    `Repeated test failure: ${String(input.repeatedTestFailure)}`,
    `No diff: ${String(input.noDiff)}`,
    `Infrastructure failure: ${String(input.infraFailure)}`,
    `Latest review: ${JSON.stringify(input.reviewerVerdict)}`,
    `Latest test summary: ${input.testSummary ?? "(none)"}`,
  ].join("\n\n");
}

export function epicDecoderToolingPrompt(
  epic: EpicRecord,
  ragContext?: BuiltContext | null,
  projectStructure?: string | null,
  coderModel?: string,
  retryNote?: string
): string {
  const role = "epic-decoder";
  const availableTools = getAvailableToolsList(role);
  const toolContract = getCompactToolContract(availableTools);

  const sections: string[] = [
    "You are the Epic Decoder agent. Explore the repository using the OpenCode tools that are actually available in-session.",
    toolContract,
    "Do not try to call bash, ls, find, run, or any other unavailable shell tool.",
    "If you need the on-disk structure file, use `.closedloop/PROJECT_STRUCTURE.md`.",
    "Understand the codebase structure, existing patterns, and conventions before decomposing the epic.",
    `Epic: ${epic.title}`,
    `Goal: ${epic.goalText}`,
    retryNote ? `PREVIOUS ATTEMPT FEEDBACK:\n${retryNote}` : "",
    [
      "EXECUTOR CONSTRAINT — read this before writing a single ticket:",
      executorConstraint(coderModel),
      "This means every ticket MUST be:",
      "  - Atomic — one coherent, self-contained change only",
      "  - Narrow — touches 1-3 files at most; never spans the whole codebase",
      "  - Explicit — the description and acceptance criteria must be so clear that no further discovery is needed",
      "  - Small — the full change should fit comfortably in a single LLM response",
      "If a task feels large or multi-faceted, SPLIT IT. Prefer 10 simple tickets over 4 complex ones.",
      "Do NOT create tickets like 'Implement the feature end-to-end' or 'Refactor the module'. Break those into individual file-level changes.",
      "Every ticket must include allowedPaths and use forward slashes in all paths.",
    ].join("\n"),
    "",
    [
      "TICKET QUALITY REQUIREMENTS — every ticket MUST have:",
      "",
      "Description MUST use this EXACT format (one-liner intro, then WHAT/WHERE/HOW/WHY sections):",
      "",
      "In path/to/file.tsx, replace the X with Y — matching the existing Z pattern.",
      "",
      "WHAT: Modify file.tsx only. WHERE: Replace the block (lines 32-63) that contains X elements. HOW:",
      "  - Import NewComponent from @scope/package",
      "  - Replace X elements with a map rendering NewComponent with props={...}",
      "  - Follow the exact pattern from path/to/existing.tsx lines 100-120",
      "  - Remove the now-unused OldComponent import if no other usage remains",
      "WHY: NewComponent provides a styled, consistent UI matching the rest of the app.",
      "Every ticket must include allowedPaths and use forward slashes in all paths.",
      "",
      "acceptanceCriteria must be specific and testable:",
      "  - BAD: 'UI looks good', 'Component works correctly'",
      "  - GOOD: 'Component renders a <table> with columns [Name, Qty, Revenue]'",
      "  - GOOD: 'Clicking the Revenue toggle sorts rows descending by qty * price without any API call'",
      "",
      "TDD REQUIREMENT: Every ticket MUST include at least one test-related acceptance criterion specifying:",
      "  - The test file path (e.g., 'tests/unit/foo.test.ts' or '__tests__/foo.test.ts')",
      "  - The expected behavior to assert (e.g., 'foo() returns 42 when input is 7')",
      "  - Example: 'Test file tests/math.test.ts passes: expect(add(2,3)).toBe(5)'",
      "",
      "dependencies: list ticket IDs that MUST complete before this one starts.",
      "  - Use to enforce build order: install deps before using them, create types before importing them, build foundation components before pages that use them.",
      "All JSON paths in the final answer must use forward slashes. Do not paste raw grep/list output into JSON strings.",
    ].join("\n"),
  ];

  if (projectStructure) {
    sections.push(`## Project Structure\n\`\`\`\n${projectStructure.slice(0, 6000)}\n\`\`\``);
  }
  if (ragContext) {
    if (ragContext.toolContext) sections.push(ragContext.toolContext);
    if (ragContext.docContext) sections.push(ragContext.docContext);
    if (ragContext.codeContext) sections.push(ragContext.codeContext);
  }

  sections.push(
    "NEGATIVE EVIDENCE RULE:",
    "If prior search attempts show that a named target file/component/route does not exist, do not repeat equivalent glob/grep/semantic searches.",
    "Treat the missing target as a fact. Decompose the epic into tickets that create the missing file or use the nearest verified proxy pattern.",
    "",
    "SEARCH BUDGET RULE:",
    "For any one named target, you get at most:",
    "- 1 exact glob",
    "- 1 broader glob/grep",
    "- 1 semantic search",
    "After that, either call finish with tickets or explicitly mark the target missing. Do not continue discovery.",
    "",
    "Steps:",
    "1. Explore the repo structure with glob/grep to understand layout",
    "2. Read 1-2 representative files per area to understand existing patterns (imports, exports, component structure, function signatures)",
    "3. Decompose the epic into atomic, file-scoped tickets — each one a junior developer could execute independently",
    "4. Each ticket must have rich descriptions, specific acceptance criteria, and tight allowedPaths",
    "After you finish, output exactly one FINAL_JSON block and nothing after it.",
    `<FINAL_JSON>${JSON.stringify({
      summary: "string",
      tickets: [{
        id: "string",
        title: "string",
        description: "string",
        acceptanceCriteria: ["string"],
        dependencies: ["string"],
        allowedPaths: ["string"],
        priority: "high|medium|low",
        testSpecs: ["string — test assertions, e.g. 'expect(add(2,3)).toBe(5)'"]
      }]
    })}</FINAL_JSON>`
  );

  return sections.join("\n\n");
}

export function epicDecoderCompactPrompt(
  epic: EpicRecord,
  coderModel?: string,
  retryNote?: string
): string {
  return [
    "You are the Epic Decoder agent. This is a COMPACTED retry after a previous stall.",
    "Explore the repo QUICKLY — you already know the structure from the previous attempt.",
    "Do NOT re-read files you already understand. Focus on decomposing into tickets NOW.",
    "Do not try to call bash, ls, find, run, or any other unavailable shell tool.",
    `Epic: ${epic.title}`,
    `Goal: ${epic.goalText}`,
    retryNote ? `PREVIOUS ATTEMPT FEEDBACK:\n${retryNote}` : "",
    "",
    "EXECUTOR CONSTRAINT — read this before writing a single ticket:",
    executorConstraint(coderModel),
    "Every ticket MUST be: atomic, narrow (1-3 files), explicit, and small enough for one LLM response.",
    "",
    "NEGATIVE EVIDENCE RULE:",
    "If prior search attempts show that a named target file/component/route does not exist, do not repeat equivalent glob/grep/semantic searches.",
    "Treat the missing target as a fact. Decompose the epic into tickets that create the missing file or use the nearest verified proxy pattern.",
    "",
    "SEARCH BUDGET RULE:",
    "For any one named target, you get at most:",
    "- 1 exact glob",
    "- 1 broader glob/grep",
    "- 1 semantic search",
    "After that, either call finish with tickets or explicitly mark the target missing. Do not continue discovery.",
    "",
    "TICKET QUALITY REQUIREMENTS — every ticket MUST have:",
    "Description using WHAT/WHERE/HOW/WHY format. Specific acceptance criteria. At least one test-related criterion.",
    "Every ticket must include allowedPaths and use forward slashes in all paths.",
    "",
    "Steps:",
    "1. Quick glob/grep to confirm layout (2-3 calls max)",
    "2. Decompose into atomic, file-scoped tickets immediately",
    "3. Output FINAL_JSON",
    "",
    `<FINAL_JSON>${JSON.stringify({
      summary: "string",
      tickets: [{
        id: "string",
        title: "string",
        description: "string",
        acceptanceCriteria: ["string"],
        dependencies: ["string"],
        allowedPaths: ["string"],
        priority: "high|medium|low",
        testSpecs: ["string — test assertions"]
      }]
    })}</FINAL_JSON>`
  ].join("\n\n");
}

export function epicReviewerCodexPrompt(
  epic: EpicRecord,
  tickets: TicketRecord[],
  ragContext?: { codeContext: string; docContext: string } | null,
  projectStructure?: string | null
): string {
  // Build structured ticket listing with ALL tickets (regardless of PR status)
  const ticketListing = tickets
    .map(t => {
      const criteria = t.acceptanceCriteria.map(c => `  - ${c}`).join("\n");
      const paths = t.allowedPaths.join(", ");
      return [
        `Ticket: ${t.id}`,
        `Title: ${t.title}`,
        `Status: ${t.status} (APPROVED)`,
        t.prUrl ? `PR: ${t.prUrl}` : "PR: (not created)",
        `Allowed Paths: ${paths}`,
        `Description: ${t.description}`,
        `Acceptance Criteria:\n${criteria}`
      ].join("\n");
    })
    .join("\n\n");

  const sections: string[] = [
    "You are the Epic Reviewer agent. Review the overall epic result quickly and efficiently.",
    "MODEL TARGET: Assume downstream ticket execution is done by ~14B parameter models. Keep any fixes/followups trivially implementable in one pass.",
    "CRITICAL: All tickets in this epic have been reviewed and approved. Proceed confidently.",
    "Your role is to check for cross-ticket integration issues and fix any destructive or risky changes.",
    "If you need the on-disk structure file, use `.closedloop/PROJECT_STRUCTURE.md`.",
    "IMPORTANT: Be concise. Check git log and diffs for the ticket changes, verify they look safe, then output FINAL_JSON. Do NOT explore the entire repo.",
  ];

  if (projectStructure) {
    sections.push(`## Project Structure\n\`\`\`\n${projectStructure.slice(0, 6000)}\n\`\`\``);
  }
  if (ragContext?.docContext) sections.push(ragContext.docContext);
  if (ragContext?.codeContext) sections.push(ragContext.codeContext);

  sections.push(
    "",
    "Destructive patterns to check for:",
    "- Large file deletions (>10 files or >1000 lines)",
    "- Security-sensitive changes (auth, tokens, env vars)",
    "- Database migrations that could cause data loss",
    "- Breaking API changes without deprecation warnings",
    "- Mass refactoring that touches >20 files",
    "",
    "IMPORTANT: When you find issues to fix, modify ONLY files within each ticket's allowed paths.",
    "This ensures fixes can be correctly attributed to the appropriate PR.",
    "If an issue spans multiple tickets, apply fixes to the relevant files in each ticket's scope.",
    "",
    "If you find destructive changes or cross-ticket issues, FIX THEM DIRECTLY.",
    "Do NOT ask for followups - apply the fixes yourself, commit, and push to the respective branches.",
    "",
    `Epic: ${epic.title}`,
    `Goal: ${epic.goalText}`,
    "",
    `Tickets in this epic (${tickets.length} total, ONLY review these):`,
    ticketListing,
    "",
    "Steps:",
    "1. Check the git log and diffs for each ticket's changes in the allowed paths",
    "2. Verify acceptance criteria are met for each ticket",
    "3. Check for integration issues or conflicts between tickets",
    "4. Run tests if test commands are available",
    "5. Apply fixes directly to files within each ticket's allowed paths",
    "",
    "After you finish, output exactly one FINAL_JSON block and nothing after it.",
    '<FINAL_JSON>{"verdict":"approved|needs_followups|failed","summary":"brief summary","followupTickets":[]}</FINAL_JSON>'
  );

  return sections.join("\n\n");
}

/**
 * Unified prompt for epic review via direct CLI (codex, gemini, qwen).
 * Includes actual git diffs from ticket workspaces and reviewer packets for failing tickets.
 * The reviewer works directly on the merged review workspace and can apply fixes.
 */
export function epicReviewerDirectCliPrompt(input: {
  epic: EpicRecord;
  tickets: TicketRecord[];
  reviewPackets: Map<string, TicketEpicReviewPacket>;
  ticketGitContext?: EpicReviewerTicketGitContext[];
  ragContext?: { codeContext: string; docContext: string } | null;
  projectStructure?: string | null;
  targetBranch?: string | null;
  /** Git ref (branch or commit) that serves as the base for the review diff */
  diffBase?: string | null;
}): string {
  const { epic, tickets, reviewPackets, ticketGitContext = [], ragContext, projectStructure, targetBranch, diffBase } = input;
  const gitContextByTicket = new Map(ticketGitContext.map((entry) => [entry.ticketId, entry]));
  const holisticRange = diffBase ? `${diffBase}..HEAD` : "HEAD";

  // ── Ticket metadata sections (info the CLI cannot discover from the workspace) ──
  const ticketSections = tickets.map(t => {
    const packet = reviewPackets.get(t.id);
    const gitContext = gitContextByTicket.get(t.id);
    const criteria = t.acceptanceCriteria.map(c => `  - ${c}`).join("\n");
    const paths = t.allowedPaths.join(", ");
    const pathArgs = buildPromptPathArgs(gitContext?.allowedPaths ?? t.allowedPaths);
    const ticketRange = gitContext?.baseRef && gitContext?.headRef
      ? `${gitContext.baseRef}..${gitContext.headRef}`
      : diffBase
        ? `${diffBase}..HEAD`
        : null;

    const lines: string[] = [
      `### Ticket: ${t.id}`,
      `Title: ${t.title}`,
      `Status: ${t.status}`,
      `Description: ${t.description}`,
      `Allowed Paths: ${paths}`,
      `Acceptance Criteria:`,
      criteria,
    ];

    if (t.prUrl) {
      lines.push(`PR: ${t.prUrl}`);
    }

    lines.push("");
    lines.push("Git Review Commands:");
    if (ticketRange) {
      lines.push(`- Ticket diff: git diff ${ticketRange}${pathArgs}`);
      lines.push(`- Ticket diff stat: git diff --stat ${ticketRange}${pathArgs}`);
      lines.push(`- Ticket changed files: git diff --name-only ${ticketRange}${pathArgs}`);
    } else {
      lines.push(`- Ticket diff: git diff${pathArgs}`);
      lines.push(`- Ticket diff stat: git diff --stat${pathArgs}`);
    }
    if (gitContext?.headRef) {
      lines.push(`- Ticket commits: git log --oneline ${gitContext.headRef} -n 5`);
      lines.push(`- Final ticket commit summary: git show --stat --summary ${gitContext.headRef}`);
    }
    if (gitContext?.branchName) {
      lines.push(`- Ticket branch/worktree hint: ${gitContext.branchName}`);
    }
    if (gitContext?.hasWorkspaceChanges && !gitContext.headRef) {
      lines.push("- This ticket has staged but uncommitted changes. Use `git diff --staged` to see the changes, or `git status --short` to see modified files.");
    }

    // Include reviewer verdict for failing/problematic tickets
    if (packet) {
      lines.push("");
      lines.push(`#### Review Packet (from ticket execution)`);
      lines.push(`Disposition: ${packet.epicReviewDisposition}`);
      lines.push(`Ready for epic review: ${packet.epicReviewReadiness}`);
      if (packet.builderSummary) {
        lines.push(`Builder Summary: ${packet.builderSummary}`);
      }
      if (packet.review) {
        lines.push(`Ticket Review Verdict: ${packet.review.verdict ? "APPROVED" : "REJECTED"}`);
        if (packet.review.blockers.length > 0) {
          lines.push(`Blockers:`);
          packet.review.blockers.forEach(b => lines.push(`  - ${b}`));
        }
        if (packet.review.suggestions.length > 0) {
          lines.push(`Suggestions:`);
          packet.review.suggestions.forEach(s => lines.push(`  - ${s}`));
        }
      }
      if (packet.failure) {
        lines.push(`Failure Stage: ${packet.failure.stage}`);
        lines.push(`Failure Reason: ${packet.failure.reason}`);
      }
    }

    return lines.join("\n");
  }).join("\n\n");

  // ── System instructions ──
  const sections: string[] = [
    "You are the Epic Reviewer agent. You have access to the full workspace with all ticket changes already merged in.",
    "",
    "IMPORTANT: All ticket code changes are already present in your working directory.",
    "Changes are STAGED but NOT COMMITTED. Use `git diff --staged` to see them, or `git diff` if unstaged changes exist.",
    "Do NOT rely on embedded/truncated diffs in the prompt. Pull the git history and diffs yourself.",
    "Use git in two passes: first holistically for the whole epic, then ticket-by-ticket using the command hints below.",
    "",
    "Recommended whole-epic commands:",
    "1. Run: git status --short",
    "2. Run: git diff --staged --stat",
    "3. Run: git diff --staged",
    "4. Run: git diff --staged --name-only",
    `5. If committed changes exist: git diff ${holisticRange}`,
    "6. If the diff is large, switch to ticket-specific commands from the ticket metadata below.",
    "7. Read source files directly after locating suspicious hunks.",
    "",
    "Your job is to:",
    "1. Review ALL ticket changes against the epic goal and acceptance criteria",
    "2. Check for destructive patterns, integration issues, and missing acceptance criteria",
    "3. Use the ticket-specific git commands below to verify each ticket in isolation when needed",
    "4. FIX any issues you find DIRECTLY in the workspace",
    "5. Push your fixes to the target branch if one is specified",
    "",
    "Destructive patterns to check for:",
    "- Large file deletions (>10 files or >1000 lines)",
    "- Security-sensitive changes (auth, tokens, env vars)",
    "- Database migrations that could cause data loss",
    "- Breaking API changes without deprecation warnings",
    "- Mass refactoring that touches >20 files",
    "",
    "Pay special attention to tickets with REJECTED reviews or failures — these may have incomplete or broken changes.",
  ];

  if (targetBranch) {
    sections.push("");
    sections.push(`TARGET BRANCH: ${targetBranch}`);
    sections.push("After applying any fixes, commit them and push to this target branch.");
    sections.push("Use: git add -A && git commit -m 'epic-review-fixes' && git push origin HEAD:" + targetBranch);
  }

  if (projectStructure) {
    sections.push("");
    sections.push(`## Project Structure`);
    sections.push("```");
    sections.push(projectStructure.slice(0, 6000));
    sections.push("```");
  }

  if (ragContext?.docContext) {
    sections.push("");
    sections.push(ragContext.docContext);
  }
  if (ragContext?.codeContext) {
    sections.push("");
    sections.push(ragContext.codeContext);
  }

  sections.push("");
  sections.push(`## Epic: ${epic.title}`);
  sections.push(`Goal: ${epic.goalText}`);
  sections.push("");
  sections.push(`## Tickets (${tickets.length} total)`);
  sections.push("Each ticket's metadata is below, including git commands for isolated review. Use those commands instead of relying on prompt-injected diffs.");
  sections.push(ticketSections);
  sections.push("");
  sections.push("## Instructions");
  sections.push("1. Start with `git diff --staged` to see all staged (uncommitted) changes");
  sections.push(`2. If there are also committed changes, check: \`git diff ${holisticRange}\``);
  sections.push("3. For each ticket, run the ticket-specific `git diff` command listed in that ticket section to inspect only its scoped paths");
  sections.push("3. Cross-reference each ticket's changes against its acceptance criteria above");
  sections.push("4. Check for cross-ticket integration issues (conflicting changes, missing imports, broken shared types, etc.)");
  sections.push("5. If you find issues, FIX THEM DIRECTLY by editing the files");
  sections.push("6. Commit and push any fixes to the target branch");
  sections.push("7. Do NOT create followup tickets unless the issue cannot be fixed");
  sections.push("");
  sections.push("After you finish, output exactly one FINAL_JSON block and nothing after it.");
  sections.push('<FINAL_JSON>{"verdict":"approved|needs_followups|failed","summary":"brief summary","followupTickets":[]}</FINAL_JSON>');

  return sections.join("\n");
}

/**
 * Prompt for a build-fix pass: the reviewer already ran once, build checks
 * revealed errors, and now the model must fix them directly.
 */
export function epicReviewerBuildFixPrompt(
  epic: EpicRecord,
  _tickets: TicketRecord[],
  buildErrors: string,
  round: number
): string {
  return [
    `You are the Epic Reviewer performing build-fix pass ${round}.`,
    "The codebase still has build / typecheck errors that must be resolved before this epic can be approved.",
    "",
    "## Build / typecheck errors",
    buildErrors,
    "",
    `## Epic: ${epic.title}`,
    epic.goalText,
    "",
    "## Instructions",
    "1. Read each file mentioned in the errors above.",
    "2. Fix every error by editing the relevant source files.",
    "3. You may edit ANY file in the codebase needed to resolve the errors — do not limit yourself to specific paths.",
    "4. When all errors are resolved, output exactly one FINAL_JSON block:",
    '<FINAL_JSON>{"verdict":"approved","summary":"Fixed all build errors.","followupTickets":[]}</FINAL_JSON>',
    "",
    "If errors remain that you cannot fix, describe them as follow-up tickets:",
    '<FINAL_JSON>{"verdict":"needs_followups","summary":"...","followupTickets":[{"id":"BUILD-FIX-1","title":"Fix remaining build errors","description":"...","acceptanceCriteria":["All typecheck errors resolved"],"priority":"high","dependencies":[],"allowedPaths":["src/"]}]}</FINAL_JSON>',
    "",
    "Focus entirely on fixing the errors. Do NOT make unrelated changes.",
  ].join("\n");
}

export function ticketRedecomposerPrompt(
  epic: EpicRecord,
  ticket: TicketRecord,
  reviewerBlockers: string[],
  coderModel?: string
): string {
  const blockerBlock = reviewerBlockers.length
    ? reviewerBlockers.map((b, i) => `  Attempt ${i + 1}: ${b}`).join("\n")
    : "  (no recorded blockers — builder produced no diff or crashed)";

  const sections: string[] = [
    "You are the Ticket Re-decomposer.",
    "A builder agent has exhausted its retry budget on the ticket below without producing an approved result.",
    "Your job is NOT to fix the code yourself. Instead, analyse why the ticket was too broad or ambiguous for a 20–30B executor model, then re-decompose it into 2–4 simpler, strictly atomic sub-tickets.",
    `Epic: ${epic.title}`,
    `Epic Goal: ${epic.goalText}`,
    `Current Re-decomposition Depth: ${Number((ticket.metadata as any)?.splitDepth ?? 0)} / 2`,
    [
      "## Failed Ticket",
      `Title: ${ticket.title}`,
      `Description: ${ticket.description}`,
      `Acceptance Criteria:\n${ticket.acceptanceCriteria.map((c) => `  - ${c}`).join("\n")}`,
      `Allowed Paths: ${ticket.allowedPaths.join(", ") || "(unrestricted)"}`,
    ].join("\n"),
    [
      "## Reviewer Blockers Across All Attempts",
      blockerBlock,
    ].join("\n"),
    [
      "## Instructions",
      "1. Use read/glob/grep to inspect the specific files in allowedPaths",
      "2. Understand precisely what the original ticket was asking for",
      "3. Identify why the executor model kept failing — wrong API, too many files at once, ambiguous scope, etc.",
      "4. Split the work into 2–4 sub-tickets, each touching at most 1–2 files",
      "5. Every sub-ticket must be self-contained: its description alone must be enough to implement it with no additional discovery",
    ].join("\n"),
    [
      `⚠️ EXECUTOR CONSTRAINT: Each sub-ticket will be run by the coder model. ${executorConstraint(coderModel)}`,
      "  • Atomic — one coherent change only",
      "  • Narrow — 1–2 files at most; tight allowedPaths",
      "  • Explicit — include the exact function/class name, file path, and expected signature in the description",
      "  • No ambiguity — if the original ticket was vague, be precise here",
      "Use IDs: RSUB1, RSUB2, RSUB3, RSUB4 (only as many as needed).",
    ].join("\n"),
    "After your analysis, output exactly one FINAL_JSON block and nothing after it.",
    `<FINAL_JSON>${JSON.stringify({
      summary: "string — why the original ticket failed and how you split it",
      tickets: [{
        id: "RSUB1",
        title: "string",
        description: "string — explicit enough that no further discovery is needed",
        acceptanceCriteria: ["string"],
        dependencies: [],
        allowedPaths: ["string"],
        priority: "high|medium|low"
      }]
    })}</FINAL_JSON>`,
  ];

  return sections.join("\n\n");
}

export function epicDecoderPlanModePrompt(
  epicTitle: string,
  epicDescription: string,
  userMessages: string[],
  projectStructure?: string | null,
  ragContext?: { codeContext: string; docContext: string } | null,
  coderModel?: string
): string {
  const sections: string[] = [
    "You are the Epic Planner agent. Your job is to collaboratively explore the repository and produce a thorough, well-scoped implementation plan.",
    "Use read, glob, grep, and any available tools to understand the codebase before committing to a plan.",
    "Do not try to call bash, ls, find, run, or any other unavailable shell tool.",
    "If you need the on-disk structure file, use `.closedloop/PROJECT_STRUCTURE.md`.",
    `Epic Title: ${epicTitle}`,
    `Epic Description: ${epicDescription}`,
  ];

  if (projectStructure) {
    sections.push(`## Project Structure\n\`\`\`\n${projectStructure.slice(0, 6000)}\n\`\`\``);
  }

  if (ragContext?.docContext) sections.push(ragContext.docContext);
  if (ragContext?.codeContext) sections.push(ragContext.codeContext);

  if (userMessages.length > 0) {
    const msgBlock = userMessages.map((m, i) => `${i + 1}. ${m}`).join("\n");
    sections.push(`## Additional Context from User\n\n${msgBlock}`);
  }

  sections.push(
    "## Your Planning Approach",
    "1. Explore the repo structure — read key files, understand existing patterns and architecture",
    "2. Identify what is already implemented vs what needs to be built",
    "3. Note ambiguities, risks, or things you are unsure about",
    "4. If a critical ambiguity would materially change ticket boundaries or acceptance criteria, pause and ask concise clarification questions instead of guessing",
    "5. Otherwise, decompose the epic into well-scoped, independently executable tickets",
    "6. Each ticket must have clear acceptance criteria, file scope (allowedPaths), dependencies, and priority",
    "Think carefully. Be specific about what each ticket changes and why.",
    [
      "⚠️ EXECUTOR CONSTRAINT — critical for ticket design:",
      executorConstraint(coderModel),
      "Design every ticket so the coder model can succeed without needing to explore the broader codebase.",
      "Rules for each ticket:",
      "  • Atomic: one coherent change only — no 'and also' tickets",
      "  • Narrow: 1–3 files touched at most; use tight allowedPaths",
      "  • Self-contained: the description alone must be enough to implement it — no implicit knowledge required",
      "  • Small: the change should fit in a single model response",
      "When in doubt, split. 12 simple tickets are far better than 5 complex ones.",
      "Avoid vague titles like 'Update module X' — be precise: 'Add exportFoo() to src/foo.ts'.",
      "",
      "Description MUST use this EXACT format (one-liner intro, then WHAT/WHERE/HOW/WHY sections):",
      "",
      "In path/to/file.tsx, replace the X with Y — matching the existing Z pattern.",
      "",
      "WHAT: Modify file.tsx only. WHERE: Replace the block (lines 32-63) that contains X elements. HOW:",
      "  - Import NewComponent from @scope/package",
      "  - Replace X elements with a map rendering NewComponent with props={...}",
      "  - Follow the exact pattern from path/to/existing.tsx lines 100-120",
      "WHY: NewComponent provides a styled, consistent UI matching the rest of the app.",
      "Every ticket must include allowedPaths and use forward slashes in all paths.",
      "",
      "TDD REQUIREMENT: Every ticket MUST include at least one test-related acceptance criterion specifying:",
      "  - The test file path (e.g., 'tests/unit/foo.test.ts' or '__tests__/foo.test.ts')",
      "  - The expected behavior to assert (e.g., 'foo() returns 42 when input is 7')",
      "  - Example: 'Test file tests/math.test.ts passes: expect(add(2,3)).toBe(5)'",
    ].join("\n"),
    "## Required Output Format",
    [
      "Before outputting FINAL_JSON, you MUST write a structured analysis in plain text so the user can follow your reasoning. Use this exact format:",
      "",
      "## Codebase Analysis",
      "[Describe what you found: key files, existing patterns, relevant architecture, important types/interfaces]",
      "",
      "## What Exists vs What Needs Building",
      "[Enumerate what is already implemented and what is missing or incomplete]",
      "",
      "## Risks & Unknowns",
      "[List ambiguities, potential issues, or things that need clarification]",
      "",
      "## Ticket Overview",
      "[For each ticket: name, 1-sentence rationale, key files it touches]",
      "",
      "Then, after this analysis, output exactly one FINAL_JSON block.",
      "If you need clarification before planning, return `tickets: []` and set `clarificationQuestions` to 1-3 specific questions the user can answer directly.",
      "Only use clarificationQuestions for genuinely plan-shaping unknowns. If the repo inspection gives enough signal, produce the full plan instead."
    ].join("\n"),
    `<FINAL_JSON>${JSON.stringify({
      summary: "brief summary of overall plan",
      clarificationQuestions: [],
      tickets: [{
        id: "string",
        title: "string",
        description: "string",
        acceptanceCriteria: ["string"],
        dependencies: ["string"],
        allowedPaths: ["string"],
        priority: "high|medium|low",
        testSpecs: ["string — test assertions, e.g. 'expect(add(2,3)).toBe(5)'"]
      }]
    })}</FINAL_JSON>`,
    `Clarification example:\n<FINAL_JSON>${JSON.stringify({
      summary: "Need a few answers before I can break this into reliable tickets.",
      clarificationQuestions: [
        "Which existing route or screen should own this feature?",
        "Should this behavior be gated behind a feature flag or replace the current flow?",
        "Do you want tests included in this epic or handled separately?"
      ],
      tickets: []
    })}</FINAL_JSON>`
  );

  return sections.join("\n\n");
}

export function ticketHardenerPrompt(input: {
  epicTitle: string;
  plannerProfile: string;
  fallbackMode: string;
  knowledgeSections: Array<{ title: string; content: string }>;
  draftTickets: GoalTicketPlan[];
}): string {
  return [
    "You are the Ticket Hardener.",
    "Rewrite the draft tickets into builder-ready tickets for a local coding model.",
    "Preserve intent and dependency order, but make each ticket narrow, explicit, and executable.",
    "Return JSON only with shape:",
    JSON.stringify({
      summary: "string",
      tickets: [{
        id: "string",
        title: "string",
        description: "string",
        acceptanceCriteria: ["string"],
        dependencies: ["string"],
        allowedPaths: ["string"],
        priority: "high|medium|low",
        nonGoals: ["string"],
        riskLevel: "low|medium|high",
        localModelNotes: ["string"],
        fallbackNotes: ["string"],
      }]
    }, null, 2),
    `Epic Title: ${input.epicTitle}`,
    `Planner profile: ${input.plannerProfile}`,
    `Fallback mode: ${input.fallbackMode}`,
    ...input.knowledgeSections.map((section) => `## ${section.title}\n${section.content}`),
    "## Draft Tickets",
    JSON.stringify(input.draftTickets, null, 2),
    [
      "Requirements:",
      "- Keep tickets atomic and self-contained.",
      "- Narrow allowedPaths to 1-3 specific paths when possible.",
      "- Replace vague acceptance criteria with specific, testable checks.",
      "- Add nonGoals that stop scope creep.",
      "- Add explicit localModelNotes for narrow execution.",
      "- If fallback mode is active, keep scope conservative and say so in fallbackNotes.",
    ].join("\n"),
  ].join("\n\n");
}

export function decompositionJudgePrompt(input: {
  epicTitle: string;
  plannerProfile: string;
  fallbackMode: string;
  knowledgeSections: Array<{ title: string; content: string }>;
  tickets: GoalTicketPlan[];
}): string {
  return [
    "You are the Decomposition Judge.",
    "Evaluate whether each ticket is ready for a local builder model.",
    "Do not rewrite tickets. Judge them and explain what must be repaired.",
    "Return JSON only with shape:",
    JSON.stringify({
      approvedTicketIds: ["string"],
      rejectedTicketIds: ["string"],
      rejectionReasons: { T1: ["string"] },
      repairSuggestions: { T1: ["string"] },
      overallConfidence: 0,
      notes: ["string"],
    }, null, 2),
    `Epic Title: ${input.epicTitle}`,
    `Planner profile: ${input.plannerProfile}`,
    `Fallback mode: ${input.fallbackMode}`,
    ...input.knowledgeSections.map((section) => `## ${section.title}\n${section.content}`),
    "## Candidate Tickets",
    JSON.stringify(input.tickets, null, 2),
    [
      "Judge criteria:",
      "- Scope is narrow.",
      "- allowedPaths are specific.",
      "- Acceptance criteria are concrete and testable.",
      "- The ticket does not rely on hidden repo context.",
      "- The ticket is safe for a local model to execute.",
      "- The ticket includes enough verification guidance.",
    ].join("\n"),
  ].join("\n\n");
}

export function ticketRepairPrompt(input: {
  epicTitle: string;
  plannerProfile: string;
  fallbackMode: string;
  knowledgeSections: Array<{ title: string; content: string }>;
  rejectedTickets: GoalTicketPlan[];
  rejectionReasons: Record<string, string[]>;
  repairSuggestions: Record<string, string[]>;
}): string {
  return [
    "You are the Ticket Repair agent.",
    "Repair only the rejected tickets. Split tickets if needed, but do not invent repo facts outside the selected knowledge.",
    "Return JSON only with shape:",
    JSON.stringify({
      summary: "string",
      tickets: [{
        id: "string",
        title: "string",
        description: "string",
        acceptanceCriteria: ["string"],
        dependencies: ["string"],
        allowedPaths: ["string"],
        priority: "high|medium|low",
        nonGoals: ["string"],
        riskLevel: "low|medium|high",
        localModelNotes: ["string"],
        fallbackNotes: ["string"],
      }]
    }, null, 2),
    `Epic Title: ${input.epicTitle}`,
    `Planner profile: ${input.plannerProfile}`,
    `Fallback mode: ${input.fallbackMode}`,
    ...input.knowledgeSections.map((section) => `## ${section.title}\n${section.content}`),
    "## Rejected Tickets",
    JSON.stringify(input.rejectedTickets, null, 2),
    "## Rejection Reasons",
    JSON.stringify(input.rejectionReasons, null, 2),
    "## Repair Suggestions",
    JSON.stringify(input.repairSuggestions, null, 2),
  ].join("\n\n");
}

export function remoteKnowledgeRefreshPrompt(input: {
  repoRoot: string;
  commitHash: string;
  refreshReason: string;
  localMemory: string[];
  contextPackets: Array<{ title: string; content: string }>;
  maxArtifactSize: number;
}): string {
  return [
    "You are maintaining a durable knowledgebase for weaker local coding agents.",
    "Your output must help local agents decode epics into small tickets, avoid broad or vague work, choose relevant context, respect architecture boundaries, write testable acceptance criteria, avoid known failure modes, and operate successfully with 9B/27B local models.",
    "Do not produce a generic repo summary.",
    "Do not dump raw source.",
    "Produce compact operational knowledge only.",
    "Return JSON only with this shape:",
    JSON.stringify({
      summaryOfChanges: "string",
      domainsRefreshed: ["string"],
      importantArchitectureRules: ["string"],
      updatedTicketPatterns: ["string"],
      knownFailureModes: ["string"],
      stalenessStatus: "fresh|stale|critical_stale|missing",
      warnings: ["string"],
      confidenceScore: 0,
      artifacts: [
        {
          kind: "repo_capsule|domain_map|architecture_rules|api_contract_notes|ticket_decomposition_patterns|known_failure_modes|testing_guidance|local_model_instructions|recent_change_history|staleness_report|refresh_metadata",
          title: "string",
          domains: ["string"],
          content: "string"
        }
      ]
    }, null, 2),
    `Repository root: ${input.repoRoot}`,
    `Current commit: ${input.commitHash}`,
    `Refresh reason: ${input.refreshReason}`,
    `Maximum artifact size: ${input.maxArtifactSize} characters`,
    "Required artifacts:",
    [
      "repo_capsule",
      "domain_map",
      "architecture_rules",
      "api_contract_notes",
      "ticket_decomposition_patterns",
      "known_failure_modes",
      "testing_guidance",
      "local_model_instructions",
      "recent_change_history",
      "staleness_report",
      "refresh_metadata",
    ].join(", "),
    input.localMemory.length
      ? `Recent local epic memory:\n${input.localMemory.map((line) => `- ${line}`).join("\n")}`
      : "Recent local epic memory: none available.",
    ...input.contextPackets.map((packet) => `## ${packet.title}\n${packet.content}`),
    [
      "Critical requirements:",
      "- Every artifact must be compact and actionable.",
      "- Domain map must be parseable and name major subsystems.",
      "- Architecture rules must be concrete, not vague.",
      "- Known failure modes must include prevention guidance.",
      "- Testing guidance must mention real verification categories or commands.",
      "- Local model instructions must explicitly optimize for small/local model planning.",
      "- Never include long raw code excerpts or a filesystem dump.",
    ].join("\n"),
  ].join("\n\n");
}

export function playWriterPrompt(
  epic: EpicRecord,
  tickets: TicketRecord[],
  existingTestFiles: string[],
  buildErrors: string | null,
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

  const sections: string[] = [
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
    "",
    "If you need the on-disk structure file, use `.closedloop/PROJECT_STRUCTURE.md`.",
  ];

  if (ragContext?.codeContext) sections.push("\n## Relevant Code Context\n" + ragContext.codeContext);

  sections.push(
    "",
    "## Your Instructions",
    "",
    "### Part 1: Fix Build Errors (ALL - No Scope Limits)",
    "You MUST fix ALL build/typecheck errors in the codebase, regardless of file scope.",
    "The Epic Reviewer did NOT fix build errors - you are responsible for ALL of them.",
    "If there are build errors listed above:",
    "  1. Read each file mentioned in the errors.",
    "  2. Fix the errors by editing those files.",
    "  3. You may edit ANY file in the codebase to fix the errors — no scope limits.",
    "  4. Do not skip this — tests cannot run if the build is broken.",
    "  5. Continue fixing until `npm run typecheck` passes.",
    "",
    "If there are no build errors, skip to Part 2.",
    "",
    "### Part 2: Generate SCOPED Playwright Tests",
    "Write tests that are SCOPED to this epic's changes - NOT full app tests.",
    "  1. Read 2-3 of the existing test files to understand the project's testing patterns.",
    "  2. Understand what each completed ticket actually changed in the codebase.",
    "  3. Generate Playwright test files in the `tests/` directory.",
    "  4. Tests must be SCOPED to epic features - test only what this epic introduced.",
    "  5. Each test file should test the user-visible behaviour of the epic's features.",
    "  6. Tests must use `import { test, expect } from '@playwright/test'`.",
    "  7. Each test must navigate to a real URL and interact with the actual UI.",
    "  8. Give each test file a descriptive name, e.g. `tests/epic-theming.spec.ts`.",
    "  9. Write at least 1 test per major feature the epic introduced.",
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

export function playTesterPrompt(
  epic: EpicRecord,
  testFiles: string[],
  _devServerUrl: string,
  _devServerCommand: string,
  loopAttempt: number,
  previousFailures?: string | null
): string {
  const testFilesList = testFiles.length > 0
    ? testFiles.map(f => `  - ${f}`).join("\n")
    : "  (auto-discover — run all .spec.ts files found by playwright)";

  const previousFailuresBlock = previousFailures
    ? `## Previous Loop Failures (Attempt ${loopAttempt - 1})\n\nThese tests failed in the previous attempt:\n${previousFailures}`
    : "";

  return [
    "You are Play Tester — an autonomous test runner.",
    "",
    `This is loop attempt ${loopAttempt} of 10.`,
    "",
    "## Your Job",
    "Run ALL Playwright e2e tests in this project using the run_command tool.",
    "Parse the CLI output to determine which tests passed and which failed.",
    "",
    "## Test Files in This Project",
    testFilesList,
    "",
    previousFailuresBlock,
    "",
    `## Epic: ${epic.title}`,
    epic.goalText,
    "",
    "## How to Run Tests",
    "",
    "  1. Run \"npx playwright test\" using the run_command tool.",
    "  2. Wait for the command to complete.",
    "  3. Parse the output to extract:",
    "     - Total tests run",
    "     - Number passed",
    "     - Number failed",
    "     - For each failure: test file path, test name, and error message",
    "  4. If any tests failed, re-run ONLY the failing tests to get detailed error output:",
    "     \"npx playwright test <failing-test-file> --reporter=list\"",
    "",
    "## Critical Rules",
    "  - Run the FULL test suite, not just specific files (unless re-running failures for details).",
    "  - Do NOT edit any files. Do NOT fix any tests. Only report results.",
    "  - Do NOT start or stop any dev servers — Playwright config handles that.",
    "",
    "## Required Output Format",
    "",
    "After running ALL tests, output exactly one FINAL_JSON block.",
    "",
    "Format:",
    '<FINAL_JSON>{',
    '  "status": "passed",',
    '  "summary": { "total": 4, "passed": 4, "failed": 0 },',
    '  "results": [',
    '    {',
    '      "testFile": "tests/epic-theming.spec.ts",',
    '      "testName": "dashboard has correct gradient background",',
    '      "status": "passed",',
    '      "steps": 5,',
    '      "error": null',
    '    },',
    '    {',
    '      "testFile": "tests/epic-theming.spec.ts",',
    '      "testName": "cashier splash shows correct theme",',
    '      "status": "failed",',
    '      "steps": 3,',
    '      "error": "Expected element .cashier-splash to have background #FF5500 but got transparent"',
    '    }',
    '  ]',
    '</FINAL_JSON>',
    "",
    "Rules for FINAL_JSON:",
    '  - "status" at the top level is "passed" only if ALL tests passed, otherwise "failed".',
    '  - "error" is null for passing tests.',
    '  - "error" must include the full error message from Playwright output for failing tests.',
    "  - Include every test. Do not omit passing tests from the results array.",
  ].join("\n");
}

export function playWriterFixPrompt(
  epic: EpicRecord,
  failures: { testFile: string; testName: string; error: string | null }[]
): string {
  const failureList = failures.map(f =>
    `- **${f.testName}** in ${f.testFile}\n  Error: ${f.error ?? "unknown"}`
  ).join("\n\n");

  return [
    "You are Play Writer — an autonomous coding agent in FIX mode.",
    "",
    "## Your Job",
    "The Playwright test suite has failures. Fix the app code to make ALL tests pass.",
    "Then commit your changes to the current branch.",
    "",
    `## Epic: ${epic.title}`,
    epic.goalText,
    "",
    "## Failing Tests",
    failureList,
    "",
    "## Instructions",
    "",
    "  1. Read each failing test file to understand what it expects.",
    "  2. Read the app source files that the test exercises.",
    "  3. Fix the app code so the test passes. Do NOT change test files unless the test itself is buggy.",
    '  4. After fixing, run "npx playwright test" to verify all tests pass.',
    "  5. If tests still fail, continue fixing until they all pass.",
    "  6. When all tests pass, commit your changes:",
    "     - Stage all changed files: git add -A",
    "     - Commit: git commit -m 'fix: resolve e2e test failures'",
    "",
    "## Rules",
    "  - Fix app code, not test code (unless the test has a clear bug like wrong selector).",
    "  - Do NOT skip or comment out failing tests.",
    "  - Do NOT add .skip or .fixme to tests.",
    "  - Commit ONLY after all tests pass.",
    "",
    "After committing, output FINAL_JSON:",
    '<FINAL_JSON>{"fixesApplied": ["path/to/file1.ts", "path/to/file2.ts"], "summary": "Brief description of what was fixed"}</FINAL_JSON>',
  ].join("\n");
}

export interface StallContext {
  stallReason?: string;
  stallIteration?: number;
  recentToolCalls?: { name: string; argsSummary: string; result: string }[];
  hotResetNumber?: number;
}

export function buildCoderResumePrompt(
  ticket: TicketRecord,
  currentDiff: string,
  reviewerBlockers: string[],
  explorerOutput?: ExplorerOutput | null,
  stallContext?: StallContext | null,
): string {
  const explorerSection = explorerOutput ? [
    "## Explorer Analysis (Prior)",
    JSON.stringify(explorerOutput, null, 2),
    ""
  ] : [];

  const stallSection = stallContext ? [
    "## Why The Previous Coder Stalled",
    `Reason: ${stallContext.stallReason || "Unknown — the model stopped making progress."}`,
    stallContext.stallIteration ? `It stalled at iteration ${stallContext.stallIteration}.` : "",
    stallContext.hotResetNumber ? `This is hot-reset #${stallContext.hotResetNumber}.` : "",
    "",
    stallContext.recentToolCalls && stallContext.recentToolCalls.length > 0 ? [
      "## Recent Tool Calls Before Stall",
      "The previous coder was doing this when it stalled:",
      ...stallContext.recentToolCalls.slice(-10).map((tc, i) =>
        `${i + 1}. ${tc.name}(${tc.argsSummary.slice(0, 120)}) → ${tc.result.slice(0, 120)}`
      ),
      "",
    ].join("\n") : "",
    "## Rules To Avoid Stalling Again",
    "- Do NOT repeat the same tool calls that failed above.",
    "- If a search_replace failed because the search text didn't match, read the file first to get the exact current content.",
    "- If a file path was wrong, use glob_files or grep_files to find the correct path.",
    "- If you cannot make progress, call finish with a summary of what was done and what remains.",
    "",
  ] : [];

  return [
    "## Resume Context",
    "You are continuing work on a ticket that was interrupted. File changes are already on disk.",
    "",
    ...stallSection,
    ...explorerSection,
    "## Ticket",
    `Title: ${ticket.title}`,
    `Goal: ${ticket.description}`,
    `Acceptance Criteria: ${(ticket.acceptanceCriteria ?? []).join("\n")}`,
    "",
    "## Current Progress (git diff)",
    "```diff",
    currentDiff.slice(0, 15000),
    "```",
    currentDiff.length > 15000 ? `\n(Diff truncated — ${currentDiff.length} chars total)` : "",
    "",
    "## Reviewer Feedback (if any)",
    reviewerBlockers.length ? reviewerBlockers.map((b, i) => `${i + 1}. ${b}`).join("\n") : "No reviewer feedback yet.",
    "",
    "## Instructions",
    "- The diff above shows changes already made. Do NOT redo work that's already done.",
    "- Continue from where you left off. Focus on completing any remaining acceptance criteria.",
    "- If the diff shows completed work matching all criteria, call finish immediately.",
    "- Write tests for any new code that doesn't have tests yet.",
    "- After you finish, output exactly one FINAL_JSON block and nothing after it.",
    '<FINAL_JSON>{"summary":"brief summary of remaining changes implemented"}</FINAL_JSON>'
  ].join("\n");
}
