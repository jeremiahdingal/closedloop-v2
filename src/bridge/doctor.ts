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
    // If there are no repeated blockers or test failures, the code likely already satisfies the criteria.
    // Approve to avoid escalation loops on re-runs of already-completed tickets.
    if (!input.repeatedBlockers && !input.repeatedTestFailure) {
      return { decision: "approve", reason: "No diff produced but no blockers or test failures — code likely already satisfies acceptance criteria." };
    }
    return { decision: "escalate", reason: "No diff produced with repeated blockers — escalating to avoid retry loop." };
  }
  if (input.repeatedBlockers || input.repeatedTestFailure) {
    return { decision: "escalate", reason: "The same blocker or test failure repeated." };
  }
  return { decision: "escalate", reason: "Unrecoverable failure - escalating to avoid retry loop." };
}
