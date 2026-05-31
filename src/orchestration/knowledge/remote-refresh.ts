import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { loadConfig } from "../../config.ts";
import type { KnowledgePipelineConfig } from "../../config.ts";
import type { AppDatabase } from "../../db/database.ts";
import type { AgentStreamPayload, Json } from "../../types.ts";
import { parseJsonText } from "../validation.ts";
import { tryExtractJson } from "../zai.ts";
import { createGateway, type ModelGateway } from "../models.ts";
import { remoteKnowledgeRefreshPrompt } from "../prompts.ts";
import { CodexRunner } from "../codex.ts";
import { QwenRunner } from "../qwen.ts";
import { GeminiRunner } from "../gemini.ts";
import { ZaiRunner } from "../zai.ts";
import type {
  KnowledgeArtifact,
  KnowledgeArtifactKind,
  RemoteKnowledgeRefreshOutput,
} from "./types.ts";
import { nowIso, truncate, randomId } from "../../utils.ts";
import { KnowledgebaseService } from "./knowledgebase.ts";
import { estimateTokens } from "./validation.ts";
import { git } from "../../bridge/git.ts";

const VALID_ARTIFACT_KINDS: KnowledgeArtifactKind[] = [
  "repo_capsule",
  "domain_map",
  "architecture_rules",
  "api_contract_notes",
  "ticket_decomposition_patterns",
  "known_failure_modes",
  "testing_guidance",
  "local_model_instructions",
  "recent_change_history",
  "staleness_report",
  "refresh_metadata",
];

type RemoteRefreshArtifactDraft = {
  kind: string;
  title: string;
  domains?: string[];
  content: string;
};

type RemoteRefreshPayload = {
  summaryOfChanges: string;
  domainsRefreshed: string[];
  importantArchitectureRules: string[];
  updatedTicketPatterns: string[];
  knownFailureModes: string[];
  stalenessStatus: "fresh" | "stale" | "critical_stale" | "missing";
  warnings?: string[];
  confidenceScore: number;
  artifacts: RemoteRefreshArtifactDraft[];
};

async function safeReadFile(filePath: string, maxChars = 18_000): Promise<string | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return truncate(content, maxChars);
  } catch {
    return null;
  }
}

