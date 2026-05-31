import type { LocalAgentRole } from "./agent-state.ts";

// ─── Role phase definitions ──────────────────────────────────────────────────

export const ROLE_PHASES: Record<LocalAgentRole, string[]> = {
  explorer: ["questions", "map_files", "extract_facts", "explorer_packet"],
  epicDecoder: ["skeleton", "evidence", "fill_tickets", "self_check", "final_json"],
  ticketHardener: ["schema_check", "format_check", "scope_check", "hardened_plan"],
  decompositionJudge: ["atomicity_check", "buildability_check", "verdict"],
  ticketRepair: ["load_feedback", "patch_tickets", "validate", "repaired_plan"],
  builder: ["understand_ticket", "implementation_plan", "edit", "verify", "builder_packet"],
  reviewer: ["diff_map", "acceptance_check", "risk_check", "verdict"],
  tester: ["test_need", "locate_tests", "run_tests", "classify_failures", "test_summary"],
  doctor: ["collect_signals", "classify_failure", "choose_recovery"],
  epicReviewer: ["ticket_outcomes", "integration_check", "partial_ready_preservation", "epic_verdict"],
  knowledgebaseBuilder: ["collect_approved_epics", "extract_lessons", "update_sections", "emit_patch"],
};

export function getInitialPhase(role: LocalAgentRole): string {
  return ROLE_PHASES[role][0];
}

export function getNextPhase(role: LocalAgentRole, currentPhase: string): string | null {
  const phases = ROLE_PHASES[role];
  const idx = phases.indexOf(currentPhase);
  if (idx < 0 || idx >= phases.length - 1) return null;
  return phases[idx + 1];
}

// ─── Phase-aware prompt augmentation ─────────────────────────────────────────

export function buildPhasePrompt(role: LocalAgentRole, phase: string): string {
  switch (role) {
    case "explorer": return explorerPhasePrompt(phase);
    case "epicDecoder": return decoderPhasePrompt(phase);
    case "builder": return builderPhasePrompt(phase);
    case "reviewer": return reviewerPhasePrompt(phase);
    case "tester": return testerPhasePrompt(phase);
    case "epicReviewer": return epicReviewerPhasePrompt(phase);
    default: return genericPhasePrompt(role, phase);
  }
}

function explorerPhasePrompt(phase: string): string {
  switch (phase) {
    case "questions":
      return "Phase: Formulate investigation questions about the repo. Do NOT start reading files yet. List the key questions that need answering. Call finish_looplet when the questions are ready to hand off.";
    case "map_files":
      return "Phase: Map the repo structure. Use list_dir and glob_files to identify relevant directories and files. Focus on entrypoints, tests, and configs. Call finish_looplet when the map is ready to hand off.";
    case "extract_facts":
      return "Phase: Extract facts from relevant files. Read only files that directly answer open investigation questions. Record answers as facts. Call finish_looplet when the facts are ready to hand off.";
    case "explorer_packet":
      return "Phase: Produce the Explorer Packet. Compile all gathered facts into a structured summary. Call finish with the packet JSON.";
    default:
      return "";
  }
}

function decoderPhasePrompt(phase: string): string {
  switch (phase) {
    case "skeleton":
      return "Phase: Create ticket skeletons. Define ticket IDs, responsibilities, and rough scope. Do NOT fill details yet. Call finish_looplet when the skeletons are ready to hand off.";
    case "evidence":
      return "Phase: Gather evidence for each ticket. Read only files needed to fill the ticket details. Record evidence per ticket. Call finish_looplet when the evidence is ready to hand off.";
    case "fill_tickets":
      return "Phase: Fill ticket details from gathered evidence. Add acceptance criteria, dependencies, allowed paths, and test specs. Call finish_looplet when the ticket set is ready to hand off.";
    case "self_check":
      return "Phase: Self-check the decomposition. Verify atomicity, dependency ordering, and path specificity. Call finish_looplet when the self-check is complete.";
    case "final_json":
      return "Phase: Produce the final GoalDecomposition JSON. Call finish with the structured output.";
    default:
      return "";
  }
}

