import type {
  BuilderOperation,
  BuilderPlan,
  CoderOutput,
  EditOperation,
  ExplorerOutput,
  FailureDecision,
  GoalDecomposition,
  GoalReview,
  GoalTicketPlan,
  ReviewerVerdict
} from "../types.ts";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isEditOperation(value: unknown): value is EditOperation {
  if (!value || typeof value !== "object") return false;
  const op = value as any;
  if (op.kind === "search_replace") {
    return typeof op.path === "string" && typeof op.expected_sha256 === "string" && typeof op.search === "string" && typeof op.replace === "string";
  }
  if (op.kind === "create_file") {
    return typeof op.path === "string" && typeof op.content === "string";
  }
  if (op.kind === "append_file") {
    return typeof op.path === "string" && typeof op.content === "string";
  }
  if (op.kind === "delete_file") {
    return typeof op.path === "string" && typeof op.expected_sha256 === "string" && typeof op.reason === "string";
  }
  if (op.kind === "rename_file") {
    return typeof op.path === "string" && typeof op.newPath === "string" && typeof op.expected_sha256 === "string" && typeof op.reason === "string";
  }
  return false;
}

export function validateExplorerOutput(value: unknown): ExplorerOutput {
  if (!value || typeof value !== "object") throw new Error("Explorer output is not an object");
  const record = value as Record<string, unknown>;
  if (
    !isStringArray(record.relevantFiles) ||
    !isStringArray(record.relevantSymbols) ||
    !Array.isArray(record.likelyEditRegions) ||
    typeof record.summary !== "string" ||
    !isStringArray(record.risks) ||
    !isStringArray(record.missingContext) ||
    !isStringArray(record.recommendedFilesForCoding)
  ) {
    throw new Error("Explorer output shape invalid");
  }
  return record as unknown as ExplorerOutput;
}

export function validateCoderOutput(value: unknown): CoderOutput {
  if (!value || typeof value !== "object") throw new Error("Coder output is not an object");
  const record = value as Record<string, unknown>;
  if (
    typeof record.summary !== "string" ||
    !isStringArray(record.intendedFiles) ||
    !isStringArray(record.unresolvedBlockers) ||
    !Array.isArray(record.operations) ||
    !record.operations.every(isEditOperation)
  ) {
    throw new Error("Coder output shape invalid");
  }
  return record as unknown as CoderOutput;
}

function isGoalTicketPlan(value: unknown): value is GoalTicketPlan {
  if (!value || typeof value !== "object") return false;
  const ticket = value as Record<string, unknown>;
  return (
    typeof ticket.id === "string" &&
    typeof ticket.title === "string" &&
    typeof ticket.description === "string" &&
    isStringArray(ticket.acceptanceCriteria) &&
    isStringArray(ticket.dependencies) &&
    isStringArray(ticket.allowedPaths) &&
    (ticket.priority === "high" || ticket.priority === "medium" || ticket.priority === "low")
  );
}

function isBuilderOperation(value: unknown): value is BuilderOperation {
  if (!value || typeof value !== "object") return false;
  const op = value as Record<string, unknown>;
  return (
    (op.kind === "replace_file" || op.kind === "append_file") &&
    typeof op.path === "string" &&
    typeof op.content === "string"
  );
}

function normalizeBuilderPath(value: string): string {
  return value
    .trim()
    .replace(/^[`"'[\](){}]+/, "")
    .replace(/[`"',\])}]+$/, "")
    .trim();
}

export function validateGoalDecomposition(value: unknown): GoalDecomposition {
  if (!value || typeof value !== "object") throw new Error("Goal decomposition is not an object");
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string" || !Array.isArray(record.tickets) || !record.tickets.every(isGoalTicketPlan)) {
    throw new Error("Goal decomposition shape invalid");
  }
  return record as unknown as GoalDecomposition;
}

export function validateBuilderPlan(value: unknown): BuilderPlan {
  if (!value || typeof value !== "object") throw new Error("Builder plan is not an object");
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string" || !isStringArray(record.intendedFiles) || !Array.isArray(record.operations) || !record.operations.every(isBuilderOperation)) {
    throw new Error("Builder plan shape invalid");
  }
  const intendedFiles = record.intendedFiles
    .map((file) => normalizeBuilderPath(file))
    .filter(Boolean);
  const operations = record.operations.map((operation) => {
    const typed = operation as BuilderOperation;
    return {
      ...typed,
      path: normalizeBuilderPath(typed.path)
    };
  }).filter((operation) => operation.path.length > 0);
  if (!intendedFiles.length || !operations.length) {
    throw new Error("Builder plan paths invalid");
  }
  return {
    summary: record.summary,
    intendedFiles,
    operations
  } satisfies BuilderPlan;
}

export function validateReviewerVerdict(value: unknown): ReviewerVerdict {
  if (!value || typeof value !== "object") throw new Error("Reviewer verdict is not an object");
  const record = value as Record<string, unknown>;
  if (
    typeof record.approved !== "boolean" ||
    !isStringArray(record.blockers) ||
    !isStringArray(record.suggestions) ||
    (record.riskLevel !== "low" && record.riskLevel !== "medium" && record.riskLevel !== "high")
  ) {
    throw new Error("Reviewer verdict shape invalid");
  }
  const verdict = record as ReviewerVerdict;
  ensureReviewerTextLooksValid(verdict.blockers, "blockers");
  ensureReviewerTextLooksValid(verdict.suggestions, "suggestions");
  return verdict;
}

