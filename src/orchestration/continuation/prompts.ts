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
    default: return genericPhasePrompt(role, phase);
  }
}

function explorerPhasePrompt(phase: string): string {
  switch (phase) {
    case "questions":
      return "Phase: Formulate investigation questions about the repo. Do NOT start reading files yet. List the key questions that need answering.";
    case "map_files":
      return "Phase: Map the repo structure. Use list_dir and glob_files to identify relevant directories and files. Focus on entrypoints, tests, and configs.";
    case "extract_facts":
      return "Phase: Extract facts from relevant files. Read only files that directly answer open investigation questions. Record answers as facts.";
    case "explorer_packet":
      return "Phase: Produce the Explorer Packet. Compile all gathered facts into a structured summary. Call finish with the packet JSON.";
    default:
      return "";
  }
}

function decoderPhasePrompt(phase: string): string {
  switch (phase) {
    case "skeleton":
      return "Phase: Create ticket skeletons. Define ticket IDs, responsibilities, and rough scope. Do NOT fill details yet.";
    case "evidence":
      return "Phase: Gather evidence for each ticket. Read only files needed to fill the ticket details. Record evidence per ticket.";
    case "fill_tickets":
      return "Phase: Fill ticket details from gathered evidence. Add acceptance criteria, dependencies, allowed paths, and test specs.";
    case "self_check":
      return "Phase: Self-check the decomposition. Verify atomicity, dependency ordering, and path specificity.";
    case "final_json":
      return "Phase: Produce the final GoalDecomposition JSON. Call finish with the structured output.";
    default:
      return "";
  }
}

function builderPhasePrompt(phase: string): string {
  switch (phase) {
    case "understand_ticket":
      return "Phase: Understand the ticket. Read the ticket description, acceptance criteria, and allowed paths. Do NOT edit files yet.";
    case "implementation_plan":
      return "Phase: Plan implementation steps. Identify which files to read, which to edit, and in what order.";
    case "edit":
      return "Phase: Edit files. Make the smallest change that addresses the current acceptance criterion. Do not modify files outside allowedPaths.";
    case "verify":
      return "Phase: Verify changes. Run verification commands. Check that acceptance criteria are met.";
    case "builder_packet":
      return "Phase: Produce the Builder Packet. Summarize changes, criteria status, and known risks. Call finish.";
    default:
      return "";
  }
}

function reviewerPhasePrompt(phase: string): string {
  switch (phase) {
    case "diff_map":
      return "Phase: Map the diff. Classify each changed file as relevant or irrelevant to the ticket.";
    case "acceptance_check":
      return "Phase: Check acceptance criteria. For each criterion, determine pass/fail with evidence.";
    case "risk_check":
      return "Phase: Assess risk. Check for path violations, broad refactors, and missing tests.";
    case "verdict":
      return "Phase: Produce the verdict. Return approved or blocked with evidence-backed blockers only.";
    default:
      return "";
  }
}

function testerPhasePrompt(phase: string): string {
  switch (phase) {
    case "test_need":
      return "Phase: Assess test need. Determine if the change requires tests based on scope and risk.";
    case "locate_tests":
      return "Phase: Locate relevant test files. Use glob_files to find test patterns.";
    case "run_tests":
      return "Phase: Run tests. Execute the relevant test commands. Record results.";
    case "classify_failures":
      return "Phase: Classify failures. Determine if failures are product bugs, test bugs, or infra issues.";
    case "test_summary":
      return "Phase: Produce test summary. Compile results into a structured summary. Call finish.";
    default:
      return "";
  }
}

function genericPhasePrompt(role: LocalAgentRole, phase: string): string {
  return `Phase: ${phase} for ${role} role. Continue with the next concrete action for this phase.`;
}
