import type { FailureDecision } from "../types.ts";

export function deterministicDoctor(input: {
  repeatedBlockers: boolean;
  repeatedTestFailure: boolean;
  noDiff: boolean;
  infraFailure: boolean;
  isStall?: boolean;
  reviewApproved?: boolean;
}): FailureDecision {
  if (input.infraFailure || input.isStall) {
    return { decision: "retry_builder", reason: input.infraFailure ? "Transient infrastructure failure." : "Agent stalled; restarting from coder." };
  }
  // Never auto-approve without reviewer approval — noDiff just means the coder produced nothing,
  // which could mean it failed, not that the work is already done.
  if (input.noDiff) {
    if (input.repeatedBlockers || input.repeatedTestFailure) {
      return { decision: "escalate", reason: "No diff produced with repeated blockers — escalating to avoid retry loop." };
    }
    return { decision: "retry_builder", reason: "No diff produced — retrying coder." };
  }
  if (input.repeatedBlockers || input.repeatedTestFailure) {
    return { decision: "escalate", reason: "The same blocker or test failure repeated." };
  }
  return { decision: "retry_builder", reason: "Retrying coder." };
}
