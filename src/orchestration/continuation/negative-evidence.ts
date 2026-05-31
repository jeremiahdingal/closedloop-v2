import type { NegativeEvidence, PositiveEvidence, DiscoveryLedger, EpicDecoderLedger } from "./role-ledgers.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

const DISTINCT_NEGATIVE_SEARCH_LIMIT = 3;
const SAME_TARGET_COLD_RESUME_LIMIT = 1;

const IRRELEVANT_PATH_PATTERNS = [
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  ".expo/",
  "coverage/",
  ".cache/",
  "__pycache__/",
  ".git/",
  "vendor/",
  ".turbo/",
  ".vercel/",
  ".netlify/",
  ".yarn/",
  ".pnp",
  ".closedloop/",
  ".claude/",
  ".qwen/",
  ".zai/",
  "frontend-dist/",
  "data/",
];

// ─── Target extraction ──────────────────────────────────────────────────────

export function inferSearchTarget(patternOrQuery: string): string | null {
  const normalized = patternOrQuery.toLowerCase();

  if (normalized.includes("contact")) return "contact";
  if (normalized.includes("checkout")) return "checkout";
  if (normalized.includes("auth")) return "auth";
  if (normalized.includes("route") || normalized.includes("routing")) return "routing";
  if (normalized.includes("payment")) return "payment";
  if (normalized.includes("cart")) return "cart";
  if (normalized.includes("user")) return "user";
  if (normalized.includes("login") || normalized.includes("signin")) return "auth";
  if (normalized.includes("signup") || normalized.includes("register")) return "auth";
  if (normalized.includes("form")) return "form";
  if (normalized.includes("modal") || normalized.includes("dialog")) return "modal";
  if (normalized.includes("nav") || normalized.includes("menu")) return "navigation";

  return null;
}

// ─── File relevance classification ──────────────────────────────────────────

export function isUsefulProjectFile(path: string): boolean {
  return !IRRELEVANT_PATH_PATTERNS.some((pattern) => path.includes(pattern));
}

export function isWeakOrIrrelevantResult(result: string, filePaths?: string[]): boolean {
  if (!result || result.trim().length === 0) return true;

  const lowerResult = result.toLowerCase();
  if (lowerResult.includes("no files matched") || lowerResult.includes("0 matches")) return true;

  if (filePaths && filePaths.length > 0) {
    const usefulFiles = filePaths.filter(isUsefulProjectFile);
    return usefulFiles.length === 0;
  }

  return false;
}

// ─── Evidence recording ─────────────────────────────────────────────────────

export function recordNegativeEvidence(
  ledger: DiscoveryLedger,
  target: string,
  phase: string,
  pattern: string,
  result: string,
  isWeak: boolean
): DiscoveryLedger {
  const existing = ledger.negativeEvidence.find((e) => e.target === target);

  if (existing) {
    const updated: NegativeEvidence = {
      ...existing,
      searchCount: existing.searchCount + 1,
      failedPatterns: [...existing.failedPatterns, pattern],
      weakMatches: isWeak ? [...existing.weakMatches, pattern] : existing.weakMatches,
      lastSummary: result.slice(0, 200),
      exhausted: existing.searchCount + 1 >= DISTINCT_NEGATIVE_SEARCH_LIMIT,
    };
    return {
      ...ledger,
      negativeEvidence: ledger.negativeEvidence.map((e) =>
        e.target === target ? updated : e
      ),
    };
  }

  const newEntry: NegativeEvidence = {
    target,
    phase,
    failedPatterns: [pattern],
    weakMatches: isWeak ? [pattern] : [],
    proxyFiles: [],
    searchCount: 1,
    lastSummary: result.slice(0, 200),
    exhausted: false,
  };

  return {
    ...ledger,
    negativeEvidence: [...ledger.negativeEvidence, newEntry],
  };
}

export function recordPositiveEvidence(
  ledger: DiscoveryLedger,
  target: string,
  phase: string,
  files: string[],
  facts: string[]
): DiscoveryLedger {
  const existing = ledger.successfulEvidence.find((e) => e.target === target);

  if (existing) {
    const updated: PositiveEvidence = {
      ...existing,
      files: [...new Set([...existing.files, ...files])],
      facts: [...new Set([...existing.facts, ...facts])],
    };
    return {
      ...ledger,
      successfulEvidence: ledger.successfulEvidence.map((e) =>
        e.target === target ? updated : e
      ),
    };
  }

  return {
    ...ledger,
    successfulEvidence: [...ledger.successfulEvidence, { target, files, facts, phase }],
  };
}

// ─── Search exhaustion guards ───────────────────────────────────────────────

