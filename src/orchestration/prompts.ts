import type {
  EpicRecord,
  GoalTicketPlan,
  ReviewerVerdict,
  TicketContextPacket,
  TicketRecord
} from "../types.ts";

export function goalDecomposerPrompt(epic: EpicRecord): string {
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
    `Epic: ${epic.title}`,
    `Goal: ${epic.goalText}`
  ].join("\n\n");
}

export function builderPrompt(ticket: TicketRecord, packet: TicketContextPacket): string {
  return [
    "You are the Local Builder.",
    "Return JSON only with shape:",
    JSON.stringify({
      summary: "string",
      intendedFiles: ["string"],
      operations: [{ kind: "replace_file", path: "string", content: "string" }]
    }, null, 2),
    `Ticket: ${ticket.title}`,
    `Description: ${ticket.description}`,
    `Acceptance criteria: ${ticket.acceptanceCriteria.join("; ")}`,
    `Allowed paths: ${ticket.allowedPaths.join(", ") || "(none)"}`,
    `Review blockers: ${packet.reviewBlockers.join("; ") || "(none)"}`,
    `Prior test failures: ${packet.priorTestFailures.join("; ") || "(none)"}`,
    "Generate only minimal targeted changes."
  ].join("\n\n");
}

export function builderToolingPrompt(ticket: TicketRecord, packet: TicketContextPacket): string {
  return [
    "Work inside the current repository using your available tools.",
    `Ticket: ${ticket.title}`,
    `Description: ${ticket.description}`,
    `Acceptance criteria: ${ticket.acceptanceCriteria.join("; ")}`,
    `Allowed paths: ${ticket.allowedPaths.join(", ") || "(none)"}`,
    `Review blockers: ${packet.reviewBlockers.join("; ") || "(none)"}`,
    `Prior test failures: ${packet.priorTestFailures.join("; ") || "(none)"}`,
    "Make the smallest safe set of changes needed.",
    "After you finish, output exactly one FINAL_JSON block and nothing after it.",
    '<FINAL_JSON>{"summary":"brief summary of changes"}</FINAL_JSON>'
  ].join("\n\n");
}

export function reviewerPrompt(ticket: TicketRecord, diff: string): string {
  return [
    "You are the Local Reviewer.",
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

export function goalReviewerPrompt(epic: EpicRecord, tickets: GoalTicketPlan[], summaries: string[]): string {
  return [
    "You are the Goal Reviewer.",
    "Return JSON only with shape:",
    JSON.stringify({
      verdict: "approved",
      summary: "string",
      followupTickets: []
    }, null, 2),
    `Epic: ${epic.title}`,
    `Goal: ${epic.goalText}`,
    `Tickets: ${tickets.map((ticket) => `${ticket.id}:${ticket.title}`).join(", ")}`,
    `Ticket summaries: ${summaries.join(" | ")}`
  ].join("\n\n");
}

export function goalReviewerToolingPrompt(epic: EpicRecord, tickets: GoalTicketPlan[], summaries: string[]): string {
  return [
    "Review the overall epic result using the repository, ticket summaries, and any available artifacts.",
    `Epic: ${epic.title}`,
    `Goal: ${epic.goalText}`,
    `Tickets: ${tickets.map((ticket) => `${ticket.id}:${ticket.title}`).join(", ")}`,
    `Ticket summaries: ${summaries.join(" | ")}`,
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
