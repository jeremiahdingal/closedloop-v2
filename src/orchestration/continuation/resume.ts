import type { AgentContinuationState, LocalAgentRole } from "./agent-state.ts";
import type {
  BuilderLedger,
  ExplorerLedger,
  ReviewerLedger,
  TesterLedger,
  EpicDecoderLedger,
  TicketHardenerLedger,
  DecompositionJudgeLedger,
  TicketRepairLedger,
  DoctorLedger,
  EpicReviewerLedger,
  KnowledgebaseLedger,
} from "./role-ledgers.ts";

// ─── Cold resume prompt builder ──────────────────────────────────────────────
// Generates a compact resume instruction from the continuation state,
// NOT from raw chat history. The model picks up from role-specific state.

export function buildColdResumePrompt(state: AgentContinuationState): string {
  const { role, phase, loopletIndex, progress, visitedFiles } = state;
  const visitedCount = Object.keys(visitedFiles).length;
  const recentEvents = progress.events.slice(-10).map((e) => `${e.kind}@${e.loopletIndex}`).join(", ");

  const header = [
    `[COLD-RESUME] You are resuming ${role} work at phase "${phase}" (looplet ${loopletIndex}, ${state.totalModelCalls} model calls so far).`,
    `Visited ${visitedCount} file(s). Recent progress: ${recentEvents || "none"}.`,
    `No-progress streak: ${progress.noProgressStreak}.`,
    ``,
  ].join("\n");

  const roleInstruction = buildRoleResumeInstruction(state);
  const footer = [
    ``,
    `IMPORTANT: Do NOT restart from the beginning. Continue from the current state.`,
    `Do NOT re-read files already visited unless their content may have changed.`,
    `Make the smallest possible progress, then update your output.`,
  ].join("\n");

  return header + roleInstruction + footer;
}

function buildRoleResumeInstruction(state: AgentContinuationState): string {
  switch (state.role) {
    case "explorer":
      return buildExplorerResume(state as AgentContinuationState<ExplorerLedger>);
    case "epicDecoder":
      return buildDecoderResume(state as AgentContinuationState<EpicDecoderLedger>);
    case "ticketHardener":
      return buildHardenerResume(state as AgentContinuationState<TicketHardenerLedger>);
    case "decompositionJudge":
      return buildJudgeResume(state as AgentContinuationState<DecompositionJudgeLedger>);
    case "ticketRepair":
      return buildRepairResume(state as AgentContinuationState<TicketRepairLedger>);
    case "builder":
      return buildBuilderResume(state as AgentContinuationState<BuilderLedger>);
    case "reviewer":
      return buildReviewerResume(state as AgentContinuationState<ReviewerLedger>);
    case "tester":
      return buildTesterResume(state as AgentContinuationState<TesterLedger>);
    case "doctor":
      return buildDoctorResume(state as AgentContinuationState<DoctorLedger>);
    case "epicReviewer":
      return buildEpicReviewerResume(state as AgentContinuationState<EpicReviewerLedger>);
    case "knowledgebaseBuilder":
      return buildKnowledgebaseResume(state as AgentContinuationState<KnowledgebaseLedger>);
  }
}

function buildExplorerResume(state: AgentContinuationState<ExplorerLedger>): string {
  const ledger = state.ledger;
  const openQs = ledger.investigationQuestions.filter((q) => q.status !== "answered");
  return [
    `EXPLORER RESUME:`,
    `Questions: ${ledger.investigationQuestions.length} total, ${openQs.length} open.`,
    openQs.length > 0 ? `Next question: ${openQs[0].question}` : `All questions answered — produce Explorer Packet now.`,
    `Relevant files found: ${ledger.map.relevantFiles.length}.`,
    `Do not restart repo mapping. Answer the next open question or finalize the packet.`,
  ].join("\n");
}

function buildDecoderResume(state: AgentContinuationState<EpicDecoderLedger>): string {
  const ledger = state.ledger;
  const incompleteTickets = ledger.ticketSkeletons.filter((t) => t.status !== "filled");
  return [
    `DECODER RESUME:`,
    `Ticket skeletons: ${ledger.ticketSkeletons.length} total, ${incompleteTickets.length} incomplete.`,
    incompleteTickets.length > 0
      ? `Next incomplete: ${incompleteTickets[0].responsibility}`
      : `All skeletons filled — produce final GoalDecomposition JSON.`,
    `Evidence slots: ${Object.keys(ledger.evidenceSlots).length}.`,
    `Do not reread files already recorded. Fill the next incomplete ticket from existing evidence.`,
  ].join("\n");
}

function buildHardenerResume(state: AgentContinuationState<TicketHardenerLedger>): string {
  const ledger = state.ledger;
  const unchecked = ledger.inputTickets.filter((t) => !ledger.hardeningChecklist[t.id]);
  return [
    `HARDENER RESUME:`,
    `Tickets: ${ledger.inputTickets.length} input, ${ledger.repairedTickets.length} repaired.`,
    `Unchecked: ${unchecked.length}.`,
    `Do not explore the repo. Format and validate tickets only.`,
  ].join("\n");
}