function builderPhasePrompt(phase: string): string {
  switch (phase) {
    case "understand_ticket":
      return "Phase: Understand the ticket. Read the ticket description, acceptance criteria, and allowed paths. Do NOT edit files yet. Call finish_looplet when the ticket is understood.";
    case "implementation_plan":
      return "Phase: Plan implementation steps. Identify which files to read, which to edit, and in what order. Call finish_looplet when the plan is ready to hand off.";
    case "edit":
      return "Phase: Edit files. Make the smallest change that addresses the current acceptance criterion. Do not modify files outside allowedPaths. Call finish_looplet when the edits are ready to hand off.";
    case "verify":
      return "Phase: Verify changes. Run verification commands. Check that acceptance criteria are met. Call finish_looplet when verification is complete.";
    case "builder_packet":
      return "Phase: Produce the Builder Packet. Summarize changes, criteria status, and known risks. Call finish.";
    default:
      return "";
  }
}

function reviewerPhasePrompt(phase: string): string {
  switch (phase) {
    case "diff_map":
      return "Phase: Map the diff. Classify each changed file as relevant or irrelevant to the ticket. Call finish_looplet when the diff map is ready to hand off.";
    case "acceptance_check":
      return "Phase: Check acceptance criteria. For each criterion, determine pass/fail with evidence. Call finish_looplet when the check is ready to hand off.";
    case "risk_check":
      return "Phase: Assess risk. Check for path violations, broad refactors, and missing tests. Call finish_looplet when the risk assessment is ready to hand off.";
    case "verdict":
      return "Phase: Produce the verdict. Return approved or blocked with evidence-backed blockers only. Call finish with the verdict JSON.";
    default:
      return "";
  }
}

function testerPhasePrompt(phase: string): string {
  switch (phase) {
    case "test_need":
      return "Phase: Assess test need. Determine if the change requires tests based on scope and risk. Call finish_looplet when the assessment is ready to hand off.";
    case "locate_tests":
      return "Phase: Locate relevant test files. Use glob_files to find test patterns. Call finish_looplet when the test locations are ready to hand off.";
    case "run_tests":
      return "Phase: Run tests. Execute the relevant test commands. Record results. Call finish_looplet when the results are ready to hand off.";
    case "classify_failures":
      return "Phase: Classify failures. Determine if failures are product bugs, test bugs, or infra issues. Call finish_looplet when the classification is ready to hand off.";
    case "test_summary":
      return "Phase: Produce test summary. Compile results into a structured summary. Call finish.";
    default:
      return "";
  }
}

function epicReviewerPhasePrompt(phase: string): string {
  switch (phase) {
    case "ticket_outcomes":
      return "Phase: Record ticket outcomes from the epic review. Summarize what is approved, partial, or blocked. Call finish_looplet when the outcome map is ready to hand off.";
    case "integration_check":
      return "Phase: Check cross-ticket integration, shared assumptions, and dependency ordering. Call finish_looplet when the integration check is ready to hand off.";
    case "partial_ready_preservation":
      return "Phase: Preserve any partial-ready work and capture reusable integration advice. Call finish_looplet when the preservation notes are ready to hand off.";
    case "epic_verdict":
      return "Phase: Produce the epic verdict. Return the final verdict JSON. Call finish with the structured output.";
    default:
      return "";
  }
}

function genericPhasePrompt(role: LocalAgentRole, phase: string): string {
  return `Phase: ${phase} for ${role} role. Continue with the next concrete action for this phase.`;
}

// ─── Phase-aware tool allowlists ──────────────────────────────────────────────

