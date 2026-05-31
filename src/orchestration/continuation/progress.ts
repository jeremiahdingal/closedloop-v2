import type {
  AgentContinuationState,
  ContinuationStallKind,
  ContinuationRecoveryAction,
} from "./agent-state.ts";
import type {
  BuilderLedger,
  ExplorerLedger,
  ReviewerLedger,
  TesterLedger,
  EpicDecoderLedger,
} from "./role-ledgers.ts";
import { isTargetExhausted } from "./negative-evidence.ts";

// ─── Stall detection result ──────────────────────────────────────────────────

export type StallDetectionResult = {
  stalled: boolean;
  kind?: ContinuationStallKind;
  streak?: number;
  action?: ContinuationRecoveryAction;
};

// ─── Generic no-progress detection ───────────────────────────────────────────

export function detectBusyStall(state: AgentContinuationState): StallDetectionResult {
  const { role, progress, loopletIndex } = state;

  // Check for visited-file loops first
  const fileLoop = detectFileLoop(state);
  if (fileLoop.stalled) return fileLoop;

  // Role-specific detection
  switch (role) {
    case "builder":
      return detectBuilderStall(state as AgentContinuationState<BuilderLedger>);
    case "explorer":
      return detectExplorerStall(state as AgentContinuationState<ExplorerLedger>);
    case "reviewer":
      return detectReviewerStall(state as AgentContinuationState<ReviewerLedger>);
    case "tester":
      return detectTesterStall(state as AgentContinuationState<TesterLedger>);
    case "epicDecoder":
      return detectDecoderStall(state as AgentContinuationState<EpicDecoderLedger>);
    default:
      return genericNoProgressCheck(state);
  }
}

// ─── File loop detection ─────────────────────────────────────────────────────

function detectFileLoop(state: AgentContinuationState): StallDetectionResult {
  const entries = Object.values(state.visitedFiles);
  for (const entry of entries) {
    if (entry.readCount >= 3) {
      return {
        stalled: true,
        kind: "same_file_loop",
        streak: entry.readCount,
        action: { kind: "cold_resume" },
      };
    }
  }
  return { stalled: false };
}

// ─── Builder stall detection ─────────────────────────────────────────────────

function detectBuilderStall(state: AgentContinuationState<BuilderLedger>): StallDetectionResult {
  const ledger = state.ledger;

  // Same error fingerprint repeated
  const errorFingerprints = ledger.commandHistory
    .filter((c) => c.result === "fail" && c.errorFingerprint)
    .map((c) => c.errorFingerprint!);
  if (errorFingerprints.length >= 2) {
    const last = errorFingerprints[errorFingerprints.length - 1];
    const prev = errorFingerprints[errorFingerprints.length - 2];
    if (last === prev) {
      return {
        stalled: true,
        kind: "same_error_loop",
        streak: 2,
        action: { kind: "cold_resume" },
      };
    }
  }

  // Diffs that don't touch allowedPaths
  const offPathDiffs = ledger.diffs.filter(
    (d) => !d.changedFiles.some((f) =>
      state.allowedPaths.some((ap) => f === ap || f.startsWith(ap + "/"))
    )
  );
  if (offPathDiffs.length >= 2) {
    return {
      stalled: true,
      kind: "same_error_loop",
      streak: offPathDiffs.length,
      action: { kind: "cold_resume" },
    };
  }

  // Repeated reviewer blocker
  if (ledger.blockersFromReviewer.length > 0) {
    const lastBlocker = ledger.blockersFromReviewer[ledger.blockersFromReviewer.length - 1];
    const occurrences = ledger.blockersFromReviewer.filter((b) => b === lastBlocker).length;
    if (occurrences >= 2) {
      return {
        stalled: true,
        kind: "same_blocker_loop",
        streak: occurrences,
        action: { kind: "cold_resume" },
      };
    }
  }

  // No diff after a looplet (tool success but state static)
  if (state.progress.noProgressStreak >= 3 && ledger.diffs.length === 0) {
    return {
      stalled: true,
      kind: "tool_success_but_state_static",
      streak: state.progress.noProgressStreak,
      action: { kind: "cold_resume" },
    };
  }

  return genericNoProgressCheck(state);
}

// ─── Explorer stall detection ────────────────────────────────────────────────