function buildJudgeResume(state: AgentContinuationState<DecompositionJudgeLedger>): string {
  const ledger = state.ledger;
  return [
    `JUDGE RESUME:`,
    `Verdict: ${ledger.verdict}. Repair requests: ${ledger.repairRequests.length}.`,
    `Atomicity issues: ${ledger.checks.atomicity.length}.`,
    `Complete the verdict or refine repair requests.`,
  ].join("\n");
}

function buildRepairResume(state: AgentContinuationState<TicketRepairLedger>): string {
  const ledger = state.ledger;
  return [
    `REPAIR RESUME:`,
    `Repair requests: ${ledger.repairRequests.length}, applied: ${ledger.appliedRepairs.length}.`,
    `Unresolved: ${ledger.unresolvedRepairs.length}.`,
    `Do not restart decomposition. Apply the next repair request.`,
  ].join("\n");
}

function buildBuilderResume(state: AgentContinuationState<BuilderLedger>): string {
  const ledger = state.ledger;
  const blockedCriteria = ledger.acceptanceCriteria.filter((ac) => ac.status === "blocked");
  const notStarted = ledger.acceptanceCriteria.filter((ac) => ac.status === "not_started");
  const lastBlocker = ledger.blockersFromReviewer.length > 0
    ? ledger.blockersFromReviewer[ledger.blockersFromReviewer.length - 1]
    : "none";

  return [
    `BUILDER RESUME:`,
    `Acceptance criteria: ${notStarted.length} not started, ${blockedCriteria.length} blocked.`,
    notStarted.length > 0 ? `Next criterion: ${notStarted[0].text}` : "",
    `Last reviewer blocker: ${lastBlocker}`,
    `Diffs produced: ${ledger.diffs.length}. Commands run: ${ledger.commandHistory.length}.`,
    `Make the smallest patch that addresses the next criterion or blocker.`,
  ].join("\n");
}

function buildReviewerResume(state: AgentContinuationState<ReviewerLedger>): string {
  const ledger = state.ledger;
  return [
    `REVIEWER RESUME:`,
    `Diff facts: ${ledger.diffFacts.length}. Blockers: ${ledger.blockers.length}.`,
    `Verdict: ${ledger.finalVerdict ? "produced" : "pending"}.`,
    `Use existing diff facts and checklist. Do not reread unchanged files.`,
    `Return a stable verdict with evidence-backed blockers only.`,
  ].join("\n");
}

function buildTesterResume(state: AgentContinuationState<TesterLedger>): string {
  const ledger = state.ledger;
  const lastFailure = ledger.failures.length > 0 ? ledger.failures[ledger.failures.length - 1] : null;
  return [
    `TESTER RESUME:`,
    `Test need: ${ledger.testNeedAssessment ? (ledger.testNeedAssessment.requiresTests ? "required" : "not required") : "not assessed"}.`,
    `Commands: ${ledger.commands.length}. Failures: ${ledger.failures.length}.`,
    lastFailure ? `Last failure: ${lastFailure.fingerprint} (${lastFailure.type})` : "",
    `Do not rerun the same command unless you changed code or test files.`,
  ].join("\n");
}

function buildDoctorResume(state: AgentContinuationState<DoctorLedger>): string {
  const ledger = state.ledger;
  return [
    `DOCTOR RESUME:`,
    `Failure signals: ${JSON.stringify(ledger.failureSignals)}.`,
    `Attempted recoveries: ${ledger.attemptedRecoveries.length}.`,
    `Classify and decide on recovery action.`,
  ].join("\n");
}

function buildEpicReviewerResume(state: AgentContinuationState<EpicReviewerLedger>): string {
  const ledger = state.ledger;
  const pendingTickets = Object.entries(ledger.ticketOutcomes)
    .filter(([, o]) => o.status === "failed" || o.status === "escalated");
  return [
    `EPIC-REVIEWER RESUME:`,
    `Ticket outcomes: ${Object.keys(ledger.ticketOutcomes).length}. Pending: ${pendingTickets.length}.`,
    `Partial-ready packets: ${ledger.partialReadyPackets.length}.`,
    `Do not re-review individual diffs from scratch. Classify remaining outcomes.`,
  ].join("\n");
}

function buildKnowledgebaseResume(state: AgentContinuationState<KnowledgebaseLedger>): string {
  const ledger = state.ledger;
  return [
    `KNOWLEDGEBASE RESUME:`,
    `Source epics: ${ledger.sourceEpics.length}. Sections: ${Object.keys(ledger.knowledgeSections).length}.`,
    `Stale knowledge: ${ledger.staleKnowledge.length}.`,
    `Continue extracting lessons or updating sections.`,
  ].join("\n");
}