export function getAllowedToolsForPhase(role: LocalAgentRole, phase: string): string[] {
  if (role === "epicDecoder") {
    const EPIC_DECODER_TOOLS_BY_PHASE: Record<string, string[]> = {
      skeleton: ["list_dir", "glob_files", "finish_looplet"],
      evidence: ["read_file", "read_files", "glob_files", "grep_files", "semantic_search", "finish_looplet"],
      fill_tickets: ["finish_looplet"],
      self_check: ["finish_looplet"],
      final_json: ["finish"],
    };
    return EPIC_DECODER_TOOLS_BY_PHASE[phase] ?? ["finish"];
  }
  if (role === "explorer") {
    const EXPLORER_TOOLS_BY_PHASE: Record<string, string[]> = {
      questions: ["finish_looplet"],
      map_files: ["list_dir", "glob_files", "finish_looplet"],
      extract_facts: ["read_file", "read_files", "glob_files", "grep_files", "semantic_search", "finish_looplet"],
      explorer_packet: ["finish"],
    };
    return EXPLORER_TOOLS_BY_PHASE[phase] ?? ["finish"];
  }
  if (role === "builder") {
    const BUILDER_TOOLS_BY_PHASE: Record<string, string[]> = {
      understand_ticket: ["read_file", "read_files", "finish_looplet"],
      implementation_plan: ["finish_looplet"],
      edit: ["read_file", "read_files", "write_file", "write_files", "search_replace", "git_diff", "git_status", "finish_looplet"],
      verify: ["read_file", "read_files", "git_diff", "git_status", "run_command", "finish_looplet"],
      builder_packet: ["finish"],
    };
    return BUILDER_TOOLS_BY_PHASE[phase] ?? ["finish"];
  }
  if (role === "reviewer") {
    const REVIEWER_TOOLS_BY_PHASE: Record<string, string[]> = {
      diff_map: ["read_file", "git_diff", "git_status", "finish_looplet"],
      acceptance_check: ["read_file", "git_diff", "finish_looplet"],
      risk_check: ["read_file", "git_diff", "finish_looplet"],
      verdict: ["finish"],
    };
    return REVIEWER_TOOLS_BY_PHASE[phase] ?? ["finish"];
  }
  if (role === "epicReviewer") {
    const EPIC_REVIEWER_TOOLS_BY_PHASE: Record<string, string[]> = {
      ticket_outcomes: ["read_file", "read_files", "git_diff", "git_status", "finish_looplet"],
      integration_check: ["read_file", "read_files", "git_diff", "git_status", "finish_looplet"],
      partial_ready_preservation: ["read_file", "read_files", "git_diff", "git_status", "finish_looplet"],
      epic_verdict: ["finish"],
    };
    return EPIC_REVIEWER_TOOLS_BY_PHASE[phase] ?? ["finish"];
  }
  if (role === "tester") {
    const TESTER_TOOLS_BY_PHASE: Record<string, string[]> = {
      test_need: ["finish_looplet"],
      locate_tests: ["glob_files", "grep_files", "finish_looplet"],
      run_tests: ["run_command", "finish_looplet"],
      classify_failures: ["read_file", "finish_looplet"],
      test_summary: ["finish"],
    };
    return TESTER_TOOLS_BY_PHASE[phase] ?? ["finish"];
  }
  return [];
}

// ─── Continuation-specific decoder prompts ─────────────────────────────────────

