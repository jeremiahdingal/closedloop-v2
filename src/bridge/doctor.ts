import type { FailureDecision } from "../types.ts";

export function deterministicDoctor(input: {
  repeatedBlockers: boolean;
  repeatedTestFailure: boolean;
  noDiff: boolean;
  infraFailure: boolean;
  isStall?: boolean;
}): FailureDecision {
  if (input.infraFailure || input.isStall) {
    return { decision: "retry_same_node", reason: input.infraFailure ? "Transient infrastructure failure." : "Agent stalled; restarting at current node." };
  }
  if (input.noDiff) {
    return { decision: "retry_builder", reason: "Builder produced no diff." };
  }
  if (input.repeatedBlockers || input.repeatedTestFailure) {
    return { decision: "escalate", reason: "The same blocker or test failure repeated." };
  }
  return { decision: "retry_builder", reason: "The ticket needs another build attempt." };
}
