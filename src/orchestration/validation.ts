import type {
  BuilderOperation,
  BuilderPlan,
  FailureDecision,
  GoalDecomposition,
  GoalReview,
  GoalTicketPlan,
  ReviewerVerdict
} from "../types.ts";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
  return record as ReviewerVerdict;
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