export function buildEpicDecoderContinuationPrompt({
  epic,
  state,
  repoCapsule,
  domainMap,
  evidenceLedger,
}: {
  epic: string;
  state: { phase: string; ledger?: any };
  repoCapsule?: string;
  domainMap?: string;
  evidenceLedger?: Record<string, { status: string; files: string[]; facts: string[] }>;
}): string {
  const { phase } = state;

  switch (phase) {
    case "skeleton":
      return [
        `You are in phase: skeleton.`,
        ``,
        `Create ticket skeletons from the epic description.`,
        `You may use list_dir and glob_files to understand repo structure before creating skeletons.`,
        `Do NOT read file contents in this phase.`,
        `Each ticket skeleton needs: id, responsibility, and status="skeleton".`,
        `Call finish_looplet with ticketUpdates containing the skeletons.`,
        ``,
        `Example finish_looplet call:`,
        `{"summary":"Created 5 ticket skeletons","phaseComplete":true,"ticketUpdates":[{"id":"T001","responsibility":"Set up routing module","status":"skeleton"},{"id":"T002","responsibility":"Add auth middleware","status":"skeleton"}]}`,
        ``,
        `Epic: ${epic}`,
        repoCapsule ? `\nRepo Capsule:\n${repoCapsule}` : "",
        domainMap ? `\nDomain Map:\n${domainMap}` : "",
      ].join("\n");

    case "evidence":
      const filledEvidence = evidenceLedger ? Object.keys(evidenceLedger).filter(k => evidenceLedger[k].status === "filled").join(", ") : "";
      const missingEvidence = evidenceLedger ? Object.keys(evidenceLedger).filter(k => evidenceLedger[k].status !== "filled").join(", ") : "";
      const ticketSkeletons = Array.isArray(state.ledger?.ticketSkeletons)
        ? state.ledger.ticketSkeletons
            .slice(0, 16)
            .map((ticket: any) => `${ticket.id}: ${ticket.responsibility ?? "(no responsibility)"} [${ticket.status ?? "skeleton"}]`)
            .join("\n")
        : "";
      return [
        `You are in phase: evidence.`,
        ``,
        `Use the listed ticket skeletons below to decide which files need evidence.`,
        ticketSkeletons ? `Ticket skeletons:\n${ticketSkeletons}` : `Ticket skeletons are not available in the prompt; infer the next narrow evidence target from the epic and current phase.`,
        ``,
        `Call one allowed evidence tool immediately: glob_files, grep_files, semantic_search, read_file, or read_files.`,
        `Do not narrate your plan in prose. Do not call finish in this phase.`,
        `Read only files needed to fill ticket details. Record evidence per ticket.`,
        `Call finish_looplet with evidenceUpdates when done.`,
        ``,
        `Example finish_looplet call:`,
        `{"summary":"Gathered evidence for T001 and T002","phaseComplete":false,"evidenceUpdates":[{"slotId":"T001_routing","facts":["Router is in src/router.ts","Uses express Router()"],"files":["src/router.ts"]},{"slotId":"T002_auth","facts":["Auth middleware in src/middleware/auth.ts"],"files":["src/middleware/auth.ts"]}]}`,
        ``,
        filledEvidence ? `Filled evidence: ${filledEvidence}` : "",
        missingEvidence ? `Missing evidence: ${missingEvidence}` : "",
      ].filter(Boolean).join("\n");

    case "fill_tickets":
      return [
        `You are in phase: fill_tickets.`,
        ``,
        `Do not inspect more files unless a required evidence slot is still missing.`,
        `Fill the ticket descriptions using current evidence.`,
        `Call finish_looplet with ticketUpdates when done.`,
        ``,
        `Example finish_looplet call:`,
        `{"summary":"Filled all ticket details","phaseComplete":true,"ticketUpdates":[{"id":"T001","responsibility":"Set up routing module","status":"filled"},{"id":"T002","responsibility":"Add auth middleware","status":"filled"}]}`,
      ].join("\n");

    case "self_check":
      return [
        `You are in phase: self_check.`,
        ``,
        `Verify atomicity, dependency ordering, and path specificity.`,
        `Call finish_looplet with phaseComplete=true when done.`,
        ``,
        `Example: {"summary":"Self-check passed","phaseComplete":true}`,
      ].join("\n");

    case "final_json":
      return [
        `You are in phase: final_json.`,
        ``,
        `Produce the final GoalDecomposition JSON.`,
        `Call finish with the structured output.`,
        ``,
        `Example finish call:`,
        `{"result":"{\"summary\":\"...\",\"tickets\":[{\"id\":\"T001\",\"title\":\"Set up routing\",\"description\":\"...\",\"acceptanceCriteria\":[\"Router handles GET /\"],\"dependencies\":[],\"allowedPaths\":[\"src/router.ts\"],\"priority\":\"high\"}]}","summary":"Decomposition complete"}`,
      ].join("\n");

    default:
      return "";
  }
}
