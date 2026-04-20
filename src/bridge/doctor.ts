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
    return { decision: "escalate", reason: "No diff produced - escalating to avoid retry loop." };
  }
  if (input.repeatedBlockers || input.repeatedTestFailure) {
    return { decision: "escalate", reason: "The same blocker or test failure repeated." };
  }
  return { decision: "escalate", reason: "Unrecoverable failure - escalating to avoid retry loop." };
}