function detectExplorerStall(state: AgentContinuationState<ExplorerLedger>): StallDetectionResult {
  const ledger = state.ledger;

  // All questions answered but no packet
  const openQuestions = ledger.investigationQuestions.filter((q) => q.status !== "answered");
  if (openQuestions.length === 0 && ledger.investigationQuestions.length > 0 && !ledger.explorerPacket) {
    return {
      stalled: true,
      kind: "output_schema_avoidance",
      streak: 1,
      action: { kind: "phase_shift", phase: "packet" },
    };
  }

  // Too many files read without answering questions
  const totalReads = Object.values(state.visitedFiles).reduce((s, v) => s + v.readCount, 0);
  const answeredCount = ledger.investigationQuestions.filter((q) => q.status === "answered").length;
  if (totalReads > 15 && answeredCount === 0) {
    return {
      stalled: true,
      kind: "busy_no_progress",
      streak: Math.floor(totalReads / 5),
      action: { kind: "cold_resume" },
    };
  }

  return genericNoProgressCheck(state);
}

// ─── Reviewer stall detection ────────────────────────────────────────────────

function detectReviewerStall(state: AgentContinuationState<ReviewerLedger>): StallDetectionResult {
  const ledger = state.ledger;

  // Repeated blocker
  const repeatedBlockers = ledger.blockers.filter((b) => b.repeated);
  if (repeatedBlockers.length >= 2) {
    return {
      stalled: true,
      kind: "same_blocker_loop",
      streak: repeatedBlockers.length,
      action: { kind: "cold_resume" },
    };
  }

  // Too many diff facts without verdict
  if (ledger.diffFacts.length > 10 && !ledger.finalVerdict) {
    return {
      stalled: true,
      kind: "output_schema_avoidance",
      streak: 1,
      action: { kind: "phase_shift", phase: "verdict" },
    };
  }

  return genericNoProgressCheck(state);
}

// ─── Tester stall detection ──────────────────────────────────────────────────

function detectTesterStall(state: AgentContinuationState<TesterLedger>): StallDetectionResult {
  const ledger = state.ledger;

  // Same command fails twice with same fingerprint
  const failCommands = ledger.commands.filter((c) => c.status === "fail" && c.errorFingerprint);
  if (failCommands.length >= 2) {
    const last = failCommands[failCommands.length - 1];
    const prev = failCommands[failCommands.length - 2];
    if (last.errorFingerprint === prev.errorFingerprint) {
      return {
        stalled: true,
        kind: "same_error_loop",
        streak: 2,
        action: { kind: "cold_resume" },
      };
    }
  }

  // Test found but not run
  if (ledger.relevantTestFiles.length > 0 && ledger.commands.length === 0 && state.progress.noProgressStreak >= 2) {
    return {
      stalled: true,
      kind: "tool_success_but_state_static",
      streak: state.progress.noProgressStreak,
      action: { kind: "cold_resume" },
    };
  }

  return genericNoProgressCheck(state);
}

// ─── Decoder stall detection ─────────────────────────────────────────────────

function detectDecoderStall(state: AgentContinuationState<EpicDecoderLedger>): StallDetectionResult {
  const ledger = state.ledger;

  // Check for search exhaustion - if all targets are exhausted, force finish
  const discovery = ledger.discoveryLedger;
  if (discovery.negativeEvidence.length > 0) {
    const allExhausted = discovery.negativeEvidence.every((ne) => ne.exhausted);
    const hasExhaustedTarget = discovery.negativeEvidence.some((ne) => ne.exhausted);

    if (hasExhaustedTarget) {
      return {
        stalled: true,
        kind: "busy_no_progress",
        streak: discovery.negativeEvidence.reduce((sum, ne) => sum + ne.searchCount, 0),
        action: { kind: "cold_resume" },
      };
    }
  }

  // All skeletons filled but no final candidate
  const filledTickets = ledger.ticketSkeletons.filter((t) => t.status === "filled");
  const skeletons = ledger.ticketSkeletons;
  if (skeletons.length > 0 && filledTickets.length === skeletons.length && !ledger.finalCandidate) {
    return {
      stalled: true,
      kind: "output_schema_avoidance",
      streak: 1,
      action: { kind: "phase_shift", phase: "final_json" },
    };
  }

  return genericNoProgressCheck(state);
}

// ─── Generic fallback ────────────────────────────────────────────────────────

function genericNoProgressCheck(state: AgentContinuationState): StallDetectionResult {
  if (state.progress.noProgressStreak >= 4) {
    return {
      stalled: true,
      kind: "busy_no_progress",
      streak: state.progress.noProgressStreak,
      action: { kind: "cold_resume" },
    };
  }
  return { stalled: false };
}
