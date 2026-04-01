import type { FailureDecision } from "../types.ts";

export function deterministicDoctor(input: {
  repeatedBlockers: boolean;
  repeatedTestFailure: boolean;
  noDiff: boolean;
  infraFailure: boolean;
}): FailureDecision {
  if (input.infraFailure) {
    return { decision: "retry_same_node", reason: "Transient infrastructure failure." };
  }
  if (input.noDiff) {
    return { decision: "retry_builder", reason: "Builder produced no diff." };
  }
  if (input.repeatedBlockers || input.repeatedTestFailure) {
    return { decision: "escalate", reason: "The same blocker or test failure repeated." };
  }
  return { decision: "retry_builder", reason: "The ticket needs another build attempt." };
}
