import type { PlannerProfile } from "../../config.ts";
import type { TicketReadinessScore } from "./types.ts";
import type { GoalTicketPlan } from "../../types.ts";

type ReadinessTicket = GoalTicketPlan & {
  nonGoals?: string[];
  riskLevel?: "low" | "medium" | "high";
  localModelNotes?: string[];
  fallbackNotes?: string[];
};

function containsVagueCriterion(criterion: string): boolean {
  return /\b(works correctly|tests pass|no regressions|implemented|context is better)\b/i.test(criterion);
}

export function scoreTicketReadiness(ticket: ReadinessTicket): TicketReadinessScore {
  const scopeNarrowness = /implement everything|make it work|refactor orchestration/i.test(ticket.title + ticket.description) ? 0 : 15;
  const allowedAreaSpecificity = !ticket.allowedPaths || ticket.allowedPaths.length === 0
    ? 0
    : ticket.allowedPaths.length === 1 && ticket.allowedPaths[0] === "*"
      ? 0
      : Math.max(5, 15 - Math.max(0, ticket.allowedPaths.length - 3) * 3);
  const validCriteria = ticket.acceptanceCriteria.filter((criterion) => !containsVagueCriterion(criterion));
  const acceptanceCriteriaQuality = ticket.acceptanceCriteria.length === 0 ? 0 : Math.min(20, validCriteria.length * 6 + 2);
  const testability = ticket.acceptanceCriteria.some((criterion) => /test|verify|build|lint|typecheck/i.test(criterion)) ? 15 : 0;
  const dependencyClarity = ticket.dependencies.every((dep) => typeof dep === "string" && dep.trim()) ? 10 : 0;
  const localModelSuitability = scopeNarrowness > 0 && allowedAreaSpecificity > 0 ? 10 : 0;
  const riskClarity = /risk|safe|fallback|error/i.test(ticket.description) || typeof ticket.riskLevel === "string" ? 5 : 2;
  const fallbackBehavior = /fallback|missing knowledge|stale/i.test(ticket.description + ticket.acceptanceCriteria.join(" "))
    || Boolean(ticket.fallbackNotes?.length)
    ? 5
    : 2;
  const nonGoalClarity = /do not|non-goal/i.test(ticket.description) || Boolean(ticket.nonGoals?.length) ? 5 : 0;
  const total = scopeNarrowness + allowedAreaSpecificity + acceptanceCriteriaQuality + testability + dependencyClarity + localModelSuitability + riskClarity + fallbackBehavior + nonGoalClarity;
  return {
    scopeNarrowness,
    allowedAreaSpecificity,
    acceptanceCriteriaQuality,
    testability,
    dependencyClarity,
    localModelSuitability,
    riskClarity,
    fallbackBehavior,
    nonGoalClarity,
    total,
  };
}

export function readinessThreshold(profile: PlannerProfile): number {
  if (profile === "remote-strong") return 80;
  if (profile === "medium-local") return 85;
  return 90;
}
