import type { PlannerProfile } from "../../config.ts";
import type { DecompositionJudgement, JudgedTicket } from "./types.ts";
import { readinessThreshold, scoreTicketReadiness } from "./readiness.ts";

function rejectionReasons(ticket: JudgedTicket): string[] {
  const reasons: string[] = [];
  const combined = `${ticket.title} ${ticket.description}`;
  if (/implement everything|make it work|refactor orchestration/i.test(combined)) reasons.push("Ticket scope is too broad.");
  if (!ticket.allowedPaths || ticket.allowedPaths.length === 0) reasons.push("Ticket is missing allowed paths.");
  if (ticket.allowedPaths?.length === 1 && ticket.allowedPaths[0] === "*") reasons.push("Allowed paths are too broad.");
  if (!ticket.acceptanceCriteria.length) reasons.push("Ticket is missing acceptance criteria.");
  if (ticket.acceptanceCriteria.some((criterion) => /\b(works correctly|tests pass|no regressions|implemented)\b/i.test(criterion))) {
    reasons.push("Acceptance criteria are too vague.");
  }
  if (!ticket.acceptanceCriteria.some((criterion) => /test|verify|build|lint|typecheck/i.test(criterion))) {
    reasons.push("Ticket lacks explicit verification guidance.");
  }
  if (!(ticket.nonGoals?.length)) reasons.push("Ticket lacks non-goals.");
  return reasons;
}

export function judgeDecomposition(tickets: JudgedTicket[], profile: PlannerProfile): DecompositionJudgement {
  const threshold = readinessThreshold(profile);
  const approvedTickets: JudgedTicket[] = [];
  const rejectedTickets: JudgedTicket[] = [];
  const rejectionMap: Record<string, string[]> = {};
  const repairSuggestions: Record<string, string[]> = {};
  const perTicketScores: DecompositionJudgement["perTicketScores"] = {};

  for (const ticket of tickets) {
    const reasons = rejectionReasons(ticket);
    const score = scoreTicketReadiness(ticket);
    perTicketScores[ticket.id] = score;
    if (score.total >= threshold && reasons.length === 0) {
      approvedTickets.push(ticket);
      continue;
    }
    rejectedTickets.push(ticket);
    rejectionMap[ticket.id] = [...reasons, ...(score.total < threshold ? [`Readiness score ${score.total} is below threshold ${threshold}.`] : [])];
    repairSuggestions[ticket.id] = [
      "Narrow the allowed paths and keep the ticket focused on one responsibility.",
      "Add concrete, testable acceptance criteria and at least one verification step.",
      "Add explicit non-goals if the ticket could sprawl.",
    ];
  }

  const overallConfidence = approvedTickets.length === 0
    ? 0
    : Math.round(approvedTickets.reduce((sum, ticket) => sum + perTicketScores[ticket.id].total, 0) / approvedTickets.length);
  const hasValidationTicket = approvedTickets.some((ticket) => ticket.acceptanceCriteria.some((criterion) => /test|verify|build|lint|typecheck/i.test(criterion)));
  const passed = rejectedTickets.length === 0 && overallConfidence >= threshold && hasValidationTicket;
  return {
    approvedTickets,
    rejectedTickets,
    rejectionReasons: rejectionMap,
    repairSuggestions,
    overallConfidence,
    perTicketScores,
    passed,
  };
}
