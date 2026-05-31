import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { makeTempDir } from "./helpers.ts";
import { resolveKnowledgePipelineConfig } from "../src/config.ts";
import { validateKnowledgeArtifacts } from "../src/orchestration/knowledge/validation.ts";
import { KnowledgebaseService } from "../src/orchestration/knowledge/knowledgebase.ts";
import { selectKnowledgeSlice } from "../src/orchestration/knowledge/selector.ts";
import { hardenTickets } from "../src/orchestration/knowledge/hardener.ts";
import { judgeDecomposition } from "../src/orchestration/knowledge/judge.ts";
import { MediatedAgentHarnessGateway } from "../src/orchestration/models.ts";
import type { KnowledgeArtifact, KnowledgebaseSnapshot } from "../src/orchestration/knowledge/types.ts";
import { nowIso } from "../src/utils.ts";

function buildSnapshot(repoRoot: string): KnowledgebaseSnapshot {
  const createdAt = nowIso();
  const artifacts = [
    { kind: "repo_capsule", title: "Repo Capsule", content: "This repo handles orchestration and epic planning.", domains: ["orchestration"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
    { kind: "domain_map", title: "Domain Map", content: "Domain: orchestration\nSubsystem: epic planning", domains: ["orchestration"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
    { kind: "architecture_rules", title: "Architecture Rules", content: "Keep orchestration boundaries stable and avoid repo-wide refactors.", domains: ["orchestration"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
    { kind: "api_contract_notes", title: "API Notes", content: "Preserve GoalDecomposition summary and tickets contract.", domains: ["api"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
    { kind: "ticket_decomposition_patterns", title: "Ticket Patterns", content: "Split by config, selector, judge, refresh job, and tests.", domains: ["planning"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
    { kind: "known_failure_modes", title: "Known Failure Modes", content: "Avoid broad tickets and prevent raw repo dumps.", domains: ["planning"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
    { kind: "testing_guidance", title: "Testing Guidance", content: "Run test, lint, build, and typecheck where relevant.", domains: ["testing"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
    { kind: "local_model_instructions", title: "Local Model Instructions", content: "For 9B and 30B local models, keep context curated and avoid raw source dumps.", domains: ["planning"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
    { kind: "recent_change_history", title: "Recent Change History", content: "Recent epic touched orchestration planning.", domains: ["orchestration"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
    { kind: "staleness_report", title: "Staleness Report", content: "Refresh required only after configured thresholds.", domains: ["ops"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
    { kind: "refresh_metadata", title: "Refresh Metadata", content: "Remote model glm-5.1 produced this snapshot.", domains: ["ops"], updatedAt: createdAt, source: "test", tokenEstimate: 0, version: "v-test" },
  ] satisfies KnowledgeArtifact[];
  return {
    version: "v-test",
    repoRoot,
    commitHash: "abc123",
    createdAt,
    artifacts: artifacts.map((artifact) => ({ ...artifact, tokenEstimate: Math.ceil(artifact.content.length / 4) })),
    metadata: {
      confidenceScore: 0.9,
      generatedByModel: "test",
      refreshReason: "test",
      domainsUpdated: ["orchestration"],
      approvedEpicsSinceRefresh: 0,
      status: "completed",
    },
    validation: {
      valid: true,
      errors: [],
      warnings: [],
      validatedAt: createdAt,
    },
  };
}

test("knowledge pipeline config defaults to remote-strong when remote override is enabled", () => {
  const config = resolveKnowledgePipelineConfig({ remoteOverrideEnabled: true });
  assert.equal(config.enableKnowledgePipeline, true);
  assert.equal(config.enableModelBackedHardener, true);
  assert.equal(config.enableModelBackedJudge, true);
  assert.equal(config.enableModelBackedRepair, true);
  assert.equal(config.strictModelPlanningStages, true);
  assert.equal(config.remoteOverrideForMissingKnowledge, true);
  assert.equal(config.allowDeterministicPlanningFallback, false);
  assert.equal(config.plannerProfile, "remote-strong");
  assert.equal(config.approvedEpicRefreshInterval, 10);
});

test("mediated gateway exposes local planning stage methods for strict knowledge pipeline", () => {
  const gateway = new MediatedAgentHarnessGateway(undefined, {
    epicDecoder: "qwen3.5:9b",
    ticketHardener: "qwen3.5:9b",
    decompositionJudge: "mediated:batiai/qwen3.6-27b:iq3",
    ticketRepair: "mediated:batiai/qwen3.6-27b:iq3",
  } as any, undefined, { applyRemoteOverride: false });

  assert.equal(typeof gateway.runTicketHardener, "function");
  assert.equal(typeof gateway.runDecompositionJudge, "function");
  assert.equal(typeof gateway.runTicketRepair, "function");
});

test("knowledge validation rejects obvious raw source dump artifacts", () => {
  const config = resolveKnowledgePipelineConfig();
  const report = validateKnowledgeArtifacts([
    {
      kind: "repo_capsule",
      title: "Repo Capsule",
      content: "```ts\n".repeat(10) + "export const x = 1;\n".repeat(100),
      domains: [],
      updatedAt: nowIso(),
      source: "test",
      tokenEstimate: 1000,
      version: "v1",
    },
  ] as any, config);
  assert.equal(report.valid, false);
  assert.match(report.errors.join("\n"), /raw source dump|Missing required artifact/);
});

test("knowledge selector returns compact relevant sections and judge rejects broad tickets", async () => {
  const repoRoot = await makeTempDir("knowledge-repo-");
  const snapshot = buildSnapshot(repoRoot);
  const slice = selectKnowledgeSlice({
    epic: {
      id: "epic1",
      title: "Improve orchestration planning",
      goalText: "Add a staged epic decoder for orchestration planning",
      targetDir: repoRoot,
      targetBranch: null,
      status: "planning",
      pausedFromStatus: null,
      scheduledDate: null,
      assetPaths: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    snapshot,
    freshness: {
      state: "fresh",
      refreshRequired: false,
      reasonCodes: [],
      lastRefreshCommit: "abc123",
      currentCommit: "abc123",
      approvedEpicsSinceRefresh: 0,
      warnings: [],
    },
    plannerProfile: "small-local",
    maxSelectedKnowledgeTokens: 6000,
  });
  assert.equal(slice.sections.some((section) => section.kind === "repo_capsule"), true);
  assert.equal(slice.estimatedTokens <= slice.budgetLimit, true);

  const hardened = hardenTickets([{
    id: "T1",
    title: "Implement everything",
    description: "Implement everything and refactor orchestration",
    acceptanceCriteria: ["works correctly"],
    dependencies: [],
    allowedPaths: ["*"],
    priority: "high",
  }], slice);
  const judgement = judgeDecomposition(hardened, "small-local");
  assert.equal(judgement.passed, false);
  assert.equal(judgement.rejectedTickets.length, 1);
});

test("deterministic hardener narrows weak local-model tickets into builder-friendly scope", async () => {
  const repoRoot = await makeTempDir("knowledge-repo-");
  const snapshot = buildSnapshot(repoRoot);
  const slice = selectKnowledgeSlice({
    epic: {
      id: "epic2",
      title: "Tighten ticket quality",
      goalText: "Improve deterministic ticket hardening for local models",
      targetDir: repoRoot,
      targetBranch: null,
      status: "planning",
      pausedFromStatus: null,
      scheduledDate: null,
      assetPaths: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    snapshot,
    freshness: {
      state: "fresh",
      refreshRequired: false,
      reasonCodes: [],
      lastRefreshCommit: "abc123",
      currentCommit: "abc123",
      approvedEpicsSinceRefresh: 0,
      warnings: [],
    },
    plannerProfile: "small-local",
    maxSelectedKnowledgeTokens: 6000,
  });

  const hardened = hardenTickets([{
    id: "T2",
    title: "Improve hardener",
    description: "Update src/orchestration/knowledge/hardener.ts and tests/knowledge-pipeline.test.ts to improve ticket quality.",
    acceptanceCriteria: ["works correctly"],
    dependencies: [],
    allowedPaths: ["*"],
    priority: "high",
    testSpecs: ["tests/knowledge-pipeline.test.ts verifies hardenTickets narrows allowed paths and adds verification guidance."],
  }], slice);

  assert.deepEqual(hardened[0]?.allowedPaths, [
    "src/orchestration/knowledge/hardener.ts",
    "tests/knowledge-pipeline.test.ts",
  ]);
  assert.match(hardened[0]?.description ?? "", /WHAT:/);
  assert.match(hardened[0]?.description ?? "", /WHERE:/);
  assert.equal(hardened[0]?.acceptanceCriteria.some((criterion) => /verify/i.test(criterion)), true);
  assert.equal(hardened[0]?.localModelNotes?.some((note) => /Stay within these paths/i.test(note)), true);

  const judgement = judgeDecomposition(hardened, "small-local");
  assert.equal(judgement.passed, true);
  assert.equal(judgement.rejectedTickets.length, 0);
});

test("knowledgebase service loads snapshot and reports freshness from on-disk state", async () => {
  const dataDir = await makeTempDir("knowledge-data-");
  const repoRoot = await makeTempDir("knowledge-repo-");
  const previousDataDir = process.env.DATA_DIR;
  try {
    process.env.DATA_DIR = dataDir;
    const service = new KnowledgebaseService();
    const snapshot = buildSnapshot(repoRoot);
    const currentDir = service.currentDir(repoRoot);
    await mkdir(path.join(currentDir, "artifacts"), { recursive: true });
    for (const artifact of snapshot.artifacts) {
      await writeFile(service.artifactPath(currentDir, artifact), artifact.content, "utf8");
    }
    await writeFile(service.manifestPath(currentDir), JSON.stringify(snapshot, null, 2), "utf8");
    await writeFile(service.validationPath(currentDir), JSON.stringify(snapshot.validation, null, 2), "utf8");
    await service.markRefreshState(repoRoot, {
      approvedEpicsSinceKnowledgeRefresh: 11,
      lastRefreshCommit: "abc123",
      refreshStatus: "completed",
    });

    const status = await service.getStatus(repoRoot);
    assert.equal(status.available, true);
    assert.equal(status.valid, true);

    const freshness = await service.getFreshness(repoRoot, resolveKnowledgePipelineConfig());
    assert.equal(freshness.refreshRequired, true);
    assert.equal(freshness.reasonCodes.includes("approved_epic_interval"), true);
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  }
});
