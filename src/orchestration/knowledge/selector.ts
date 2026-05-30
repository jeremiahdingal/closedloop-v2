import type { PlannerProfile } from "../../config.ts";
import type { EpicRecord } from "../../types.ts";
import type {
  KnowledgeArtifact,
  KnowledgeArtifactKind,
  KnowledgeFreshnessStatus,
  KnowledgebaseSnapshot,
  SelectedKnowledgeSection,
  SelectedKnowledgeSlice,
} from "./types.ts";
import { estimateTokens } from "./validation.ts";

function normalize(text: string): string {
  return text.toLowerCase();
}

function matchesEpic(artifact: KnowledgeArtifact, epic: EpicRecord): boolean {
  const text = `${epic.title} ${epic.goalText}`.toLowerCase();
  if (artifact.domains.some((domain) => text.includes(domain.toLowerCase()))) return true;
  return artifact.title.toLowerCase().split(/\s+/u).some((word) => word.length >= 4 && text.includes(word));
}

function sectionFromArtifact(artifact: KnowledgeArtifact): SelectedKnowledgeSection {
  return {
    title: artifact.title,
    kind: artifact.kind,
    content: artifact.content,
    tokenEstimate: artifact.tokenEstimate || estimateTokens(artifact.content),
  };
}

function profileBudget(profile: PlannerProfile, maxSelectedKnowledgeTokens: number): number {
  if (profile === "medium-local") return Math.min(maxSelectedKnowledgeTokens, 5000);
  if (profile === "remote-strong") return Math.min(Math.max(maxSelectedKnowledgeTokens, 6000), 16000);
  return Math.min(Math.max(maxSelectedKnowledgeTokens, 6000), 10000);
}

export function selectKnowledgeSlice(input: {
  epic: EpicRecord;
  snapshot: KnowledgebaseSnapshot | null;
  freshness: KnowledgeFreshnessStatus;
  plannerProfile: PlannerProfile;
  maxSelectedKnowledgeTokens: number;
  recentMemorySections?: string[];
}): SelectedKnowledgeSlice {
  const { epic, snapshot, freshness, plannerProfile } = input;
  const budgetLimit = profileBudget(plannerProfile, input.maxSelectedKnowledgeTokens);
  const sections: SelectedKnowledgeSection[] = [];
  const includeReasons: Record<string, string> = {};
  const warnings = [...freshness.warnings];
  const includedKinds: Array<KnowledgeArtifactKind | "epic_summary"> = [];
  const excludedKinds = new Set<KnowledgeArtifactKind>();

  const epicSummary = `Epic Summary\nTitle: ${epic.title}\nGoal: ${epic.goalText}`;
  sections.push({
    title: "Epic Summary",
    kind: "epic_summary",
    content: epicSummary,
    tokenEstimate: estimateTokens(epicSummary),
  });
  includedKinds.push("epic_summary");
  includeReasons.epic_summary = "Always include a compact restatement of the epic.";

  if (!snapshot) {
    const fallbackSections = [
      "Knowledge is unavailable. Do not invent repo facts.",
      "Prefer narrow exploratory tickets over broad implementation tickets.",
      "Do not include raw full-repo context.",
    ].join("\n");
    sections.push({
      title: "Fallback Guidance",
      kind: "local_model_instructions",
      content: fallbackSections,
      tokenEstimate: estimateTokens(fallbackSections),
    });
    includedKinds.push("local_model_instructions");
    includeReasons.local_model_instructions = "Fallback operating rules when no cached knowledge exists.";
    return {
      sections,
      includedArtifactKinds: includedKinds,
      excludedArtifactKinds: [],
      includeReasons,
      estimatedTokens: sections.reduce((sum, section) => sum + section.tokenEstimate, 0),
      budgetLimit,
      fallbackMode: "missing_knowledge",
      freshnessState: freshness.state,
      plannerProfile,
      knowledgeVersion: null,
      warnings,
    };
  }

  const preferredOrder: KnowledgeArtifactKind[] = [
    "repo_capsule",
    "domain_map",
    "architecture_rules",
    "ticket_decomposition_patterns",
    "known_failure_modes",
    "testing_guidance",
    "local_model_instructions",
    "api_contract_notes",
    "recent_change_history",
    "staleness_report",
    "refresh_metadata",
  ];

  const matching = new Map(snapshot.artifacts.map((artifact) => [artifact.kind, artifact] as const));
  for (const kind of preferredOrder) {
    const artifact = matching.get(kind);
    if (!artifact) continue;
    if (kind !== "repo_capsule" && kind !== "testing_guidance" && kind !== "local_model_instructions" && !matchesEpic(artifact, epic)) {
      excludedKinds.add(kind);
      continue;
    }
    sections.push(sectionFromArtifact(artifact));
    includedKinds.push(kind);
    includeReasons[kind] = kind === "repo_capsule"
      ? "Always include a compact repo capsule."
      : `Included because ${kind} appears relevant to the epic.`;
  }

  for (const memory of input.recentMemorySections ?? []) {
    const tokenEstimate = estimateTokens(memory);
    sections.push({
      title: "Recent Relevant Memory",
      kind: "recent_change_history",
      content: memory,
      tokenEstimate,
    });
    includedKinds.push("recent_change_history");
    includeReasons[`recent_memory_${sections.length}`] = "Included because recent local epic memory matched the epic.";
  }

  let used = 0;
  const trimmedSections: SelectedKnowledgeSection[] = [];
  for (const section of sections) {
    if (used + section.tokenEstimate > budgetLimit) {
      if (section.kind !== "epic_summary") {
        if (section.kind !== "recent_change_history") excludedKinds.add(section.kind);
        continue;
      }
    }
    trimmedSections.push(section);
    used += section.tokenEstimate;
  }

  const fallbackMode = freshness.state === "critical_stale"
    ? "critical_stale"
    : freshness.state === "stale"
      ? "stale_knowledge"
      : "none";

  return {
    sections: trimmedSections,
    includedArtifactKinds: includedKinds.filter((kind, index, array) => array.indexOf(kind) === index),
    excludedArtifactKinds: Array.from(excludedKinds),
    includeReasons,
    estimatedTokens: used,
    budgetLimit,
    fallbackMode,
    freshnessState: freshness.state,
    plannerProfile,
    knowledgeVersion: snapshot.version,
    warnings,
  };
}