export function validateGoalReview(value: unknown): GoalReview {
  if (!value || typeof value !== "object") throw new Error("Goal review is not an object");
  const record = value as Record<string, unknown>;
  if (
    (record.verdict !== "approved" && record.verdict !== "needs_followups" && record.verdict !== "failed") ||
    typeof record.summary !== "string" ||
    !Array.isArray(record.followupTickets) ||
    !record.followupTickets.every(isGoalTicketPlan)
  ) {
    throw new Error("Goal review shape invalid");
  }
  return record as GoalReview;
}

export function validateFailureDecision(value: unknown): FailureDecision {
  if (!value || typeof value !== "object") throw new Error("Failure decision is not an object");
  const record = value as Record<string, unknown>;
  if (
    (record.decision !== "retry_same_node" &&
      record.decision !== "retry_builder" &&
      record.decision !== "blocked" &&
      record.decision !== "todo" &&
      record.decision !== "escalate") ||
    typeof record.reason !== "string"
  ) {
    throw new Error("Failure decision shape invalid");
  }
  return record as FailureDecision;
}

export type FailureDecisionContext = {
  repeatedBlockers: boolean;
  repeatedTestFailure: boolean;
  noDiff: boolean;
  infraFailure: boolean;
  currentNode?: string | null;
  secondaryChangeSignal?: boolean;
};

export function validateFailureDecisionWithContext(value: unknown, context: FailureDecisionContext): FailureDecision {
  const decision = validateFailureDecision(value);
  const reason = decision.reason.toLowerCase();

  if (decision.decision === "retry_same_node" && !context.infraFailure) {
    throw new Error("Failure decision asked to retry the same node without an infrastructure failure");
  }

  if (
    decision.decision === "escalate" &&
    context.noDiff &&
    !context.repeatedBlockers &&
    !context.repeatedTestFailure &&
    !context.secondaryChangeSignal
  ) {
    throw new Error(`Failure decision escalated a no-diff state without a repeated blocker or secondary signal: ${reason}`);
  }

  if (decision.decision === "blocked" || decision.decision === "todo") {
    if (!context.repeatedBlockers && !context.repeatedTestFailure && !context.infraFailure) {
      throw new Error(`Failure decision returned ${decision.decision} without a retryable reason`);
    }
  }

  return decision;
}

export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();

  // 1. Prefer content inside <FINAL_JSON> tags
  const tagged = trimmed.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/i);
  if (tagged) {
    try { return JSON.parse(tagged[1].trim()); } catch {}
  }

  // 2. Fenced code block
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  // 3. Brace-balanced extraction — find first { or [ and walk to matching close
  const firstBrace = Math.min(
    ...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((index) => index >= 0)
  );
  if (!Number.isFinite(firstBrace) || firstBrace < 0) return JSON.parse(trimmed);

  const openChar = trimmed[firstBrace];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = firstBrace; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar && --depth === 0) return JSON.parse(trimmed.slice(firstBrace, i + 1));
  }

  // 4. Last resort: slice from first brace to end
  return JSON.parse(trimmed.slice(firstBrace));
}

function ensureReviewerTextLooksValid(items: string[], fieldName: "blockers" | "suggestions"): void {
  const cleaned = items.map((item) => String(item || "").trim()).filter(Boolean);
  if (cleaned.length === 0) return;

  const suspicious = cleaned.filter((item) => isReviewerTextSuspicious(item));
  if (suspicious.length > 0) {
    throw new Error(`Reviewer verdict ${fieldName} contain invalid text: ${suspicious[0]}`);
  }

  const normalizedItems = cleaned.map((item) => normalizeReviewerText(item));
  const uniqueNormalized = new Set(normalizedItems);
  if (cleaned.length >= 3 && uniqueNormalized.size <= Math.ceil(cleaned.length / 2)) {
    throw new Error(`Reviewer verdict ${fieldName} are excessively repetitive`);
  }

  const bareWordItems = cleaned.filter((item) => /^[A-Za-z][A-Za-z-]{1,20}$/.test(item));
  if (cleaned.length >= 3 && bareWordItems.length === cleaned.length) {
    throw new Error(`Reviewer verdict ${fieldName} look unrelated to code review`);
  }
}

function isReviewerTextSuspicious(item: string): boolean {
  const normalized = normalizeReviewerText(item);
  if (!normalized) return true;
  if (normalized.length < 4) return true;
  if (normalized.length > 240) return true;

  const badPatterns = [
    /\byou are\b/,
    /\bai model\b/,
    /\bsecurity and encryption tools\b/,
    /\bfunction_name\b/,
    /\bfunc_\d+\b/,
    /\bfunction_type\b/,
    /\bapproved\b.*\btrue\b/,
    /\bblockegs\b/,
    /\bcontains a typo\b/,
    /\bit should be\b/,
    /\balready used in the json\b/,
    /\bplease use these tools only\b/,
    /\bprotect user data\b/
  ];
  if (badPatterns.some((pattern) => pattern.test(normalized))) return true;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const uniqueTokens = new Set(tokens);
  if (tokens.length >= 6 && uniqueTokens.size <= Math.ceil(tokens.length / 3)) return true;

  return false;
}

function normalizeReviewerText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'.,;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
