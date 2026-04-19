import { toast } from "sonner";
import { AgentEvent, ParsedDiffFile, ParsedDiffHunk, Run } from "./types.ts";

export const WORKSPACES_DIR = "/data/workspaces";
export const LIVE_THRESHOLD_MS = 5000;
export const RUNNING_THRESHOLD_MS = 15_000;

export function normalizeAgentRole(role: string | null | undefined): string {
  if (role === "goalDecomposer") return "epicDecoder";
  if (role === "goalReviewer") return "epicReviewer";
  return role || "unknown";
}

export function isRunActiveForRole(role: string, run: Run): boolean {
  if (run.status !== "running") return false;
  const node = (run.currentNode || "").toLowerCase();
  if (role === "system") return true;
  if (role === "builder") return run.kind === "ticket" && (node === "builder" || node.includes("build"));
  if (role === "explorer") return run.kind === "ticket" && (node === "explorer" || node.includes("explore"));
  if (role === "coder") return run.kind === "ticket" && (node === "coder" || node.includes("code"));
  if (role === "reviewer") return run.kind === "ticket" && (node === "reviewer" || node.includes("review"));
  if (role === "tester") return run.kind === "ticket" && (node === "tester" || node.includes("test"));
  if (role === "doctor") return run.kind === "ticket" && (node === "doctor" || node.includes("classify") || node === "error");
  if (role === "epicDecoder") return run.kind === "epic" && node.includes("decompose");
  if (role === "epicReviewer") return run.kind === "epic" && (node.includes("goal_review") || node.includes("review"));
  return false;
}

export function isCompletedEvent(event: AgentEvent | undefined): boolean {
  if (!event?.payload) return false;
  if (event.payload.done) return true;
  if (event.payload.streamKind !== "status") return false;
  return /(completed|failed|done|succeeded|approved)/i.test(event.payload.content || "");
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  if (!diffText.trim()) return [];
  const files: ParsedDiffFile[] = [];
  let currentFile: ParsedDiffFile | null = null;
  let currentHunk: ParsedDiffHunk | null = null;

  const flushHunk = () => {
    if (currentFile && currentHunk) {
      currentFile.hunks.push(currentHunk);
    }
    currentHunk = null;
  };

  const flushFile = () => {
    flushHunk();
    if (currentFile) files.push(currentFile);
    currentFile = null;
  };

  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (line.startsWith("diff --git ")) {
      flushFile();
      currentFile = { path: "(unknown file)", additions: 0, deletions: 0, hunks: [] };
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("+++ ")) {
      const filePath = line.slice(4).trim();
      currentFile.path = filePath.startsWith("b/") ? filePath.slice(2) : filePath;
      continue;
    }

    if (line.startsWith("@@")) {
      flushHunk();
      currentHunk = { header: line, lines: [] };
      continue;
    }

    if (!currentHunk) continue;

    currentHunk.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) currentFile.additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) currentFile.deletions += 1;
  }

  flushFile();
  return files.filter((file) => file.path !== "(unknown file)" || file.hunks.length > 0);
}

export function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "pr-diff-line-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "pr-diff-line-del";
  if (line.startsWith("\\")) return "pr-diff-line-meta";
  return "pr-diff-line-ctx";
}

export function confirmToast(input: {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  durationMs?: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const id = toast(input.title, {
      description: input.description,
      duration: input.durationMs ?? 12_000,
      action: {
        label: input.confirmLabel ?? "Confirm",
        onClick: () => {
          settled = true;
          resolve(true);
        }
      },
      cancel: {
        label: input.cancelLabel ?? "Cancel",
        onClick: () => {
          settled = true;
          resolve(false);
        }
      },
      onDismiss: () => {
        if (!settled) resolve(false);
      }
    });
    void id;
  });
}

export const AGENT_GLYPHS: Record<string, string> = {
  system: "🖥️",
  builder: "🔨",
  explorer: "🧭",
  coder: "💻",
  reviewer: "🔍",
  tester: "🧪",
  epicDecoder: "🧬",
  epicReviewer: "🔎",
  doctor: "🩺",
  planner: "📐",
  playWriter: "✍️",
  playTester: "🎭",
  unknown: "❓"
};

export const truncateId = (id: string) => id.slice(0, 14) + "…";

export function normalizeDisplayedTicketId(id: string): string {
  return id
    .replace(/__ANA-(\d+)$/i, "__T-$1")
    .replace(/__RSUB(\d+)$/i, "__FIX-$1");
}

export const formatTime = (dateStr: string | null) => {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

export function normalizeCompareUrl(url: string): string {
  return url.replace("...origin/", "...");
}

export function normalizeTicketTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function ticketStatusScore(status: string): number {
  if (status === "approved") return 6;
  if (status === "testing") return 5;
  if (status === "reviewing") return 4;
  if (status === "building") return 3;
  if (status === "queued") return 2;
  if (status === "escalated") return 1;
  if (status === "failed") return 0;
  return 0;
}

export function nodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return (node as React.ReactNode[]).map(nodeText).join("");
  if (node && typeof node === "object" && "props" in (node as object))
    return nodeText(((node as unknown) as { props: { children: React.ReactNode } }).props.children);
  return "";
}

export function headingSlug(text: string): string {
  return "h-" + text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