export function isTargetExhausted(ledger: DiscoveryLedger, target: string): boolean {
  const negative = ledger.negativeEvidence.find((e) => e.target === target);
  if (!negative) return false;

  if (negative.exhausted) return true;
  if (negative.searchCount >= DISTINCT_NEGATIVE_SEARCH_LIMIT) return true;

  return false;
}

export function hasTargetBeenSearchedAndFailed(
  ledger: DiscoveryLedger,
  target: string
): boolean {
  return ledger.negativeEvidence.some(
    (e) => e.target === target && e.searchCount >= 2
  );
}

export function shouldForceFinishDiscovery(
  ledger: DiscoveryLedger,
  target: string,
  stallReason?: string
): boolean {
  if (stallReason === "busy_no_progress" && hasTargetBeenSearchedAndFailed(ledger, target)) {
    return true;
  }
  return isTargetExhausted(ledger, target);
}

// ─── Cold resume prompt injection ───────────────────────────────────────────

export function buildNegativeEvidenceInjection(
  ledger: DiscoveryLedger,
  currentTarget?: string
): string {
  const negatives = ledger.negativeEvidence;
  if (negatives.length === 0) return "";

  const lines: string[] = ["NEGATIVE EVIDENCE CARRIED FORWARD:"];

  for (const neg of negatives) {
    if (currentTarget && neg.target !== currentTarget) continue;

    lines.push(`Target "${neg.target}" appears missing from the repo.`);
    lines.push("Already tried:");
    for (const pattern of neg.failedPatterns.slice(-5)) {
      lines.push(`- ${pattern}`);
    }
    if (neg.weakMatches.length > 0) {
      lines.push(`Weak/irrelevant matches: ${neg.weakMatches.length}`);
    }
    if (neg.lastSummary) {
      lines.push(`Last result: ${neg.lastSummary}`);
    }
  }

  const positive = ledger.successfulEvidence;
  if (positive.length > 0) {
    lines.push("");
    lines.push("USEFUL PROXY PATTERNS:");
    for (const pos of positive) {
      lines.push(`- ${pos.target}: ${pos.files.slice(0, 3).join(", ")}`);
    }
  }

  lines.push("");
  lines.push("INSTRUCTION:");
  lines.push("Do NOT repeat the searches listed above.");
  lines.push("Finish decomposition by creating tickets that either create the missing target or use the nearest verified proxy pattern.");

  return lines.join("\n");
}

// ─── Pattern similarity check ───────────────────────────────────────────────

export function isEquivalentSearchPattern(
  newPattern: string,
  existingPatterns: string[]
): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[*?[\]{}()"'`]/g, "")
      .replace(/\.(tsx|ts|jsx|js|json|md|css|scss)$/g, "")
      .replace(/[-_/\\]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const next = normalize(newPattern);

  for (const existing of existingPatterns) {
    const prev = normalize(existing);

    if (next === prev) return true;
    if (next.includes(prev) || prev.includes(next)) return true;

    const contactTerms = ["contact", "contactform", "contact form", "contact-form"];
    const nextIsContact = contactTerms.some((t) => next.includes(t));
    const prevIsContact = contactTerms.some((t) => prev.includes(t));
    if (nextIsContact && prevIsContact) return true;

    const authTerms = ["auth", "login", "signin", "signup", "register", "authentication"];
    const nextIsAuth = authTerms.some((t) => next.includes(t));
    const prevIsAuth = authTerms.some((t) => prev.includes(t));
    if (nextIsAuth && prevIsAuth) return true;

    const checkoutTerms = ["checkout", "check-out", "check out"];
    const nextIsCheckout = checkoutTerms.some((t) => next.includes(t));
    const prevIsCheckout = checkoutTerms.some((t) => prev.includes(t));
    if (nextIsCheckout && prevIsCheckout) return true;

    const paymentTerms = ["payment", "pay", "billing", "invoice"];
    const nextIsPayment = paymentTerms.some((t) => next.includes(t));
    const prevIsPayment = paymentTerms.some((t) => prev.includes(t));
    if (nextIsPayment && prevIsPayment) return true;
  }

  return false;
}

export function shouldBlockSearch(
  ledger: DiscoveryLedger,
  target: string,
  newPattern: string
): boolean {
  const negative = ledger.negativeEvidence.find((e) => e.target === target);
  if (!negative) return false;

  if (negative.exhausted) return true;

  if (
    negative.searchCount >= 2 &&
    isEquivalentSearchPattern(newPattern, negative.failedPatterns)
  ) {
    return true;
  }

  if (negative.searchCount >= 3) return true;

  return false;
}
