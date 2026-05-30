import type {
  KnowledgeArtifact,
  KnowledgeArtifactKind,
  KnowledgeValidationReport,
  RemoteKnowledgeRefreshOutput,
} from "./types.ts";
import type { KnowledgePipelineConfig } from "../../config.ts";
import { nowIso } from "../../utils.ts";

export const REQUIRED_KNOWLEDGE_ARTIFACTS: KnowledgeArtifactKind[] = [
  "repo_capsule",
  "domain_map",
  "architecture_rules",
  "api_contract_notes",
  "ticket_decomposition_patterns",
  "known_failure_modes",
  "testing_guidance",
  "local_model_instructions",
  "staleness_report",
  "refresh_metadata",
];

export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

export function looksLikeRawSourceDump(content: string, maxKnowledgeArtifactSize: number): boolean {
  if (!content) return false;
  if (content.length > maxKnowledgeArtifactSize) return true;
  const codeFenceCount = (content.match(/```/g) ?? []).length;
  const pathHeavyLines = content.split(/\r?\n/u).filter((line) => /(^|\s)(src|lib|tests?|packages|apps|frontend|backend)[/\\][^\s]+/.test(line)).length;
  const sourceLikeBlocks = (content.match(/\b(import|export|class|function|const|let|var)\b/g) ?? []).length;
  return codeFenceCount >= 8 || pathHeavyLines >= 30 || sourceLikeBlocks >= 80;
}

export function validateKnowledgeArtifacts(
  artifacts: KnowledgeArtifact[],
  config: KnowledgePipelineConfig,
): KnowledgeValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byKind = new Map(artifacts.map((artifact) => [artifact.kind, artifact] as const));

  for (const kind of REQUIRED_KNOWLEDGE_ARTIFACTS) {
    const artifact = byKind.get(kind);
    if (!artifact) {
      errors.push(`Missing required artifact: ${kind}`);
      continue;
    }
    if (!artifact.content.trim()) {
      errors.push(`Artifact is empty: ${kind}`);
    }
    if (looksLikeRawSourceDump(artifact.content, config.maxKnowledgeArtifactSize)) {
      errors.push(`Artifact looks like a raw source dump: ${kind}`);
    }
  }

  const domainMap = byKind.get("domain_map");
  if (domainMap && !/domain|subsystem|area/i.test(domainMap.content)) {
    errors.push("Domain map is not parseable enough for selector use.");
  }

  const ticketPatterns = byKind.get("ticket_decomposition_patterns");
  if (ticketPatterns && !/ticket|pattern|split|acceptance/i.test(ticketPatterns.content)) {
    errors.push("Ticket decomposition patterns are too vague.");
  }

  const testingGuidance = byKind.get("testing_guidance");
  if (testingGuidance && !/test|build|lint|typecheck|verify/i.test(testingGuidance.content)) {
    errors.push("Testing guidance must mention at least one verification category.");
  }

  const localModelInstructions = byKind.get("local_model_instructions");
  if (localModelInstructions && !/(9b|30b|local model|context budget|avoid)/i.test(localModelInstructions.content)) {
    warnings.push("Local model instructions do not explicitly mention local model operating guidance.");
  }

  const knownFailureModes = byKind.get("known_failure_modes");
  if (knownFailureModes && !/(avoid|prevent|mitigate|failure)/i.test(knownFailureModes.content)) {
    errors.push("Known failure modes should include prevention guidance.");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    validatedAt: nowIso(),
  };
}

export function validateRemoteKnowledgeRefreshOutput(
  output: RemoteKnowledgeRefreshOutput,
  config: KnowledgePipelineConfig,
): KnowledgeValidationReport {
  return validateKnowledgeArtifacts(output.artifacts, config);
}
