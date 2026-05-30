import type { GoalTicketPlan } from "../../types.ts";
import type { JudgedTicket, SelectedKnowledgeSlice } from "./types.ts";

function ensureVerificationCriterion(ticket: GoalTicketPlan): string[] {
  const existing = [...ticket.acceptanceCriteria];
  if (existing.some((criterion) => /test|verify|typecheck|lint|build/i.test(criterion))) {
    return existing;
  }
  return [...existing, "Add or update a focused verification step that proves this ticket works."];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function hardenTickets(
  tickets: GoalTicketPlan[],
  selectedKnowledge: SelectedKnowledgeSlice,
): JudgedTicket[] {
  const fallbackMode = selectedKnowledge.fallbackMode;
  return tickets.map((ticket) => {
    const allowedPaths = ticket.allowedPaths && ticket.allowedPaths.length > 0
      ? dedupe(ticket.allowedPaths)
      : fallbackMode === "missing_knowledge"
        ? ["src", "tests", "README.md"]
        : ["*"];
    const nonGoals = /do not|non-goal/i.test(ticket.description)
      ? []
      : ["Do not expand this ticket into unrelated subsystems or a repo-wide refactor."];
    const localModelNotes = [
      "Keep the implementation narrow and self-contained.",
      "Do not rely on hidden repo context outside the selected knowledge slice.",
    ];
    const fallbackNotes = fallbackMode === "none"
      ? []
      : ["Cached repo knowledge was limited; prefer conservative scope and explicit verification."];
    return {
      ...ticket,
      title: ticket.title.trim() || `Implement ${ticket.id}`,
      description: ticket.description.trim() || `Implement ${ticket.title}.`,
      acceptanceCriteria: ensureVerificationCriterion(ticket),
      allowedPaths,
      nonGoals,
      riskLevel: allowedPaths.includes("*") ? "medium" : "low",
      localModelNotes,
      fallbackNotes,
    };
  });
}
