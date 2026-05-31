import type { GoalTicketPlan } from "../../types.ts";
import type { JudgedTicket, SelectedKnowledgeSlice } from "./types.ts";

function normalizePathValue(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function extractPathHints(ticket: GoalTicketPlan): string[] {
  const text = [ticket.title, ticket.description, ...(ticket.acceptanceCriteria ?? []), ...(ticket.testSpecs ?? [])].join("\n");
  const matches = text.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)?/g) ?? [];
  return matches.map(normalizePathValue);
}

function inferAllowedPaths(ticket: GoalTicketPlan, fallbackMode: SelectedKnowledgeSlice["fallbackMode"]): string[] {
  const explicit = dedupe((ticket.allowedPaths ?? []).map(normalizePathValue));
  const explicitBroad = explicit.length === 0 || explicit.some((value) => value === "*" || value === ".");
  const inferred = dedupe(extractPathHints(ticket));
  if (!explicitBroad && explicit.length > 0) {
    return explicit;
  }
  if (inferred.length > 0) {
    return inferred.slice(0, 3);
  }
  return fallbackMode === "missing_knowledge"
    ? ["src", "tests", "README.md"]
    : ["*"];
}

function strengthenCriterion(criterion: string, ticket: GoalTicketPlan, allowedPaths: string[]): string {
  const trimmed = criterion.trim();
  if (!trimmed) return trimmed;
  if (/\b(works correctly|tests pass|no regressions|implemented)\b/i.test(trimmed)) {
    const primaryPath = allowedPaths[0] ?? "the scoped files";
    return `Verify ${primaryPath} exhibits the explicitly described behavior for this ticket.`;
  }
  return trimmed;
}

function ensureVerificationCriterion(ticket: GoalTicketPlan): string[] {
  const existing = [...ticket.acceptanceCriteria];
  if (existing.some((criterion) => /test|verify|typecheck|lint|build/i.test(criterion))) {
    return existing;
  }
  const testSpec = ticket.testSpecs?.map((spec) => spec.trim()).find(Boolean);
  if (testSpec) {
    return [...existing, `Add or update a focused test that proves this ticket works: ${testSpec}`];
  }
  return [...existing, "Add or update a focused verification step that proves this ticket works."];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function buildDescription(ticket: GoalTicketPlan, allowedPaths: string[]): string {
  const description = ticket.description.trim();
  if (/\bWHAT:\b/i.test(description) && /\bWHERE:\b/i.test(description) && /\bHOW:\b/i.test(description) && /\bWHY:\b/i.test(description)) {
    return description;
  }
  const scope = allowedPaths.length > 0 ? allowedPaths.join(", ") : "the scoped files";
  const intro = description || `Implement ${ticket.title}.`;
  const firstCriterion = ticket.acceptanceCriteria.map((value) => value.trim()).find(Boolean) ?? "Satisfy the scoped acceptance criteria.";
  return [
    intro,
    `WHAT: Make the smallest change needed to complete "${ticket.title}".`,
    `WHERE: Limit work to ${scope}.`,
    "HOW: Follow existing project patterns, keep edits narrow, and avoid unrelated refactors.",
    `WHY: ${firstCriterion}`,
  ].join("\n");
}

export function hardenTickets(
  tickets: GoalTicketPlan[],
  selectedKnowledge: SelectedKnowledgeSlice,
): JudgedTicket[] {
  const fallbackMode = selectedKnowledge.fallbackMode;
  return tickets.map((ticket) => {
    const allowedPaths = inferAllowedPaths(ticket, fallbackMode);
    const strengthenedCriteria = dedupe((ticket.acceptanceCriteria ?? [])
      .map((criterion) => strengthenCriterion(criterion, ticket, allowedPaths)));
    const nonGoals = /do not|non-goal/i.test(ticket.description)
      ? []
      : ["Do not expand this ticket into unrelated subsystems or a repo-wide refactor."];
    const localModelNotes = [
      "Keep the implementation narrow and self-contained.",
      "Do not rely on hidden repo context outside the selected knowledge slice.",
      allowedPaths[0] === "*"
        ? "Narrow file scope before execution if more precise paths become available."
        : `Stay within these paths: ${allowedPaths.join(", ")}.`,
    ];
    const fallbackNotes = fallbackMode === "none"
      ? []
      : ["Cached repo knowledge was limited; prefer conservative scope and explicit verification."];
    return {
      ...ticket,
      title: ticket.title.trim() || `Implement ${ticket.id}`,
      description: buildDescription(ticket, allowedPaths),
      acceptanceCriteria: ensureVerificationCriterion({ ...ticket, acceptanceCriteria: strengthenedCriteria }),
      allowedPaths,
      nonGoals,
      riskLevel: allowedPaths.includes("*") ? "medium" : "low",
      localModelNotes,
      fallbackNotes,
    };
  });
}
