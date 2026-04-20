import type {
  CoderOutput,
  CanonicalEditPacket,
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


export function epicDecoderPrompt(epic: EpicRecord): string {
  return [
    "You are the Goal Decomposer.",
    "⚠️ EXECUTOR CONSTRAINT: Every ticket you create will be handed to a 20–30B parameter model with limited reasoning and a short context window. Tickets MUST be trivially simple — one cohesive change, touching 1–3 files at most, with no ambiguity. If a task seems big, split it into multiple tickets. Prefer 8 small tickets over 3 large ones.",
    "Return JSON only with shape:",
    JSON.stringify({
      summary: "string",
      tickets: [
        {
          id: "string",
          title: "string",
          description: "string",
          acceptanceCriteria: ["string"],
          dependencies: ["string"],
          allowedPaths: ["string"],
          priority: "high|medium|low"
        }
      ]
    }, null, 2),
    "IMPORTANT: allowedPaths must be actual file/folder paths (e.g., ['src', 'test', 'docs', 'lib']), NOT ticket IDs or external URLs.",
    "Example: For a ticket about testing, use allowedPaths: ['test', '__tests__', 'spec']",
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

export function reviewerToolingPrompt(ticket: TicketRecord): string {
  return [
    "You are the Local Reviewer.",
    "Structural rules have already been checked by a deterministic guard.",
    "Review the current workspace diff using the available review tools.",
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
  explorerOutput: ExplorerOutput,
  editPacket: CanonicalEditPacket,
  reviewerContext?: { blockers: string[]; suggestions: string[] }
): string {
  return [
    "You are the Coder agent.",
    "Your job is to write the actual code changes to satisfy the ticket based on the Explorer's analysis and the provided file contents.",
    "MODEL TARGET: You are qwen3.5:27b. You do NOT have tool access. You must output a JSON edit plan.",
    `Ticket: ${ticket.title}`,
    `Goal: ${ticket.description}`,
    `Acceptance criteria: ${ticket.acceptanceCriteria.join("; ")}`,
    "## Acceptance Criteria Mapping",
    "CRITICAL: Every operation you produce MUST include an 'ac' field indicating which acceptance criterion it addresses.",
    "Format: 'ac': 'AC-1' or for multiple: 'ac': 'AC-1,AC-3'.",
    "Do NOT produce operations that don't map to at least one acceptance criterion. This prevents scope drift.",
    "",
    "## Explorer Analysis",
    JSON.stringify(explorerOutput, null, 2),
    "## Canonical Edit Packet (Current Source of Truth)",
    JSON.stringify(editPacket, null, 2),,
    ...(reviewerContext && (reviewerContext.blockers?.length || reviewerContext.suggestions?.length)
      ? [
        "",
        "## Previous Reviewer Feedback (address these issues)",
        ...(reviewerContext.blockers?.length
          ? ["Reviewer blockers (MUST resolve):", ...reviewerContext.blockers.map(b => "- " + b)]
          : []),
        ...(reviewerContext.suggestions?.length
          ? ["Reviewer suggestions:", ...reviewerContext.suggestions.map(s => "- " + s)]
          : []),
        "Your operations MUST address every blocker listed above.",
      ]
      : []),
    "## Rules for Operations",
    "1. Use 'search_replace' for existing files. You MUST provide the exact 'search' block and the 'replace' block.",
    "2. 'search_replace' MUST include 'expected_sha256' as provided in the Canonical Edit Packet for that file.",
    "3. Use 'create_file' for new files.",
    "4. Use 'append_file' only if adding to the end of a file.",
    "5. 'delete_file' or 'rename_file' are ONLY allowed if explicitly permitted in 'destructivePermissions' or 'allowedDeletePaths'/'allowedRenamePaths'.",
    "6. If you lack enough source code to complete the task, return an unresolvedBlocker: 'NEEDS_SOURCE'.",
    "7. If the task is impossible, return an unresolvedBlocker: 'BLOCKED'.",
    "8. Do NOT use 'replace_file' for existing files unless 'allowFullReplace' is true for that path.",
    "9. Every destructive operation (delete/rename) MUST include a 'reason' string.",
    "Return JSON only with shape:",
    JSON.stringify({
      summary: "brief summary of what you implemented",
      intendedFiles: ["string"],
      unresolvedBlockers: ["string"],
      operations: [
        { kind: "search_replace", path: "string", expected_sha256: "string", search: "string", replace: "string", ac: "AC-1" },
        { kind: "create_file", path: "string", content: "string", ac: "AC-2,AC-3" },
        { kind: "delete_file", path: "string", expected_sha256: "string", reason: "explicit reason", ac: "AC-1" }
      ]
    }, null, 2),
    "After you finish, output exactly one FINAL_JSON block and nothing after it."
  ].join("\n\n");
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
}): string {
  return [
    "You are the Agent Doctor.",
    "Return JSON only with shape:",
    JSON.stringify({ decision: "retry_builder", reason: "string" }, null, 2),
    "Decisions: retry_builder (start over), retry_same_node (retry current agent), escalate (give up)",
    `Ticket: ${input.ticket.title}`,
    `Current node: ${input.currentNode ?? "unknown"}`,
    `Repeated blockers: ${String(input.repeatedBlockers)}`,
    `Repeated test failure: ${String(input.repeatedTestFailure)}`,
    `No diff: ${String(input.noDiff)}`,
    `Infrastructure failure: ${String(input.infraFailure)}`,
    `Latest review: ${JSON.stringify(input.reviewerVerdict)}`,
    `Latest test summary: ${input.testSummary ?? "(none)"}`,
    "",
    "Re-run Awareness: This ticket may have been run before. If the coder or builder reported that all acceptance criteria are already satisfied by existing code (look for phrases like 'already exists', 'no changes needed', 'already satisfies' in the review), and the reviewer has no blockers, you should approve rather than escalate."
  ].join("\n\n");
}

export function epicDecoderToolingPrompt(
  epic: EpicRecord,
  ragContext?: BuiltContext | null,
  projectStructure?: string | null
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
    [
      "⚠️ EXECUTOR CONSTRAINT — read this before writing a single ticket:",
      "Each ticket you create will be executed by a 20–30B parameter model. That model has limited reasoning capacity and a short context window.",
      "This means every ticket MUST be:",
      "  • Atomic — one coherent, self-contained change only",
      "  • Narrow — touches 1–3 files at most; never spans the whole codebase",
      "  • Explicit — the description and acceptance criteria must be so clear that no further discovery is needed",
      "  • Small — the full change should fit comfortably in a single LLM response",
      "If a task feels large or multi-faceted, SPLIT IT. Prefer 10 simple tickets over 4 complex ones.",
      "Do NOT create tickets like 'Implement the feature end-to-end' or 'Refactor the module'. Break those into individual file-level changes.",
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
    "Steps:",
    "1. Explore the repo structure with glob/grep and read key files",
    "2. Understand existing code patterns and architecture",
    "3. Decompose the epic into atomic, file-scoped tickets (keep each one small!)",
    "4. Each ticket must have literal acceptance criteria and tight allowedPaths",
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
        priority: "high|medium|low"
      }]
    })}</FINAL_JSON>`
  );

  return sections.join("\n\n");
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
  reviewerBlockers: string[]
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
      "⚠️ EXECUTOR CONSTRAINT: Each sub-ticket will be run by a 20–30B model.",
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
  ragContext?: { codeContext: string; docContext: string } | null
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
    "4. Decompose the epic into well-scoped, independently executable tickets",
    "5. Each ticket must have clear acceptance criteria, file scope (allowedPaths), dependencies, and priority",
    "Think carefully. Be specific about what each ticket changes and why.",
    [
      "⚠️ EXECUTOR CONSTRAINT — critical for ticket design:",
      "Each ticket in the FINAL_JSON will be handed to an approximately 14B parameter model with limited reasoning and a short context window.",
      "Design every ticket so that model can succeed without needing to explore the broader codebase.",
      "Rules for each ticket:",
      "  • Atomic: one coherent change only — no 'and also' tickets",
      "  • Narrow: 1–3 files touched at most; use tight allowedPaths",
      "  • Self-contained: the description alone must be enough to implement it — no implicit knowledge required",
      "  • Small: the change should fit in a single model response",
      "When in doubt, split. 12 simple tickets are far better than 5 complex ones.",
      "Avoid vague titles like 'Update module X' — be precise: 'Add exportFoo() to src/foo.ts'.",
    ].join("\n"),
    "## Required Output Format",
    "Before outputting FINAL_JSON, you MUST write a structured analysis in plain text so the user can follow your reasoning. Use this exact format:\n\n## Codebase Analysis\n[Describe what you found: key files, existing patterns, relevant architecture, important types/interfaces]\n\n## What Exists vs What Needs Building\n[Enumerate what is already implemented and what is missing or incomplete]\n\n## Risks & Unknowns\n[List ambiguities, potential issues, or things that need clarification]\n\n## Ticket Overview\n[For each ticket: name, 1-sentence rationale, key files it touches]\n\nThen, after this analysis, output exactly one FINAL_JSON block:",
    `<FINAL_JSON>${JSON.stringify({
      summary: "brief summary of overall plan",
      tickets: [{
        id: "string",
        title: "string",
        description: "string",
        acceptanceCriteria: ["string"],
        dependencies: ["string"],
        allowedPaths: ["string"],
        priority: "high|medium|low"
      }]
    })}</FINAL_JSON>`
  );

  return sections.join("\n\n");
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
  devServerUrl: string,
  devServerCommand: string,
  loopAttempt: number,
  previousFailures?: string | null
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
