import type {
  EpicRecord,
  GoalTicketPlan,
  ReviewerVerdict,
  TicketContextPacket,
  TicketRecord
} from "../types.ts";

export function epicDecoderPrompt(epic: EpicRecord): string {
  return [
    "You are the Goal Decomposer.",
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
    `Acceptance criteria: ${ticket.acceptanceCriteria.join("; ")}`,
    `Allowed paths: ${ticket.allowedPaths.join(", ") || "(none)"}`,
    `Review blockers: ${packet.reviewBlockers.join("; ") || "(none)"}`,
    `Prior test failures: ${packet.priorTestFailures.join("; ") || "(none)"}`,
    `Read PROJECT_STRUCTURE.md first.`,
    "Generate only minimal targeted changes."
  );

  return sections.join("\n\n");
}

export function builderToolingPrompt(ticket: TicketRecord, packet: TicketContextPacket): string {
  const sections = [
    "Work inside the current repository using the tools that are actually available in this session.",
    "Use read, glob, grep, edit, write, task, todowrite, and skill as sparingly.",
    `Read PROJECT_STRUCTURE.md first.`,
    "Do not ask the user for clarification or request unavailable tools. Just inspect the workspace and make the change.",
  ];

  // Inject RAG context if available
  if (packet.retrievedContext) {
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
    `Acceptance criteria: ${ticket.acceptanceCriteria.join("; ")}`,
    `Allowed paths: ${ticket.allowedPaths.join(", ") || "(none)"}`,
    `Review blockers: ${packet.reviewBlockers.join("; ") || "(none)"}`,
    `Prior test failures: ${packet.priorTestFailures.join("; ") || "(none)"}`,
    "Make the smallest safe set of changes needed.",
    "After you finish, output exactly one FINAL_JSON block and nothing after it.",
    '<FINAL_JSON>{"summary":"brief summary of changes"}</FINAL_JSON>'
  );

  return sections.join("\n\n");
}

export function reviewerPrompt(ticket: TicketRecord, diff: string): string {
  return [
    "You are the Local Reviewer.",
    "IMPORTANT: The diff below shows changes in an isolated ticket workspace (a copy of the repo), NOT the original repo.",
    "Files being created/modified ARE in the correct location if they appear in the diff.",
    "Do NOT reject changes because files 'don't exist in project root' - they are being created in this workspace.",
    "CRITICAL: If the diff shows a file being created with the correct name and path, APPROVE it.",
    "Do NOT invent blockers about files 'not being in the diff' when the diff clearly shows file creation.",
    "BLOCKERS vs SUGGESTIONS:",
    "- Blockers are ONLY: syntax errors, wrong file names (e.g. wrong.js instead of right.js), wrong file paths, security issues, or changes that actively break the codebase.",
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
    "Diff:",
    diff || "(empty)"
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

export function epicReviewerToolingPrompt(epic: EpicRecord, tickets: TicketRecord[]): string {
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

  return [
    "Review the overall epic result using the repository, ticket information, and any available artifacts.",
    "CRITICAL: All tickets in this epic have been reviewed and approved. Proceed confidently to check integration.",
    "Your role is to check for destructive changes and cross-ticket integration issues.",
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
  ].join("\n\n");
}

export function doctorPrompt(input: {
  ticket: TicketRecord;
  reviewerVerdict: ReviewerVerdict | null;
  testSummary: string | null;
  repeatedBlockers: boolean;
  repeatedTestFailure: boolean;
  noDiff: boolean;
  infraFailure: boolean;
}): string {
  return [
    "You are the Agent Doctor.",
    "Return JSON only with shape:",
    JSON.stringify({ decision: "retry_builder", reason: "string" }, null, 2),
    `Ticket: ${input.ticket.title}`,
    `Repeated blockers: ${String(input.repeatedBlockers)}`,
    `Repeated test failure: ${String(input.repeatedTestFailure)}`,
    `No diff: ${String(input.noDiff)}`,
    `Infrastructure failure: ${String(input.infraFailure)}`,
    `Latest review: ${JSON.stringify(input.reviewerVerdict)}`,
    `Latest test summary: ${input.testSummary ?? "(none)"}`
  ].join("\n\n");
}

export function epicDecoderToolingPrompt(epic: EpicRecord): string {
  return [
    "You are the Epic Decoder agent. Explore the repository using the OpenCode tools that are actually available in-session.",
    "Use read, glob, grep, edit, write, task, todowrite, and skill.",
    "Do not try to call bash, ls, find, run, or any other unavailable shell tool.",
    "Understand the codebase structure, existing patterns, and conventions before decomposing the epic.",
    `Epic: ${epic.title}`,
    `Goal: ${epic.goalText}`,
    "Steps:",
    "1. Explore the repo structure with glob/grep and read key files",
    "2. Understand existing code patterns and architecture",
    "3. Decompose the epic into well-scoped tickets",
    "4. Each ticket should have clear acceptance criteria and allowed paths",
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
  ].join("\n\n");
}

export function epicReviewerCodexPrompt(epic: EpicRecord, tickets: TicketRecord[]): string {
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

  return [
    "You are the Epic Reviewer agent. Review the overall epic result quickly and efficiently.",
    "CRITICAL: All tickets in this epic have been reviewed and approved. Proceed confidently.",
    "Your role is to check for cross-ticket integration issues and fix any destructive or risky changes.",
    "IMPORTANT: Be concise. Check git log and diffs for the ticket changes, verify they look safe, then output FINAL_JSON. Do NOT explore the entire repo.",
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
  ].join("\n\n");
}
