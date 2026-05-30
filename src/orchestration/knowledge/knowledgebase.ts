import { createHash } from "node:crypto";
import path from "node:path";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { AppConfig, KnowledgePipelineConfig } from "../../config.ts";
import { loadConfig } from "../../config.ts";
import { nowIso } from "../../utils.ts";
import type {
  KnowledgeArtifact,
  KnowledgeFreshnessStatus,
  KnowledgeStatus,
  KnowledgeValidationReport,
  KnowledgebaseSnapshot,
  LocalEpicMemory,
  RefreshState,
  RemoteKnowledgeRefreshOutput,
  StagedKnowledgebase,
} from "./types.ts";
import { REQUIRED_KNOWLEDGE_ARTIFACTS, estimateTokens, validateKnowledgeArtifacts } from "./validation.ts";
import { git } from "../../bridge/git.ts";

const DEFAULT_REFRESH_STATE: RefreshState = {
  approvedEpicsSinceKnowledgeRefresh: 0,
  lastRefreshAt: null,
  lastRefreshCommit: null,
  lastRefreshReason: null,
  refreshStatus: "idle",
  lastFailureReason: null,
  plannerFailureCount: 0,
  unknownDomainCount: 0,
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

export class KnowledgebaseService {
  readonly config: AppConfig;

  constructor(config: AppConfig = loadConfig()) {
    this.config = config;
  }

  repoHash(repoRoot: string): string {
    return createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 16);
  }

  repoKnowledgeRoot(repoRoot: string): string {
    return path.join(this.config.dataDir, "knowledgebases", this.repoHash(repoRoot));
  }

  currentDir(repoRoot: string): string {
    return path.join(this.repoKnowledgeRoot(repoRoot), "current");
  }

  historyDir(repoRoot: string): string {
    return path.join(this.repoKnowledgeRoot(repoRoot), "history");
  }

  stagedDir(repoRoot: string, refreshId: string): string {
    return path.join(this.repoKnowledgeRoot(repoRoot), "staged", refreshId);
  }

  localMemoryPath(repoRoot: string): string {
    return path.join(this.repoKnowledgeRoot(repoRoot), "local-memory", "epic-memory.jsonl");
  }

  refreshStatePath(repoRoot: string): string {
    return path.join(this.repoKnowledgeRoot(repoRoot), "refresh-state.json");
  }

  manifestPath(rootDir: string): string {
    return path.join(rootDir, "manifest.json");
  }

  validationPath(rootDir: string): string {
    return path.join(rootDir, "validation.json");
  }

  artifactPath(rootDir: string, artifact: KnowledgeArtifact): string {
    return path.join(rootDir, "artifacts", `${artifact.kind}.md`);
  }

  async ensureRepoDirs(repoRoot: string): Promise<void> {
    await mkdir(this.repoKnowledgeRoot(repoRoot), { recursive: true });
    await mkdir(path.join(this.repoKnowledgeRoot(repoRoot), "local-memory"), { recursive: true });
    await mkdir(this.historyDir(repoRoot), { recursive: true });
  }

  async readRefreshState(repoRoot: string): Promise<RefreshState> {
    try {
      const raw = await readFile(this.refreshStatePath(repoRoot), "utf8");
      return { ...DEFAULT_REFRESH_STATE, ...JSON.parse(raw) } as RefreshState;
    } catch {
      return { ...DEFAULT_REFRESH_STATE };
    }
  }

  async markRefreshState(repoRoot: string, state: Partial<RefreshState>): Promise<void> {
    await this.ensureRepoDirs(repoRoot);
    const merged = { ...(await this.readRefreshState(repoRoot)), ...state };
    await writeFile(this.refreshStatePath(repoRoot), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }

  async getStatus(repoRoot: string): Promise<KnowledgeStatus> {
    const currentPath = this.currentDir(repoRoot);
    const manifestPath = this.manifestPath(currentPath);
    if (!(await fileExists(manifestPath))) {
      return {
        available: false,
        valid: false,
        currentPath: null,
        version: null,
        missingArtifacts: [...REQUIRED_KNOWLEDGE_ARTIFACTS],
        invalidArtifacts: [],
        warnings: ["Knowledgebase snapshot is missing."],
      };
    }

    const snapshot = await this.loadCurrent(repoRoot);
    if (!snapshot) {
      return {
        available: false,
        valid: false,
        currentPath,
        version: null,
        missingArtifacts: [...REQUIRED_KNOWLEDGE_ARTIFACTS],
        invalidArtifacts: [],
        warnings: ["Knowledgebase snapshot manifest exists but could not be parsed."],
      };
    }

    const kinds = new Set(snapshot.artifacts.map((artifact) => artifact.kind));
    const missingArtifacts = REQUIRED_KNOWLEDGE_ARTIFACTS.filter((kind) => !kinds.has(kind));
    const invalidArtifacts = snapshot.validation.errors
      .map((error) => REQUIRED_KNOWLEDGE_ARTIFACTS.find((kind) => error.includes(kind)))
      .filter((kind): kind is (typeof REQUIRED_KNOWLEDGE_ARTIFACTS)[number] => Boolean(kind));
    return {
      available: true,
      valid: snapshot.validation.valid && missingArtifacts.length === 0,
      currentPath,
      version: snapshot.version,
      missingArtifacts,
      invalidArtifacts,
      warnings: snapshot.validation.warnings,
    };
  }

  async getFreshness(repoRoot: string, config: KnowledgePipelineConfig): Promise<KnowledgeFreshnessStatus> {
    const status = await this.getStatus(repoRoot);
    const refreshState = await this.readRefreshState(repoRoot);
    let currentCommit: string | null = null;
    try {
      currentCommit = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    } catch {
      currentCommit = null;
    }

    if (!status.available) {
      return {
        state: "missing",
        refreshRequired: true,
        reasonCodes: ["knowledge_missing"],
        lastRefreshCommit: refreshState.lastRefreshCommit,
        currentCommit,
        approvedEpicsSinceRefresh: refreshState.approvedEpicsSinceKnowledgeRefresh,
        warnings: ["Knowledgebase is missing; decoder will fall back conservatively."],
      };
    }

    if (!status.valid) {
      return {
        state: "critical_stale",
        refreshRequired: true,
        reasonCodes: ["knowledge_invalid"],
        lastRefreshCommit: refreshState.lastRefreshCommit,
        currentCommit,
        approvedEpicsSinceRefresh: refreshState.approvedEpicsSinceKnowledgeRefresh,
        warnings: [...status.warnings, "Knowledgebase exists but failed validation."],
      };
    }

    const reasonCodes: string[] = [];
    const warnings: string[] = [];
    let state: KnowledgeFreshnessStatus["state"] = "fresh";
    if (refreshState.approvedEpicsSinceKnowledgeRefresh >= config.approvedEpicRefreshInterval) {
      state = "stale";
      reasonCodes.push("approved_epic_interval");
      warnings.push("Knowledge refresh interval has been reached.");
    }
    if (refreshState.lastRefreshCommit && currentCommit && refreshState.lastRefreshCommit !== currentCommit) {
      state = state === "fresh" ? "stale" : state;
      reasonCodes.push("repo_commit_changed");
    }
    if (refreshState.plannerFailureCount >= config.refreshOnPlannerFailureThreshold) {
      state = "stale";
      reasonCodes.push("planner_quality_degradation");
      warnings.push("Planner failure threshold exceeded.");
    }
    if (refreshState.unknownDomainCount > 0 && config.refreshOnUnknownDomain) {
      state = "stale";
      reasonCodes.push("unknown_domain_detected");
    }

    return {
      state,
      refreshRequired: state !== "fresh",
      reasonCodes,
      lastRefreshCommit: refreshState.lastRefreshCommit,
      currentCommit,
      approvedEpicsSinceRefresh: refreshState.approvedEpicsSinceKnowledgeRefresh,
      warnings,
    };
  }

  async loadCurrent(repoRoot: string): Promise<KnowledgebaseSnapshot | null> {
    try {
      const manifestRaw = await readFile(this.manifestPath(this.currentDir(repoRoot)), "utf8");
      return JSON.parse(manifestRaw) as KnowledgebaseSnapshot;
    } catch {
      return null;
    }
  }

  async appendEpicMemory(repoRoot: string, memory: LocalEpicMemory): Promise<void> {
    await this.ensureRepoDirs(repoRoot);
    const filePath = this.localMemoryPath(repoRoot);
    const existing = await readFile(filePath, "utf8").catch(() => "");
    const line = `${JSON.stringify(memory)}\n`;
    await writeFile(filePath, `${existing}${line}`, "utf8");
  }

  async readEpicMemory(repoRoot: string, limit = 25): Promise<LocalEpicMemory[]> {
    try {
      const raw = await readFile(this.localMemoryPath(repoRoot), "utf8");
      return raw
        .split(/\r?\n/u)
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line) as LocalEpicMemory);
    } catch {
      return [];
    }
  }

  async stageRefresh(repoRoot: string, refreshId: string, output: RemoteKnowledgeRefreshOutput): Promise<StagedKnowledgebase> {
    await this.ensureRepoDirs(repoRoot);
    const stagedPath = this.stagedDir(repoRoot, refreshId);
    await rm(stagedPath, { recursive: true, force: true });
    await mkdir(path.join(stagedPath, "artifacts"), { recursive: true });
    let commitHash = "";
    try {
      commitHash = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    } catch {
      commitHash = "unknown";
    }

    const snapshot: KnowledgebaseSnapshot = {
      version: refreshId,
      repoRoot,
      commitHash,
      createdAt: nowIso(),
      artifacts: output.artifacts.map((artifact) => ({
        ...artifact,
        tokenEstimate: artifact.tokenEstimate || estimateTokens(artifact.content),
        version: refreshId,
        updatedAt: artifact.updatedAt || nowIso(),
      })),
      metadata: {
        confidenceScore: output.confidenceScore,
        generatedByModel: "remote-refresh",
        refreshReason: output.summaryOfChanges,
        domainsUpdated: output.domainsRefreshed,
        approvedEpicsSinceRefresh: 0,
        status: "running",
      },
      validation: { valid: false, errors: [], warnings: [], validatedAt: nowIso() },
    };

    for (const artifact of snapshot.artifacts) {
      await writeFile(this.artifactPath(stagedPath, artifact), artifact.content, "utf8");
    }
    await writeFile(this.manifestPath(stagedPath), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

    return {
      repoRoot,
      repoHash: this.repoHash(repoRoot),
      refreshId,
      stagedPath,
      manifestPath: this.manifestPath(stagedPath),
      validationPath: this.validationPath(stagedPath),
      snapshot,
    };
  }

  async validateStaged(staged: StagedKnowledgebase, config: KnowledgePipelineConfig): Promise<KnowledgeValidationReport> {
    const report = validateKnowledgeArtifacts(staged.snapshot.artifacts, config);
    staged.snapshot.validation = report;
    await writeFile(staged.manifestPath, `${JSON.stringify(staged.snapshot, null, 2)}\n`, "utf8");
    await writeFile(staged.validationPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }

  async promoteStaged(staged: StagedKnowledgebase, config: KnowledgePipelineConfig): Promise<void> {
    const repoRoot = staged.repoRoot;
    await this.ensureRepoDirs(repoRoot);
    const current = this.currentDir(repoRoot);
    const historyBase = this.historyDir(repoRoot);
    const snapshot = staged.snapshot;
    if (await dirExists(current)) {
      const previous = await this.loadCurrent(repoRoot);
      const previousVersion = previous?.version || `snapshot-${Date.now()}`;
      await mkdir(historyBase, { recursive: true });
      await rm(path.join(historyBase, previousVersion), { recursive: true, force: true });
      await rename(current, path.join(historyBase, previousVersion));
    }
    await cp(staged.stagedPath, current, { recursive: true });
    await this.markRefreshState(repoRoot, {
      approvedEpicsSinceKnowledgeRefresh: 0,
      lastRefreshAt: snapshot.createdAt,
      lastRefreshCommit: snapshot.commitHash,
      lastRefreshReason: snapshot.metadata.refreshReason,
      refreshStatus: "completed",
      lastFailureReason: null,
      plannerFailureCount: 0,
      unknownDomainCount: 0,
    });
    await this.pruneHistory(repoRoot, config.keepKnowledgeHistoryCount);
  }

  async pruneHistory(repoRoot: string, keepCount: number): Promise<void> {
    const historyDir = this.historyDir(repoRoot);
    try {
      const entries = await (await import("node:fs/promises")).readdir(historyDir, { withFileTypes: true });
      const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      const toDelete = dirs.slice(0, Math.max(0, dirs.length - keepCount));
      for (const name of toDelete) {
        await rm(path.join(historyDir, name), { recursive: true, force: true });
      }
    } catch {
      // no-op
    }
  }

  async recordPlannerFailure(repoRoot: string): Promise<void> {
    const state = await this.readRefreshState(repoRoot);
    await this.markRefreshState(repoRoot, { plannerFailureCount: state.plannerFailureCount + 1 });
  }

  async recordUnknownDomain(repoRoot: string): Promise<void> {
    const state = await this.readRefreshState(repoRoot);
    await this.markRefreshState(repoRoot, { unknownDomainCount: state.unknownDomainCount + 1 });
  }
}