async function listTopLevel(repoRoot: string): Promise<string> {
  try {
    const entries = await readdir(repoRoot, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith(".git"))
      .slice(0, 80)
      .map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`)
      .join("\n");
  } catch {
    return "";
  }
}

function isArtifactKind(value: string): value is KnowledgeArtifactKind {
  return (VALID_ARTIFACT_KINDS as string[]).includes(value);
}

function normalizeArtifactDrafts(drafts: RemoteRefreshArtifactDraft[], version: string): KnowledgeArtifact[] {
  return drafts
    .filter((draft): draft is RemoteRefreshArtifactDraft & { kind: KnowledgeArtifactKind } =>
      isArtifactKind(draft.kind) && typeof draft.title === "string" && typeof draft.content === "string")
    .map((draft) => ({
      kind: draft.kind,
      title: draft.title.trim() || draft.kind,
      content: draft.content.trim(),
      domains: Array.isArray(draft.domains) ? draft.domains.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
      updatedAt: nowIso(),
      source: "remote-refresh",
      tokenEstimate: estimateTokens(draft.content),
      version,
    }))
    .filter((artifact) => artifact.content.length > 0);
}

function validateRemoteRefreshPayload(value: unknown): RemoteRefreshPayload {
  if (!value || typeof value !== "object") throw new Error("Remote refresh payload is not an object.");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.artifacts)) {
    throw new Error("Remote refresh payload shape invalid: missing or non-array 'artifacts'.");
  }
  return {
    summaryOfChanges: typeof record.summaryOfChanges === "string" ? record.summaryOfChanges : "Knowledge refresh completed.",
    domainsRefreshed: Array.isArray(record.domainsRefreshed) ? record.domainsRefreshed : [],
    importantArchitectureRules: Array.isArray(record.importantArchitectureRules) ? record.importantArchitectureRules : [],
    updatedTicketPatterns: Array.isArray(record.updatedTicketPatterns) ? record.updatedTicketPatterns : [],
    knownFailureModes: Array.isArray(record.knownFailureModes) ? record.knownFailureModes : [],
    stalenessStatus: (typeof record.stalenessStatus === "string" ? record.stalenessStatus : "fresh") as RemoteRefreshPayload["stalenessStatus"],
    confidenceScore: typeof record.confidenceScore === "number" ? record.confidenceScore : 0.7,
    warnings: Array.isArray(record.warnings) ? record.warnings : [],
    artifacts: record.artifacts,
  };
}

export class KnowledgeRefreshService {
  private readonly db: AppDatabase;
  private readonly gateway: ModelGateway;
  private readonly knowledgebase: KnowledgebaseService;
  private readonly codex = new CodexRunner();
  private readonly qwen = new QwenRunner();
  private readonly gemini = new GeminiRunner();
  private readonly zai = new ZaiRunner();
  private readonly onStream?: (event: AgentStreamPayload) => void;

  constructor(
    db: AppDatabase,
    gateway: ModelGateway = createGateway(),
    knowledgebase = new KnowledgebaseService(),
    onStream?: (event: AgentStreamPayload) => void,
  ) {
    this.db = db;
    this.gateway = gateway;
    this.knowledgebase = knowledgebase;
    this.onStream = onStream;
  }

  private emit(
    streamKind: AgentStreamPayload["streamKind"],
    content: string,
    meta: { epicId?: string | null; runId?: string | null; metadata?: Record<string, Json> } = {},
  ): void {
    this.onStream?.({
      agentRole: "system",
      source: "orchestrator",
      streamKind,
      content,
      epicId: meta.epicId ?? null,
      runId: meta.runId ?? null,
      metadata: meta.metadata,
    });
  }

  private buildRemoteGateway(config: KnowledgePipelineConfig): ModelGateway {
    const baseModels = loadConfig().models;
    return createGateway({
      ...baseModels,
      epicDecoder: config.remoteKnowledgeModel,
    });
  }

  private async invokeRefreshModel(repoRoot: string, prompt: string, config: KnowledgePipelineConfig): Promise<string> {
    const model = config.remoteKnowledgeModel;
    const refreshStreamHook = (event: AgentStreamPayload) => {
      this.onStream?.({
        ...event,
        epicId: event.epicId ?? repoRoot,
        metadata: {
          ...(event.metadata ?? {}),
          knowledgeRefresh: true,
          remoteKnowledgeModel: model,
        },
      });
    };
    const streamMeta = { epicId: repoRoot, metadata: { knowledgeRefresh: true, remoteKnowledgeModel: model } };
    if (model === "codex-cli") {
      const result = await this.codex.runBuilder({
        role: "builder",
        cwd: repoRoot,
        prompt,
        epicId: repoRoot,
        modelOverride: "gpt-5.4",
        onStream: refreshStreamHook,
      });
      return result.rawOutput;
    }
    if (model === "qwen-cli") {
      const result = await this.qwen.runBuilder({ role: "builder", cwd: repoRoot, prompt, epicId: repoRoot, onStream: refreshStreamHook });
      return result.rawOutput;
    }
    if (model === "gemini-cli") {
      const result = await this.gemini.runBuilder({ role: "builder", cwd: repoRoot, prompt, epicId: repoRoot, onStream: refreshStreamHook });
      return result.rawOutput;
    }
    if (model.startsWith("zai:")) {
      const resolvedModel = this.zai.resolveModel(model);
      this.emit("status", `Knowledge refresh invoking ${resolvedModel} via raw prompt (not agent).`, streamMeta);
      return this.zai.rawPrompt("epicDecoder", prompt, resolvedModel, refreshStreamHook, { epicId: repoRoot });
    }

    const remoteGateway = this.buildRemoteGateway(config);
    this.emit("status", `Knowledge refresh invoking ${model} via raw prompt.`, streamMeta);
    return remoteGateway.rawPrompt("epicDecoder", prompt, refreshStreamHook);
  }

  private async collectContextPackets(repoRoot: string): Promise<Array<{ title: string; content: string }>> {
    const packets: Array<{ title: string; content: string }> = [];
    const topLevel = await listTopLevel(repoRoot);
    if (topLevel) {
      packets.push({ title: "Top-Level Layout", content: topLevel });
    }

    const candidates = [
      "package.json",
      "README.md",
      "PROJECT_STRUCTURE.md",
      ".closedloop/PROJECT_STRUCTURE.md",
      "progress.md",
      "DEV-README.md",
      "SEEDED-DATA.md",
      "TEST-ACCOUNT.md",
      "playwright.config.ts",
      "turbo.json",
      "tsconfig.json",
    ];

    for (const relativePath of candidates) {
      const fullPath = path.join(repoRoot, relativePath);
      const content = await safeReadFile(fullPath);
      if (content) {
        packets.push({ title: relativePath, content });
      }
    }

    const domainCandidates = [
      "api/package.json",
      "cashier/web/package.json",
      "dashboard/web/package.json",
      "packages/app/package.json",
      "packages/ui/package.json",
      "tests/cashier.spec.ts",
      "tests/dashboard.spec.ts",
    ];

    for (const relativePath of domainCandidates) {
      const fullPath = path.join(repoRoot, relativePath);
      const content = await safeReadFile(fullPath, 10_000);
      if (content) {
        packets.push({ title: relativePath, content });
      }
    }

    return packets.slice(0, 16);
  }

  async buildRefreshOutput(repoRoot: string, reason: string, config: KnowledgePipelineConfig): Promise<RemoteKnowledgeRefreshOutput> {
    const commitHash = await git(repoRoot, ["rev-parse", "HEAD"]).then((result) => result.stdout.trim()).catch(() => "unknown");
    const localMemory = await this.knowledgebase.readEpicMemory(repoRoot, 10);
    const memoryLines = localMemory.map((entry) => `${entry.createdAt}: ${entry.epicTitle} :: ${entry.summary}`);
    const contextPackets = await this.collectContextPackets(repoRoot);
    const prompt = remoteKnowledgeRefreshPrompt({
      repoRoot,
      commitHash,
      refreshReason: reason,
      localMemory: memoryLines,
      contextPackets,
      maxArtifactSize: config.maxKnowledgeArtifactSize,
    });

    const raw = await this.invokeRefreshModel(repoRoot, prompt, config);
    let parsed: RemoteRefreshPayload;
    try {
      parsed = validateRemoteRefreshPayload(tryExtractJson(raw));
    } catch {
      parsed = validateRemoteRefreshPayload(parseJsonText(raw));
    }
    const version = randomId("knowledge_artifacts");
    const artifacts = normalizeArtifactDrafts(parsed.artifacts, version);

    return {
      artifacts,
      summaryOfChanges: parsed.summaryOfChanges,
      domainsRefreshed: parsed.domainsRefreshed,
      importantArchitectureRules: parsed.importantArchitectureRules,
      updatedTicketPatterns: parsed.updatedTicketPatterns,
      knownFailureModes: parsed.knownFailureModes,
      stalenessStatus: parsed.stalenessStatus,
      warnings: parsed.warnings ?? [],
      confidenceScore: parsed.confidenceScore,
    };
  }

  async runJob(payload: { repoRoot: string; reason?: string }, config: KnowledgePipelineConfig): Promise<void> {
    const repoRoot = payload.repoRoot;
    const reason = payload.reason || "manual_refresh";
    const refreshId = randomId("knowledge");
    this.emit("status", `Knowledge refresh started for ${repoRoot} using ${config.remoteKnowledgeModel}.`, {
      epicId: repoRoot,
      metadata: { knowledgeRefresh: true, refreshId, reason, remoteKnowledgeModel: config.remoteKnowledgeModel },
    });
    await this.knowledgebase.markRefreshState(repoRoot, { refreshStatus: "running", lastRefreshReason: reason });

    let originalBranch: string | null = null;
    try {
      originalBranch = await git(repoRoot, ["branch", "--show-current"]).then((r) => r.stdout.trim()).catch(() => "") || null;
      const defaultBranch = await git(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"]).then((r) => r.stdout.trim().replace("refs/remotes/origin/", "")).catch(() => null);

      if (defaultBranch && originalBranch && originalBranch !== defaultBranch) {
        this.emit("status", `Switching ${repoRoot} from ${originalBranch} to ${defaultBranch} for knowledge refresh.`, {
          epicId: repoRoot,
          metadata: { knowledgeRefresh: true, refreshId },
        });
        await git(repoRoot, ["checkout", defaultBranch]);
      } else {
        originalBranch = null;
      }

      const output = await this.buildRefreshOutput(repoRoot, reason, config);
      this.emit("status", `Knowledge refresh generated ${output.artifacts.length} artifact(s); staging snapshot ${refreshId}.`, {
        epicId: repoRoot,
        metadata: { knowledgeRefresh: true, refreshId, artifactCount: output.artifacts.length },
      });
      const staged = await this.knowledgebase.stageRefresh(repoRoot, refreshId, output);
      const report = await this.knowledgebase.validateStaged(staged, config);
      if (!report.valid) {
        await this.knowledgebase.markRefreshState(repoRoot, {
          refreshStatus: "failed",
          lastFailureReason: report.errors.join("; "),
        });
        throw new Error(`Knowledge refresh validation failed: ${report.errors.join("; ")}`);
      }
      await this.knowledgebase.promoteStaged(staged, config);
      this.emit("status", `Knowledge refresh completed for ${repoRoot}.`, {
        epicId: repoRoot,
        metadata: { knowledgeRefresh: true, refreshId, remoteKnowledgeModel: config.remoteKnowledgeModel },
      });
      this.db.recordEvent({
        aggregateType: "epic",
        aggregateId: repoRoot,
        kind: "knowledge_refresh_completed",
        message: `Knowledge refresh completed for ${repoRoot}.`,
        payload: { repoRoot, reason, refreshId, report, remoteModel: config.remoteKnowledgeModel },
      });
    } catch (error) {
      this.emit("stderr", `Knowledge refresh failed for ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`, {
        epicId: repoRoot,
        metadata: { knowledgeRefresh: true, refreshId, remoteKnowledgeModel: config.remoteKnowledgeModel },
      });
      await this.knowledgebase.markRefreshState(repoRoot, {
        refreshStatus: "failed",
        lastFailureReason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (originalBranch) {
        try {
          await git(repoRoot, ["checkout", originalBranch]);
          this.emit("status", `Restored ${repoRoot} to ${originalBranch}.`, {
            epicId: repoRoot,
            metadata: { knowledgeRefresh: true, refreshId },
          });
        } catch (restoreError) {
          this.emit("stderr", `Failed to restore branch ${originalBranch} for ${repoRoot}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`, {
            epicId: repoRoot,
            metadata: { knowledgeRefresh: true, refreshId },
          });
        }
      }
    }
  }
}
