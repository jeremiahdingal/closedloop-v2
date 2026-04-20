import type {
  AgentStreamPayload,
  FailureDecision,
  HandoffPacket,
  OpenCodeBuilderResult,
  OpenCodeLaunchInfo,
  ReviewerVerdict,
  TicketContextPacket,
  TicketRecord
} from "../types.ts";
import { AppDatabase } from "../db/database.ts";
import { WorkspaceBridge } from "../bridge/workspace-bridge.ts";
import { deterministicDoctor } from "../bridge/doctor.ts";
import { loadConfig } from "../config.ts";
import { randomId, nowIso, sleep } from "../utils.ts";
import { builderPrompt, builderToolingPrompt, doctorPrompt, reviewerPrompt, reviewerToolingPrompt } from "./prompts.ts";
import type { ModelGateway } from "./models.ts";
import { loadLangGraphRuntime, type LangGraphRuntime } from "./langgraph-loader.ts";
import { OpenCodeLaunchError, formatOpenCodeFailure } from "./opencode.ts";
import { LifecycleService } from "./lifecycle.ts";
import { buildContextForTicket, buildToolingContext } from "../rag/context-builder.ts";
import { git } from "../bridge/git.ts";
import { getAvailableToolsList } from "../mediated-agent-harness/tools.ts";
import { explorerPrompt, coderPrompt } from "./prompts.ts";
import { buildCanonicalEditPacket } from "./edit-packet.ts";
import { verifyAndApplyEdits } from "./verifier.ts";
import { resetExploreModeFiles } from "../mediated-agent-harness/tools.ts";

import { loadReviewContract, runReviewGuard, type ReviewerMode, type ReviewContractLoadResult } from "./review-guard.ts";
import { ensureProjectStructureFile } from "./project-structure.ts";
import { createHash } from "node:crypto";

type TicketLoopResult = {
  runId: string;
  workspaceId: string;
  status: "approved" | "failed" | "escalated";
  lastDiff: string;
  reviewVerdict: ReviewerVerdict | null;
  testSummary: string | null;
};

type TicketGraphState = {
  runId: string;
  epicId: string;
  ticketId: string;
  workspaceId: string;
  buildAttempts: number;
  maxBuildAttempts: number;
  intendedFiles: string[];
  blockHistory: string[];
  testHistory: string[];
  reviewApproved: boolean;
  reviewBlockers: string[];
  reviewSuggestions: string[];
  testPassed: boolean;
  testSummary: string;
  lastDiff: string;
  lastMessage: string;
  failureDecision: FailureDecision["decision"];
  failureReason: string;
  noDiff: boolean;
  explorerOutput: any;
  canonicalEditPacket: any;
  coderOutput: any;
  verificationResult: any;
  repeatedBlockers: boolean;
  repeatedTestFailure: boolean;
  status: "pending" | "building" | "reviewing" | "testing" | "approved" | "escalated" | "failed";
};

export class TicketRunner {
  readonly config = loadConfig();
  private readonly heartbeatIntervalMs = 15_000;
  private readonly builderPlanTimeoutMs = Number(process.env.BUILDER_PLAN_TIMEOUT_MS || 180_000);
  private readonly reviewerTimeoutMs = Number(process.env.REVIEWER_TIMEOUT_MS || 420_000);
  private readonly compareBaseRef = this.normalizeCompareRef(process.env.PR_COMPARE_BASE || "origin/main");
  private readonly db: AppDatabase;
  private readonly bridge: WorkspaceBridge;
  private readonly gateway: ModelGateway;
  private readonly lifecycle: LifecycleService;

  constructor(db: AppDatabase, bridge: WorkspaceBridge, gateway: ModelGateway, lifecycle: LifecycleService) {
    this.db = db;
    this.bridge = bridge;
    this.gateway = gateway;
    this.lifecycle = lifecycle;
  }

  private shouldSkipTester(): boolean {
    const raw = (this.gateway.models.tester || "").trim().toLowerCase();
    return raw === "skip" || raw === "disabled" || raw === "off";
  }

  async start(ticketId: string, epicId: string): Promise<string> {
    const runId = randomId("run");
    this.db.createRun({
      id: runId,
      kind: "ticket",
      epicId,
      ticketId,
      status: "queued",
      currentNode: "queued",
      attempt: 0,
      heartbeatAt: null,
      lastMessage: "Queued ticket run.",
      errorText: null
    });
    this.db.updateTicketRunState({
      ticketId,
      status: "queued",
      currentRunId: runId,
      currentNode: "queued",
      lastHeartbeatAt: null,
      lastMessage: "Queued for execution."
    });
    this.db.enqueueJob("run_ticket", { ticketId, epicId, runId });
    this.db.recordEvent({
      aggregateType: "ticket",
      aggregateId: ticketId,
      runId,
      ticketId,
      kind: "ticket_queued",
      message: "Ticket run queued."
    });
    return runId;
  }

  async runExisting(runId: string): Promise<TicketLoopResult> {
    if (!this.config.useLangGraph) return this.runExistingLegacy(runId);
    const runtime = await loadLangGraphRuntime();
    if (!runtime) return this.runExistingLegacy(runId);
    return this.runExistingWithLangGraph(runId, runtime);
  }

  private async runExistingWithLangGraph(runId: string, runtime: LangGraphRuntime): Promise<TicketLoopResult> {
    const run = this.db.getRun(runId);
    if (!run || !run.ticketId || !run.epicId) throw new Error(`Ticket run not found: ${runId}`);
    const ticket = this.db.getTicket(run.ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${run.ticketId}`);
    this.assertNotCancelled(ticket.id, ticket.epicId);

    this.recordAgentStream({ agentRole: "system", source: "orchestrator", streamKind: "status", content: `Starting LangGraph ticket: ${ticket.title}`, runId, ticketId: ticket.id, epicId: ticket.epicId, sequence: 0 });

    const { StateGraph, StateSchema, START, END, MemorySaver, z } = runtime;
    const TicketState = new StateSchema({
      runId: z.string(),
      epicId: z.string(),
      ticketId: z.string(),
      workspaceId: z.string().default(""),
      buildAttempts: z.number().default(0),
      maxBuildAttempts: z.number().default(this.resolveMaxBuildAttempts(ticket)),
      intendedFiles: z.array(z.string()).default([]),
      blockHistory: z.array(z.string()).default([]),
      testHistory: z.array(z.string()).default([]),
      reviewApproved: z.boolean().default(false),
      reviewBlockers: z.array(z.string()).default([]),
      reviewSuggestions: z.array(z.string()).default([]),
      testPassed: z.boolean().default(false),
      testSummary: z.string().default(""),
      lastDiff: z.string().default(""),
      lastMessage: z.string().default(""),
      failureDecision: z.enum(["retry_same_node", "blocked", "todo", "escalate"]).default("escalate"),
      failureReason: z.string().default(""),
      noDiff: z.boolean().default(false),
      explorerOutput: z.any().default(null),
      canonicalEditPacket: z.any().default(null),
      coderOutput: z.any().default(null),
      verificationResult: z.any().default(null),
      repeatedBlockers: z.boolean().default(false),
      repeatedTestFailure: z.boolean().default(false),
      status: z.enum(["pending", "building", "reviewing", "testing", "approved", "escalated", "failed"]).default("pending")
    });

    const prepareContext = async (_state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      this.db.updateRun({ runId, status: "running", currentNode: "prepare_context", heartbeatAt: nowIso(), lastMessage: "Preparing workspace." });
      this.db.updateTicketRunState({ ticketId: ticket.id, status: "building", currentRunId: runId, currentNode: "prepare_context", lastHeartbeatAt: nowIso(), lastMessage: "Preparing workspace." });
      const epic = this.db.getEpic(ticket.epicId);
      const baseRef = epic?.targetBranch ?? undefined;
      const useTargetBranch = !!epic?.targetBranch;
      const workspace = await this.bridge.createWorkspace({ ticketId: ticket.id, runId, owner: runId, targetDir: epic?.targetDir || this.config.repoRoot, baseRef, useTargetBranch });
      await this.bridge.acquireWorkspaceLease(workspace.id, runId);
      const packet: TicketContextPacket = {
        epicId: ticket.epicId,
        ticketId: ticket.id,
        runId,
        title: ticket.title,
        description: ticket.description,
        acceptanceCriteria: ticket.acceptanceCriteria,
        dependencies: ticket.dependencies,
        allowedPaths: ticket.allowedPaths,
        reviewBlockers: [],
        priorTestFailures: [],
        modelAssignments: this.gateway.models,
        workspaceId: workspace.id,
        workspacePath: workspace.worktreePath,
        branchName: workspace.branchName,
        attempt: 0
      };
      await this.bridge.saveContextPacket(packet);
      return {
        workspaceId: workspace.id,
        buildAttempts: 0,
        maxBuildAttempts: this.resolveMaxBuildAttempts(ticket),
        lastMessage: "Workspace prepared.",
        status: "building"
      } satisfies Partial<TicketGraphState>;
    };

    const explorerNode = async (state: TicketGraphState) => {
      try {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      const workspace = this.bridge.requireWorkspace(state.workspaceId);
      this.db.updateRun({ runId, status: "running", currentNode: "explorer", heartbeatAt: nowIso(), lastMessage: "Exploring workspace..." });
      this.heartbeat(runId, ticket.id, "explorer", "Exploring workspace...");
      resetExploreModeFiles();

      // Seed: discover related files via keyword glob
      const seedFiles: string[] = [];
      try {
        const { execSync } = require('child_process');
        const ticketText = `${ticket.description} ${ticket.title} ${(ticket.acceptanceCriteria ?? []).join(' ')}`.toLowerCase();
        const kwMatches = [...ticketText.matchAll(/\b([a-z]{4,}(?:s|items|orders|reports|categories|service|route|model|schema|type|query|hook|util)?)\b/g)].map((m: RegExpMatchArray) => m[1]).filter((k: string) => k.length >= 4);
        const uniqueKw = [...new Set(kwMatches)].slice(0, 8);
        for (const kw of uniqueKw) {
          try {
            const out = execSync(
              `powershell -Command "Get-ChildItem -Recurse -Include *.ts,*.tsx -Path '${workspace.worktreePath}' | Where-Object { \$_.FullName.ToLower().Contains('${kw}') } | Select-Object -First 10 -ExpandProperty FullName"`,
              { encoding: 'utf8', timeout: 10000 }
            ).trim();
            if (out) {
              out.split('\n').filter(Boolean).forEach((f: string) => {
                const rel = f.replace(workspace.worktreePath, '').replace(/^[\\/]/, '');
                if (rel && !seedFiles.includes(rel)) seedFiles.push(rel);
              });
            }
          } catch { /* glob failed for this keyword */ }
        }
      } catch { /* seeding failed entirely */ }
      if (seedFiles.length > 0) {
        this.heartbeat(runId, ticket.id, "explorer", `Seeded ${seedFiles.length} related files: ${seedFiles.slice(0, 5).join(', ')}`);
      }

      const explorerRaw = await this.gateway.runExplorerInWorkspace!({
        cwd: workspace.worktreePath,
        prompt: explorerPrompt(ticket, {} as any, seedFiles),
        runId, ticketId: ticket.id, epicId: ticket.epicId,
        onStream: (evt: any) => {
          evt.runId = runId;
          evt.ticketId = ticket.id;
          evt.epicId = ticket.epicId;
          this.recordAgentStream(evt);
        }
      });

      let explorerOutput;
      try {
        explorerOutput = JSON.parse(explorerRaw);
      } catch {
        this.heartbeat(runId, ticket.id, "system", "Explorer output was not valid JSON. Retrying...");
        return { status: "building" as const, lastMessage: "Explorer output invalid, retrying..." };
      }
      this.heartbeat(runId, ticket.id, "explorer", "Explorer complete.");
      return {
        explorerOutput,
        status: "building" as const,
        lastMessage: "Explorer finished. Building edit packet...",
      } satisfies Partial<TicketGraphState>;
      } catch (explorerErr: any) {
        console.error('[EXPLORER ERROR]', explorerErr.message);
        this.heartbeat(runId, ticket.id, "system", `Explorer failed: ${explorerErr.message}. Skipping to builder.`);
        return {
          status: "building" as const,
          lastMessage: `Explorer failed: ${explorerErr.message}`,
          explorerOutput: null,
        } satisfies Partial<TicketGraphState>;
      }
    };

    const buildPacketNode = async (state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      if (!state.explorerOutput) {
        return { status: "building" as const, noDiff: true, lastMessage: "Explorer skipped." } satisfies Partial<TicketGraphState>;
      }
      const workspace = this.bridge.requireWorkspace(state.workspaceId);
      this.heartbeat(runId, ticket.id, "system", "Building canonical edit packet...");

      const canonicalEditPacket = await buildCanonicalEditPacket(
        ticket,
        state.explorerOutput,
        workspace.worktreePath
      );

      return {
        canonicalEditPacket,
        lastMessage: "Edit packet built. Running coder...",
      } satisfies Partial<TicketGraphState>;
    };

    const coderNode = async (state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      if (!state.explorerOutput || !state.canonicalEditPacket) {
        return { status: "building" as const, noDiff: true, lastMessage: "Coder skipped." } satisfies Partial<TicketGraphState>;
      }
      const workspace = this.bridge.requireWorkspace(state.workspaceId);
      this.db.updateRun({ runId, status: "running", currentNode: "coder", heartbeatAt: nowIso(), lastMessage: "Coder generating edits..." });
      this.heartbeat(runId, ticket.id, "coder", "Coder generating edits...");

      const coderRaw = await this.gateway.runCoderDirect!({
        prompt: coderPrompt(ticket, state.explorerOutput, state.canonicalEditPacket),
        runId, ticketId: ticket.id, epicId: ticket.epicId,
        onStream: (evt: any) => {
          evt.runId = runId;
          evt.ticketId = ticket.id;
          evt.epicId = ticket.epicId;
          this.recordAgentStream(evt);
        }
      });

      let coderOutput;
      try {
        coderOutput = JSON.parse(coderRaw);
      } catch {
        this.heartbeat(runId, ticket.id, "system", "Coder output was not valid JSON. Escalating.");
        return { status: "building" as const, lastMessage: "Coder output invalid." };
      }

      return {
        coderOutput,
        lastMessage: "Coder complete. Verifying...",
      } satisfies Partial<TicketGraphState>;
    };

    const verifyNode = async (state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      if (!state.coderOutput || !state.canonicalEditPacket) {
        return { status: "building" as const, noDiff: true, lastMessage: "Verify skipped." } satisfies Partial<TicketGraphState>;
      }
      const workspace = this.bridge.requireWorkspace(state.workspaceId);
      this.heartbeat(runId, ticket.id, "coder", "Verifying and applying edits...");

      const verificationResult = await verifyAndApplyEdits(
        ticket,
        state.coderOutput,
        state.canonicalEditPacket,
        workspace.worktreePath
      );

      this.heartbeat(runId, ticket.id, "coder", `Verification ${verificationResult.outcome}: ${verificationResult.summary}`);

      if (verificationResult.outcome === "accepted") {
        await this.bridge.gitCommit({ workspaceId: workspace.id, message: `[${ticket.id}] ${ticket.title}` });
        const diffResult = await this.bridge.gitDiff(workspace.id);
        return {
          verificationResult,
          lastDiff: diffResult,
          noDiff: !diffResult.trim(),
          lastMessage: verificationResult.summary,
          status: "reviewing" as const,
        } satisfies Partial<TicketGraphState>;
      } else {
        return {
          verificationResult,
          noDiff: true,
          lastMessage: `Verification ${verificationResult.outcome}: ${verificationResult.summary}`,
          status: "building" as const,
        } satisfies Partial<TicketGraphState>;
      }
    };

        const builderNode = async (state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      const workspace = this.bridge.requireWorkspace(state.workspaceId);
      const buildAttempts = state.buildAttempts + 1;
      console.log(`[TICKET ${ticket.id}] Builder attempt ${buildAttempts} starting`);
      this.heartbeat(runId, ticket.id, "builder_plan", `Builder attempt ${buildAttempts}.`);
      // Build RAG context if available
      let retrievedContext = null;
      try {
        const commitResult = await git(workspace.worktreePath, ["rev-parse", "HEAD"]);
        const commitHash = commitResult.stdout.trim();
        const builderModel = this.gateway.models.builder.startsWith("mediated:")
          ? this.gateway.models.builder.slice("mediated:".length)
          : this.gateway.models.builder;

        const ragResult = await buildContextForTicket({
          ticket,
          packet: {} as TicketContextPacket, // temp packet, only need ticket and options
          db: this.db,
          repoRoot: workspace.worktreePath,
          commitHash,
          model: builderModel,
        });

        // Pre-fetch tool guidance
        const toolContext = await buildToolingContext({
          role: "builder",
          availableTools: getAvailableToolsList("builder"),
          db: this.db,
          indexId: this.db.getRagIndexByCommit(commitHash)?.id ?? 0,
          model: builderModel,
        });

        const projectStructure = await ensureProjectStructureFile(workspace.worktreePath);

        retrievedContext = {
          codeContext: ragResult.codeContext,
          docContext: ragResult.docContext,
          toolContext,
          projectStructure,
          retrievalMode: ragResult.retrievalMode,
          chunkCount: ragResult.chunkCount,
        };
      } catch (err) {
        console.warn(`[RAG] Context build failed for ticket ${ticket.id}: ${err}. Continuing without context.`);
      }

      const packet: TicketContextPacket = {
        epicId: ticket.epicId,
        ticketId: ticket.id,
        runId,
        title: ticket.title,
        description: ticket.description,
        acceptanceCriteria: ticket.acceptanceCriteria,
        dependencies: ticket.dependencies,
        allowedPaths: ticket.allowedPaths,
        reviewBlockers: state.reviewBlockers,
        priorTestFailures: state.testSummary ? [state.testSummary.slice(0, 500)] : [],
        modelAssignments: this.gateway.models,
        workspaceId: workspace.id,
        workspacePath: workspace.worktreePath,
        branchName: workspace.branchName,
        attempt: buildAttempts,
        retrievedContext
      };
      await this.bridge.saveContextPacket(packet);
      const builderResult = await this.withHeartbeat(runId, ticket.id, "builder_plan", `Builder attempt ${buildAttempts}.`, () =>
        this.executeBuilder(workspace.id, runId, ticket.id, ticket.allowedPaths, ticket, packet, buildAttempts)
      );

      const diffLines = builderResult.lastDiff.split('\n').length;
      const hasDiff = builderResult.lastDiff.trim().length > 0;
      console.log(`[TICKET ${ticket.id}] Builder attempt ${buildAttempts} complete: ${hasDiff ? `diff (${diffLines} lines)` : 'no diff'}`);
      if (hasDiff) {
        console.log(`[TICKET ${ticket.id}] Changed files: ${builderResult.intendedFiles.join(', ')}`);
      }

      return {
        buildAttempts,
        intendedFiles: builderResult.intendedFiles,
        lastDiff: builderResult.lastDiff,
        noDiff: !builderResult.lastDiff.trim(),
        reviewApproved: false,
        testPassed: false,
        lastMessage: !builderResult.lastDiff.trim() ? "Builder produced no diff." : builderResult.summary,
        status: !builderResult.lastDiff.trim() ? "building" : "reviewing",
        repeatedBlockers: false,
        repeatedTestFailure: false
      } satisfies Partial<TicketGraphState>;
    };

    const reviewerNode = async (state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      console.log(`[TICKET ${ticket.id}] Reviewer starting`);
      this.heartbeat(runId, ticket.id, "reviewer", "Reviewing diff.");
      this.recordAgentStream({ agentRole: "reviewer", source: "orchestrator", streamKind: "status", content: "Reviewing diff...", runId, ticketId: ticket.id, epicId: ticket.epicId, sequence: 0, done: false });
      const reviewVerdict = await this.getReviewerVerdictWithRetry(runId, ticket, state.lastDiff, state.workspaceId);
      console.log(`[TICKET ${ticket.id}] Reviewer verdict: ${reviewVerdict.approved ? 'APPROVED' : 'REJECTED'} - ${reviewVerdict.blockers.join('; ') || 'no blockers'}`);

      if (!reviewVerdict.approved) {
        await this.autoExpandAllowedPathsFromReviewerBlockers(runId, ticket, reviewVerdict.blockers);
      }

      this.recordAgentStream({ agentRole: "reviewer", source: "orchestrator", streamKind: "assistant", content: `Approved: ${reviewVerdict.approved}\nBlockers: ${reviewVerdict.blockers.join(", ") || "none"}\nSuggestions: ${reviewVerdict.suggestions.join(", ") || "none"}`, runId, ticketId: ticket.id, epicId: ticket.epicId, sequence: 1, done: true });
      await this.writeHandoff(state.workspaceId, runId, ticket.id, {
        role: "reviewer",
        state: reviewVerdict.approved ? "approved" : "rejected",
        summary: reviewVerdict.approved ? "Approved." : "Changes require another build.",
        files: state.intendedFiles,
        payload: reviewVerdict as any
      });
      const blockerKey = reviewVerdict.blockers.join("|");
      const blockerHistoryKey = blockerKey ? `block:${blockerKey}` : "";
      const reviewerHistoryKey = `review:${this.reviewerVerdictFingerprint(reviewVerdict, state.lastDiff)}`;
      const repeatedBlockers =
        (Boolean(blockerHistoryKey) && state.blockHistory.includes(blockerHistoryKey))
        || state.blockHistory.includes(reviewerHistoryKey);
      return {
        reviewApproved: reviewVerdict.approved,
        reviewBlockers: reviewVerdict.blockers,
        reviewSuggestions: reviewVerdict.suggestions,
        blockHistory: [
          ...state.blockHistory,
          ...(blockerHistoryKey ? [blockerHistoryKey] : []),
          reviewerHistoryKey
        ],
        repeatedBlockers,
        lastMessage: reviewVerdict.approved ? "Reviewer approved changes." : reviewVerdict.blockers.join("; ") || "Reviewer rejected changes.",
        status: reviewVerdict.approved ? "approved" : "reviewing"
      } satisfies Partial<TicketGraphState>;
    };

    const testerNode = async (state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);

      if (this.shouldSkipTester()) {
        const testSummary = "SKIPPED (score: 0/100)\nTester disabled by configuration.";
        this.heartbeat(runId, ticket.id, "tester", "Tester skipped by config.");
        this.recordAgentStream({
          agentRole: "tester",
          source: "orchestrator",
          streamKind: "status",
          content: "Tester skipped (configured).",
          runId,
          ticketId: ticket.id,
          epicId: ticket.epicId,
          sequence: 0,
          done: false
        });
        this.recordAgentStream({
          agentRole: "tester",
          source: "orchestrator",
          streamKind: "assistant",
          content: testSummary,
          runId,
          ticketId: ticket.id,
          epicId: ticket.epicId,
          sequence: 1,
          done: true
        });
        await this.writeHandoff(state.workspaceId, runId, ticket.id, {
          role: "tester",
          state: "approved",
          summary: "Tests skipped by configuration.",
          files: state.intendedFiles,
          payload: {
            testNecessityScore: 0,
            testNecessityReason: "Tester disabled by model config",
            testsWritten: false,
            testFiles: [],
            testResults: "SKIPPED",
            testsRun: 0
          } as any
        });
        return {
          testPassed: true,
          testSummary,
          testHistory: state.testHistory,
          repeatedTestFailure: false,
          lastMessage: "Tests skipped by configuration.",
          status: "approved"
        } satisfies Partial<TicketGraphState>;
      }
      
      // Use mediated harness for tester if configured
      if (this.gateway.runTesterInWorkspace && this.gateway.models.tester.startsWith("mediated:")) {
        const workspace = this.bridge.requireWorkspace(state.workspaceId);
        this.heartbeat(runId, ticket.id, "tester", "Analyzing test necessity...");
        this.recordAgentStream({
          agentRole: "tester",
          source: "orchestrator",
          streamKind: "status",
          content: "Analyzing test necessity and running tests...",
          runId,
          ticketId: ticket.id,
          epicId: ticket.epicId,
          sequence: 0,
          done: false
        });

        const changedFilesDesc = state.intendedFiles.join("\n");
        const buildDiffDesc = state.lastDiff?.slice(0, 2000) || "No diff available";

        // HARD TIMEOUT: 5 minutes max for tester
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutFallback = new Promise<any>((resolve) => {
          timeoutHandle = setTimeout(() => {
            console.warn(`[TESTER TIMEOUT] Ticket ${ticket.id} - forcing SKIP after timeout`);
            resolve({
              testNecessityScore: 50,
              testNecessityReason: "Timeout - forcing decision",
              testsExisted: false,
              testsWritten: false,
              testFiles: [],
              testResults: "SKIPPED",
              testOutput: "Tester timed out after 5 minutes. Forcing SKIP to avoid stall.",
              testsRun: 0
            });
          }, 300_000);
        });
        const result = await Promise.race([
          this.withHeartbeat(runId, ticket.id, "tester", "Running tests.", () =>
            this.gateway.runTesterInWorkspace!({
              cwd: workspace.worktreePath,
              prompt: `Test the following changes:\n\nChanged files:\n${changedFilesDesc}\n\nBuild diff:\n${buildDiffDesc}`,
              runId,
              ticketId: ticket.id,
              epicId: ticket.epicId,
              onStream: (payload) => this.recordAgentStream(payload)
            })
          ),
          timeoutFallback
        ]);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        // FORCE OUTCOME: If result is invalid or incomplete, default to SKIP
        if (!result || !result.testResults || !result.testNecessityScore) {
          console.warn(`[TESTER FORCE] Ticket ${ticket.id} - invalid result, forcing SKIP`);
          result.testResults = "SKIPPED";
          result.testNecessityScore = 50;
          result.testNecessityReason = "Invalid tester output - forcing SKIP";
          result.testOutput = "Tester produced invalid output. Forcing SKIP to avoid stall.";
        }

        const testSummary = result.testResults === "PASS"
          ? `PASS (score: ${result.testNecessityScore}/100)\n${result.testNecessityReason}\n\nTest output:\n${result.testOutput}`
          : result.testResults === "FAIL"
          ? `FAIL (score: ${result.testNecessityScore}/100)\n${result.testNecessityReason}\n\nTest output:\n${result.testOutput}`
          : `SKIPPED (score: ${result.testNecessityScore}/100)\n${result.testNecessityReason}\n\nReason: ${result.testOutput}`;

        this.recordAgentStream({
          agentRole: "tester",
          source: "orchestrator",
          streamKind: "assistant",
          content: testSummary,
          runId,
          ticketId: ticket.id,
          epicId: ticket.epicId,
          sequence: 1,
          done: true
        });

        await this.writeHandoff(state.workspaceId, runId, ticket.id, {
          role: "tester",
          state: result.testResults === "PASS" || result.testResults === "SKIPPED" ? "approved" : "rejected",
          summary: result.testResults === "PASS" ? "Tests passed." : result.testResults === "SKIPPED" ? "Tests skipped (not needed)." : "Tests failed.",
          files: [...state.intendedFiles, ...result.testFiles],
          payload: {
            testNecessityScore: result.testNecessityScore,
            testNecessityReason: result.testNecessityReason,
            testsWritten: result.testsWritten,
            testFiles: result.testFiles,
            testResults: result.testResults,
            testsRun: result.testsRun
          } as any
        });

        const testPassed = result.testResults === "PASS" || result.testResults === "SKIPPED";
        const repeatedTestFailure = result.testResults === "FAIL" && state.testHistory.includes(result.testOutput);

        return {
          testPassed,
          testSummary,
          testHistory: testPassed ? state.testHistory : [...state.testHistory, result.testOutput],
          repeatedTestFailure,
          lastMessage: result.testResults === "PASS" ? "Tests passed." : result.testResults === "SKIPPED" ? "Tests skipped." : "Tests failed.",
          status: testPassed ? "approved" : "testing"
        } satisfies Partial<TicketGraphState>;
      }
      
      // Fallback: legacy command-based testing
      this.heartbeat(runId, ticket.id, "tester", "Running tests.");
      this.recordAgentStream({ agentRole: "tester", source: "orchestrator", streamKind: "status", content: "Running tests...", runId, ticketId: ticket.id, epicId: ticket.epicId, sequence: 0, done: false });
      const result = await this.withHeartbeat(runId, ticket.id, "tester", "Running tests.", () =>
        this.bridge.runNamedCommand({
          workspaceId: state.workspaceId,
          runId,
          ticketId: ticket.id,
          nodeName: "tester",
          commandName: "test"
        })
      );
      const testSummary = `${result.exitCode === 0 ? "PASS" : "FAIL"}\n${result.stdout}\n${result.stderr}`.trim();
      this.recordAgentStream({ agentRole: "tester", source: "orchestrator", streamKind: "assistant", content: testSummary, runId, ticketId: ticket.id, epicId: ticket.epicId, sequence: 1, done: true });
      await this.writeHandoff(state.workspaceId, runId, ticket.id, {
        role: "tester",
        state: result.exitCode === 0 ? "approved" : "rejected",
        summary: result.exitCode === 0 ? "Tests passed." : "Tests failed.",
        files: state.intendedFiles,
        payload: { exitCode: result.exitCode, durationMs: result.durationMs } as any
      });
      const repeatedTestFailure = result.exitCode !== 0 && state.testHistory.includes(testSummary);
      return {
        testPassed: result.exitCode === 0,
        testSummary,
        testHistory: result.exitCode === 0 ? state.testHistory : [...state.testHistory, testSummary],
        repeatedTestFailure,
        lastMessage: result.exitCode === 0 ? "Tests passed." : "Tests failed.",
        status: result.exitCode === 0 ? "approved" : "testing"
      } satisfies Partial<TicketGraphState>;
    };

    const classifyNode = async (state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      console.log(`[TICKET ${ticket.id}] Classify node: buildAttempts=${state.buildAttempts}, noDiff=${state.noDiff}, repeatedBlockers=${state.repeatedBlockers}`);
      if (state.repeatedBlockers) {
        const reason = "Reviewer produced duplicate/unchanged verdicts across attempts; escalating early to prevent drift.";
        console.log(`[TICKET ${ticket.id}] Classify early escalation: ${reason}`);
        return {
          failureDecision: "escalate",
          failureReason: reason,
          lastMessage: reason,
          status: "escalated"
        } satisfies Partial<TicketGraphState>;
      }
      const failure = await this.getFailureDecision(runId, ticket, state.reviewApproved ? {
        approved: state.reviewApproved,
        blockers: state.reviewBlockers,
        suggestions: state.reviewSuggestions,
        riskLevel: state.reviewApproved ? "low" : "medium"
      } : null, state.testSummary || null, {
        repeatedBlockers: state.repeatedBlockers,
        repeatedTestFailure: state.repeatedTestFailure,
        noDiff: state.noDiff,
        infraFailure: false,
        // currentNode derived from status // status in state matches current role/node
      });
      console.log(`[TICKET ${ticket.id}] Doctor decision: ${failure.decision} - ${failure.reason}`);
      return {
        failureDecision: failure.decision,
        failureReason: failure.reason,
        lastMessage: failure.reason,
        status: ["escalate", "blocked", "todo"].includes(failure.decision) ? "escalated" : "building"
      } satisfies Partial<TicketGraphState>;
    };

    const finalizeSuccess = async (state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      this.db.updateRun({ runId, status: "succeeded", currentNode: "complete", heartbeatAt: nowIso(), lastMessage: "Ticket approved." });
      
      const diffStats = await this.bridge.getDiffStats(state.workspaceId);
      const commitResult = await this.bridge.gitCommit({ workspaceId: state.workspaceId, message: `[${ticket.id}] automated ticket completion` });
      
        const epic = this.db.getEpic(ticket.epicId);
        const useTargetBranch = !!epic?.targetBranch;
        const prBase = epic?.targetBranch ?? this.compareBaseRef.replace("origin/", "");
        
        let prUrl: string | null = null;
        if (!commitResult.startsWith("noop:")) {
          if (this.config.localOnly) {
            console.log(`[${ticket.id}] Local-only mode enabled. Skipping push/PR creation.`);
          } else if (useTargetBranch) {
            await this.bridge.gitPushToBranch({ workspaceId: state.workspaceId, targetBranch: prBase });
            prUrl = null;
          } else {
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
              await this.bridge.gitPush({ workspaceId: state.workspaceId });
              const title = `${ticket.title} (${ticket.id})`;
              const body = `Automated ticket completion.\n\n**Description:** ${ticket.description}\n\n**Acceptance Criteria:**\n${ticket.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`;
              prUrl = await this.bridge.gitCreatePr({
                workspaceId: state.workspaceId,
                title,
                body,
                base: prBase
              });
              break;
            } catch (pushError) {
              const msg = pushError instanceof Error ? pushError.message : String(pushError);
              console.error(`[${ticket.id}] Push/PR creation failed (attempt ${attempt}/2):`, msg);
              if (attempt === 2) {
                console.error(`[${ticket.id}] All push/PR attempts exhausted. Ticket approved but PR not created.`);
              }
            }
          }
        }
      }

      this.db.updateTicketRunState({ 
        ticketId: ticket.id, 
        status: "approved", 
        currentNode: "complete", 
        lastHeartbeatAt: nowIso(), 
        lastMessage: "Ticket approved.",
        diffFiles: diffStats,
        prUrl
      });
      await this.bridge.archiveWorkspace(state.workspaceId);
      return { status: "approved", lastMessage: "Ticket approved." } satisfies Partial<TicketGraphState>;
    };

    const finalizeEscalated = async (state: TicketGraphState) => {
      const reason = state.failureReason || "Escalated by classifier.";
      this.db.updateRun({ runId, status: "escalated", currentNode: "escalated", heartbeatAt: nowIso(), lastMessage: reason, errorText: reason });
      this.db.updateTicketRunState({ ticketId: ticket.id, status: "escalated", currentNode: "escalated", lastHeartbeatAt: nowIso(), lastMessage: reason });
      await this.bridge.saveArtifact({
        runId,
        ticketId: ticket.id,
        kind: "escalation",
        name: `${ticket.id}-escalation.json`,
        content: JSON.stringify({ reason, runId, ticketId: ticket.id }, null, 2)
      });
      await this.bridge.archiveWorkspace(state.workspaceId);
      return { status: "escalated", lastMessage: reason } satisfies Partial<TicketGraphState>;
    };

    const finalizeFailed = async (state: TicketGraphState) => {
      const reason = state.failureReason || "Retry budget exceeded.";
      this.db.updateRun({ runId, status: "failed", currentNode: "complete", heartbeatAt: nowIso(), lastMessage: reason, errorText: reason });
      this.db.updateTicketRunState({ ticketId: ticket.id, status: "failed", currentNode: "complete", lastHeartbeatAt: nowIso(), lastMessage: reason });
      await this.bridge.archiveWorkspace(state.workspaceId);
      return { status: "failed", lastMessage: reason } satisfies Partial<TicketGraphState>;
    };

    const graphBuilder = new StateGraph(TicketState)
      .addNode("prepare_context", prepareContext)
      .addNode("explorer", explorerNode)
      .addNode("build_packet", buildPacketNode)
      .addNode("coder", coderNode)
      .addNode("verify", verifyNode)
      .addNode("reviewer", reviewerNode)
      .addNode("tester", testerNode)
      .addNode("classify", classifyNode)
      .addNode("finalize_success", finalizeSuccess)
      .addNode("finalize_escalated", finalizeEscalated)
      .addNode("finalize_failed", finalizeFailed)
      .addEdge(START, "prepare_context")
      .addEdge("prepare_context", "explorer")
      .addEdge("explorer", "build_packet")
      .addEdge("build_packet", "coder")
      .addEdge("coder", "verify")
      .addConditionalEdges("verify",
        (state: TicketGraphState) => state.noDiff ? "classify" : "reviewer",
        ["classify", "reviewer"]
      )
      .addConditionalEdges("reviewer", (state: TicketGraphState) => state.reviewApproved ? "tester" : "classify", ["tester", "classify"])
      .addConditionalEdges("tester", (state: TicketGraphState) => state.testPassed ? "finalize_success" : "classify", ["finalize_success", "classify"])
      .addConditionalEdges(
        "classify",
        (state: TicketGraphState) => {
          if (["escalate", "blocked", "todo"].includes(state.failureDecision)) return "finalize_escalated";
          return "finalize_failed";
        },
        ["finalize_escalated", "finalize_failed"]
      )
      .addEdge("finalize_success", END)
      .addEdge("finalize_escalated", END)
      .addEdge("finalize_failed", END);

    const graph = graphBuilder.compile(MemorySaver ? { checkpointer: new MemorySaver() } : undefined);

    try {
      const result = await graph.invoke({ runId, epicId: ticket.epicId, ticketId: ticket.id }, {
        configurable: { thread_id: runId }
      }) as TicketGraphState;
      return {
        runId,
        workspaceId: result.workspaceId,
        status: result.status === "approved" ? "approved" : result.status === "escalated" ? "escalated" : "failed",
        lastDiff: result.lastDiff,
        reviewVerdict: result.reviewApproved ? {
          approved: true,
          blockers: result.reviewBlockers,
          suggestions: result.reviewSuggestions,
          riskLevel: "low"
        } : result.reviewBlockers.length ? {
          approved: false,
          blockers: result.reviewBlockers,
          suggestions: result.reviewSuggestions,
          riskLevel: "medium"
        } : null,
        testSummary: result.testSummary || null
      };
    } catch (error) {
      if (error instanceof TicketCancelledError) {
        const workspace = this.db.findWorkspaceByRun(runId);
        if (workspace) await this.bridge.archiveWorkspace(workspace.id);
        return { runId, workspaceId: workspace?.id ?? "", status: "failed", lastDiff: "", reviewVerdict: null, testSummary: error.message };
      }
      if (this.isPushConflictError(error)) {
        const workspace = this.db.findWorkspaceByRun(runId);
        return await this.autoRerunFromFreshHeadOnPushConflict(runId, ticket, workspace?.id ?? "", error);
      }
      this.db.updateRun({ runId, status: "failed", currentNode: "error", heartbeatAt: nowIso(), lastMessage: "Ticket crashed.", errorText: (error as Error).message });
      this.db.updateTicketRunState({ ticketId: ticket.id, status: "failed", currentNode: "error", lastHeartbeatAt: nowIso(), lastMessage: (error as Error).message });
      throw error;
    } finally {
      const workspace = this.db.findWorkspaceByRun(runId);
      if (workspace) this.bridge.releaseLease("workspace", workspace.id);
    }
  }

  private async runExistingLegacy(runId: string): Promise<TicketLoopResult> {
    const run = this.db.getRun(runId);
    if (!run || !run.ticketId) throw new Error(`Ticket run not found: ${runId}`);
    const ticket = this.db.getTicket(run.ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${run.ticketId}`);
    this.assertNotCancelled(ticket.id, ticket.epicId);

    this.db.updateRun({ runId, status: "running", currentNode: "prepare_context", heartbeatAt: nowIso(), lastMessage: "Preparing workspace." });
    this.db.updateTicketRunState({ ticketId: ticket.id, status: "building", currentRunId: runId, currentNode: "prepare_context", lastHeartbeatAt: nowIso(), lastMessage: "Preparing workspace." });

    const epic = this.db.getEpic(ticket.epicId);
    const baseRef = epic?.targetBranch ?? undefined;
    const useTargetBranch = !!epic?.targetBranch;
    const workspace = await this.bridge.createWorkspace({ ticketId: ticket.id, runId, owner: runId, targetDir: epic?.targetDir || this.config.repoRoot, baseRef, useTargetBranch });
    await this.bridge.acquireWorkspaceLease(workspace.id, runId);

    let reviewVerdict: ReviewerVerdict | null = null;
    let testSummary: string | null = null;
    let lastDiff = "";
    let blockHistory: string[] = [];
    let testHistory: string[] = [];
    let buildAttempts = 0;
    const maxBuildAttempts = this.resolveMaxBuildAttempts(ticket);

    const packet: TicketContextPacket = {
      epicId: ticket.epicId,
      ticketId: ticket.id,
      runId,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      dependencies: ticket.dependencies,
      allowedPaths: ticket.allowedPaths,
      reviewBlockers: [],
      priorTestFailures: [],
      modelAssignments: this.gateway.models,
      workspaceId: workspace.id,
      workspacePath: workspace.worktreePath,
      branchName: workspace.branchName,
      attempt: 0
    };
    await this.bridge.saveContextPacket(packet);

    try {
      while (buildAttempts < maxBuildAttempts) {
        this.assertNotCancelled(ticket.id, ticket.epicId);
        buildAttempts += 1;
        packet.attempt = buildAttempts;
        this.heartbeat(runId, ticket.id, "builder_plan", `Builder attempt ${buildAttempts}.`);

        try {
          const commitResult = await git(workspace.worktreePath, ["rev-parse", "HEAD"]);
          const commitHash = commitResult.stdout.trim();
          const builderModel = this.gateway.models.builder.startsWith("mediated:")
            ? this.gateway.models.builder.slice("mediated:".length)
            : this.gateway.models.builder;

          const ragResult = await buildContextForTicket({
            ticket,
            packet: {} as TicketContextPacket,
            db: this.db,
            repoRoot: workspace.worktreePath,
            commitHash,
            model: builderModel,
          });

          const toolContext = await buildToolingContext({
            role: "builder",
            availableTools: getAvailableToolsList("builder"),
            db: this.db,
            indexId: this.db.getRagIndexByCommit(commitHash)?.id ?? 0,
            model: builderModel,
          });

          const projectStructure = await ensureProjectStructureFile(workspace.worktreePath);

          packet.retrievedContext = {
            codeContext: ragResult.codeContext,
            docContext: ragResult.docContext,
            toolContext,
            projectStructure,
            retrievalMode: ragResult.retrievalMode,
            chunkCount: ragResult.chunkCount,
          };
        } catch (err) {
          console.warn(`[RAG] Context build failed for ticket ${ticket.id}: ${err}. Continuing without context.`);
        }

      const builderResult = await this.withHeartbeat(runId, ticket.id, "builder_plan", `Builder attempt ${buildAttempts}.`, () =>
        this.executeBuilder(workspace.id, runId, ticket.id, ticket.allowedPaths, ticket, packet, buildAttempts)
      );
        lastDiff = builderResult.lastDiff;
        if (!lastDiff.trim()) {
          const failure = await this.getFailureDecision(runId, ticket, reviewVerdict, testSummary, {
            repeatedBlockers: false,
            repeatedTestFailure: false,
            noDiff: true,
            infraFailure: false
          });
          if (failure.decision === "escalate") return await this.escalate(runId, workspace.id, ticket.id, "Builder produced no diff.");
          packet.reviewBlockers = [`No diff detected after build attempt ${buildAttempts}.`];
          blockHistory.push(packet.reviewBlockers.join("; "));
          continue;
        }

        this.heartbeat(runId, ticket.id, "reviewer", "Reviewing diff.");
      reviewVerdict = await this.getReviewerVerdictWithRetry(runId, ticket, lastDiff, workspace.id);
        if (!reviewVerdict.approved) {
          await this.autoExpandAllowedPathsFromReviewerBlockers(runId, ticket, reviewVerdict.blockers);
        }
        await this.writeHandoff(workspace.id, runId, ticket.id, {
          role: "reviewer",
          state: reviewVerdict.approved ? "approved" : "rejected",
          summary: reviewVerdict.approved ? "Approved for testing." : "Changes require another build.",
          files: builderResult.intendedFiles,
          payload: reviewVerdict as any
        });

        if (!reviewVerdict.approved) {
          this.assertNotCancelled(ticket.id, ticket.epicId);
          const blockerKey = reviewVerdict.blockers.join("|");
          const blockerHistoryKey = blockerKey.length > 0 ? `block:${blockerKey}` : "";
          const reviewerHistoryKey = `review:${this.reviewerVerdictFingerprint(reviewVerdict, lastDiff)}`;
          const repeatedBlockers =
            (blockerHistoryKey.length > 0 && blockHistory.includes(blockerHistoryKey))
            || blockHistory.includes(reviewerHistoryKey);
          if (blockerHistoryKey.length > 0) blockHistory.push(blockerHistoryKey);
          blockHistory.push(reviewerHistoryKey);
          packet.reviewBlockers = reviewVerdict.blockers;
          if (repeatedBlockers) {
            return await this.escalate(
              runId,
              workspace.id,
              ticket.id,
              "Reviewer produced duplicate/unchanged verdicts across attempts; escalating early to prevent drift."
            );
          }
          const failure = await this.getFailureDecision(runId, ticket, reviewVerdict, testSummary, {
            repeatedBlockers,
            repeatedTestFailure: false,
            noDiff: false,
            infraFailure: false
          });
          if (failure.decision === "escalate") {
            return await this.escalate(runId, workspace.id, ticket.id, failure.reason);
          }
          continue;
        }

        this.heartbeat(runId, ticket.id, "tester", "Running tests.");

        if (this.shouldSkipTester()) {
          testSummary = "SKIPPED (score: 0/100)\nTester disabled by configuration.";
          await this.writeHandoff(workspace.id, runId, ticket.id, {
            role: "tester",
            state: "approved",
            summary: "Tests skipped by configuration.",
            files: builderResult.intendedFiles,
            payload: {
              testNecessityScore: 0,
              testNecessityReason: "Tester disabled by model config",
              testsWritten: false,
              testFiles: [],
              testResults: "SKIPPED",
              testsRun: 0
            } as any
          });
          this.assertNotCancelled(ticket.id, ticket.epicId);
          this.db.updateRun({ runId, status: "succeeded", currentNode: "complete", heartbeatAt: nowIso(), lastMessage: "Ticket approved." });
          const diffStats = await this.bridge.getDiffStats(workspace.id);
          this.db.updateTicketRunState({
            ticketId: ticket.id,
            status: "approved",
            currentNode: "complete",
            lastHeartbeatAt: nowIso(),
            lastMessage: "Ticket approved.",
            diffFiles: diffStats,
            prUrl: null
          });
          await this.bridge.archiveWorkspace(workspace.id);
          return { runId, workspaceId: workspace.id, status: "approved", lastDiff, reviewVerdict, testSummary };
        }
        
        // Use mediated harness for tester if configured
        if (this.gateway.runTesterInWorkspace && this.gateway.models.tester.startsWith("mediated:")) {
          const changedFilesDesc = builderResult.intendedFiles.join("\n");
          const buildDiffDesc = lastDiff.slice(0, 2000) || "No diff available";
          
          const testerResult = await this.withHeartbeat(runId, ticket.id, "tester", "Running tests.", () =>
            this.gateway.runTesterInWorkspace!({
              cwd: workspace.worktreePath,
              prompt: `Test the following changes:\n\nChanged files:\n${changedFilesDesc}\n\nBuild diff:\n${buildDiffDesc}\n\nScore test necessity and write/run tests if needed.`,
              runId,
              ticketId: ticket.id,
              epicId: ticket.epicId,
              onStream: (payload) => this.recordAgentStream(payload)
            })
          );
          
          testSummary = testerResult.testResults === "PASS" 
            ? `PASS (score: ${testerResult.testNecessityScore}/100)\n${testerResult.testNecessityReason}\n\nTest output:\n${testerResult.testOutput}`
            : testerResult.testResults === "FAIL"
            ? `FAIL (score: ${testerResult.testNecessityScore}/100)\n${testerResult.testNecessityReason}\n\nTest output:\n${testerResult.testOutput}`
            : `SKIPPED (score: ${testerResult.testNecessityScore}/100)\n${testerResult.testNecessityReason}\n\nReason: ${testerResult.testOutput}`;
          
          await this.writeHandoff(workspace.id, runId, ticket.id, {
            role: "tester",
            state: testerResult.testResults === "PASS" || testerResult.testResults === "SKIPPED" ? "approved" : "rejected",
            summary: testerResult.testResults === "PASS" ? "Tests passed." : testerResult.testResults === "SKIPPED" ? "Tests skipped (not needed)." : "Tests failed.",
            files: [...builderResult.intendedFiles, ...testerResult.testFiles],
            payload: { 
              testNecessityScore: testerResult.testNecessityScore,
              testNecessityReason: testerResult.testNecessityReason,
              testsWritten: testerResult.testsWritten,
              testFiles: testerResult.testFiles,
              testResults: testerResult.testResults,
              testsRun: testerResult.testsRun
            } as any
          });
          
          if (testerResult.testResults === "PASS" || testerResult.testResults === "SKIPPED") {
            this.assertNotCancelled(ticket.id, ticket.epicId);
            this.db.updateRun({ runId, status: "succeeded", currentNode: "complete", heartbeatAt: nowIso(), lastMessage: "Ticket approved." });
          
            const diffStats = await this.bridge.getDiffStats(workspace.id);
            const commitResult = await this.bridge.gitCommit({ workspaceId: workspace.id, message: `[${ticket.id}] automated ticket completion` });

            const epic = this.db.getEpic(ticket.epicId);
            const useTargetBranch = !!epic?.targetBranch;
            const prBase = epic?.targetBranch ?? this.compareBaseRef.replace("origin/", "");
            
            let prUrl: string | null = null;
            if (!commitResult.startsWith("noop:")) {
              if (this.config.localOnly) {
                console.log(`[${ticket.id}] Local-only mode enabled. Skipping push/PR creation.`);
              } else if (useTargetBranch) {
                await this.bridge.gitPushToBranch({ workspaceId: workspace.id, targetBranch: prBase });
                prUrl = null;
              } else {
                for (let attempt = 1; attempt <= 2; attempt++) {
                  try {
                    await this.bridge.gitPush({ workspaceId: workspace.id });
                    const title = `${ticket.title} (${ticket.id})`;
                    const body = `Automated ticket completion.\n\n**Description:** ${ticket.description}\n\n**Acceptance Criteria:**\n${ticket.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`;
                    prUrl = await this.bridge.gitCreatePr({
                      workspaceId: workspace.id,
                      title,
                      body,
                      base: prBase
                    });
                    break;
                  } catch (pushError) {
                    const msg = pushError instanceof Error ? pushError.message : String(pushError);
                    console.error(`[${ticket.id}] Push/PR creation failed (attempt ${attempt}/2):`, msg);
                    if (attempt === 2) {
                      console.error(`[${ticket.id}] All push/PR attempts exhausted. Ticket approved but PR not created.`);
                    }
                  }
                }
              }
            }

            this.db.updateTicketRunState({
              ticketId: ticket.id,
              status: "approved",
              currentNode: "complete",
              lastHeartbeatAt: nowIso(),
              lastMessage: "Ticket approved.",
              diffFiles: diffStats,
              prUrl
            });
            await this.bridge.archiveWorkspace(workspace.id);
            return { runId, workspaceId: workspace.id, status: "approved", lastDiff, reviewVerdict, testSummary };
          }
          
          // Test failed - record and determine next action
          const repeatedTestFailure = testSummary.length > 0 && testHistory.includes(testerResult.testOutput);
          testHistory.push(testerResult.testOutput);
          packet.priorTestFailures = [testSummary.slice(0, 500)];
          const failure = await this.getFailureDecision(runId, ticket, reviewVerdict, testSummary, {
            repeatedBlockers: false,
            repeatedTestFailure,
            noDiff: false,
            infraFailure: false
          });
          if (failure.decision === "escalate") {
            return await this.escalate(runId, workspace.id, ticket.id, failure.reason);
          }
          continue;
        } else {
          // Fallback: legacy command-based testing
          const result = await this.withHeartbeat(runId, ticket.id, "tester", "Running tests.", () =>
            this.bridge.runNamedCommand({
              workspaceId: workspace.id,
              runId,
              ticketId: ticket.id,
              nodeName: "tester",
              commandName: "test"
            })
          );
          testSummary = `${result.exitCode === 0 ? "PASS" : "FAIL"}\n${result.stdout}\n${result.stderr}`.trim();
          await this.writeHandoff(workspace.id, runId, ticket.id, {
            role: "tester",
            state: result.exitCode === 0 ? "approved" : "rejected",
            summary: result.exitCode === 0 ? "Tests passed." : "Tests failed.",
            files: builderResult.intendedFiles,
            payload: { exitCode: result.exitCode, durationMs: result.durationMs } as any
          });

          if (result.exitCode === 0) {
            this.assertNotCancelled(ticket.id, ticket.epicId);
            this.db.updateRun({ runId, status: "succeeded", currentNode: "complete", heartbeatAt: nowIso(), lastMessage: "Ticket approved." });
          
            const diffStats = await this.bridge.getDiffStats(workspace.id);
            const commitResult = await this.bridge.gitCommit({ workspaceId: workspace.id, message: `[${ticket.id}] automated ticket completion` });

            const epic = this.db.getEpic(ticket.epicId);
            const useTargetBranch = !!epic?.targetBranch;
            const prBase = epic?.targetBranch ?? this.compareBaseRef.replace("origin/", "");
            
            let prUrl: string | null = null;
            if (!commitResult.startsWith("noop:")) {
              if (this.config.localOnly) {
                console.log(`[${ticket.id}] Local-only mode enabled. Skipping push/PR creation.`);
              } else if (useTargetBranch) {
                await this.bridge.gitPushToBranch({ workspaceId: workspace.id, targetBranch: prBase });
                prUrl = null;
              } else {
                for (let attempt = 1; attempt <= 2; attempt++) {
                  try {
                    await this.bridge.gitPush({ workspaceId: workspace.id });
                    const title = `${ticket.title} (${ticket.id})`;
                    const body = `Automated ticket completion.\n\n**Description:** ${ticket.description}\n\n**Acceptance Criteria:**\n${ticket.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`;
                    prUrl = await this.bridge.gitCreatePr({
                      workspaceId: workspace.id,
                      title,
                      body,
                      base: prBase
                    });
                    break;
                  } catch (pushError) {
                    const msg = pushError instanceof Error ? pushError.message : String(pushError);
                    console.error(`[${ticket.id}] Push/PR creation failed (attempt ${attempt}/2):`, msg);
                    if (attempt === 2) {
                      console.error(`[${ticket.id}] All push/PR attempts exhausted. Ticket approved but PR not created.`);
                    }
                  }
                }
              }
            }

            this.db.updateTicketRunState({
              ticketId: ticket.id,
              status: "approved",
              currentNode: "complete",
              lastHeartbeatAt: nowIso(),
              lastMessage: "Ticket approved.",
              diffFiles: diffStats,
              prUrl
            });
            await this.bridge.archiveWorkspace(workspace.id);
            return { runId, workspaceId: workspace.id, status: "approved", lastDiff, reviewVerdict, testSummary };
          }
          
          // Test failed - record and determine next action
          const repeatedTestFailure = testSummary.length > 0 && testHistory.includes(testSummary);
          testHistory.push(testSummary);
          packet.priorTestFailures = [testSummary.slice(0, 500)];
          const failure = await this.getFailureDecision(runId, ticket, reviewVerdict, testSummary, {
            repeatedBlockers: false,
            repeatedTestFailure,
            noDiff: false,
            infraFailure: false
          });
          if (failure.decision === "escalate") {
            return await this.escalate(runId, workspace.id, ticket.id, failure.reason);
          }
          continue;
        }
      }

      // While loop ended without returning - retry budget exceeded
      this.db.updateRun({ runId, status: "failed", currentNode: "complete", heartbeatAt: nowIso(), lastMessage: "Ticket exceeded retry budget.", errorText: "Retry budget exceeded." });
      this.db.updateTicketRunState({ ticketId: ticket.id, status: "failed", currentNode: "complete", lastHeartbeatAt: nowIso(), lastMessage: "Ticket exceeded retry budget." });
      await this.bridge.archiveWorkspace(workspace.id);
      return { runId, workspaceId: workspace.id, status: "failed", lastDiff, reviewVerdict, testSummary };
    } catch (error) {
      if (error instanceof TicketCancelledError) {
        await this.bridge.archiveWorkspace(workspace.id);
        return { runId, workspaceId: workspace.id, status: "failed", lastDiff, reviewVerdict, testSummary: error.message };
      }
      if (this.isPushConflictError(error)) {
        return await this.autoRerunFromFreshHeadOnPushConflict(runId, ticket, workspace.id, error);
      }
      this.db.updateRun({ runId, status: "failed", currentNode: "error", heartbeatAt: nowIso(), lastMessage: "Ticket crashed.", errorText: (error as Error).message });
      this.db.updateTicketRunState({ ticketId: ticket.id, status: "failed", currentNode: "error", lastHeartbeatAt: nowIso(), lastMessage: (error as Error).message });
      await this.bridge.archiveWorkspace(workspace.id);
      throw error;
    } finally {
      this.bridge.releaseLease("workspace", workspace.id);
    }
  }

  private async executeBuilder(
    workspaceId: string,
    runId: string,
    ticketId: string,
    allowedPaths: string[],
    ticket: TicketRecord,
    packet: TicketContextPacket,
    buildAttempts: number
  ): Promise<{ intendedFiles: string[]; lastDiff: string; summary: string }> {
    const workspace = this.bridge.requireWorkspace(workspaceId);

    // Mediated harness builder
    if (this.gateway.runBuilderInWorkspace && this.gateway.models.builder.startsWith("mediated:")) {
      try {
        this.recordAgentStream({
          agentRole: "builder",
          source: "orchestrator",
          streamKind: "status",
          content: "Building via mediated agent harness...",
          runId,
          ticketId,
          epicId: ticket.epicId,
          sequence: 0
        });
        const result = await this.gateway.runBuilderInWorkspace({
          cwd: workspace.worktreePath,
          prompt: builderToolingPrompt(ticket, packet),
          runId,
          ticketId,
          epicId: ticket.epicId,
          onStream: (event) => this.recordAgentStream(event)
        });
        const lastDiff = await this.bridge.gitDiff(workspace.id);
        const intendedFiles = this.extractChangedFiles(lastDiff);
        const buildCheck = await this.maybeRunRequiredBuildCheck(workspace.id, runId, ticketId, ticket);
        await this.bridge.saveArtifact({
          runId,
          ticketId,
          kind: "diff",
          name: `${ticket.id}-attempt-${buildAttempts}.diff`,
          content: lastDiff,
          metadata: { source: "mediated-harness", sessionId: null }
        });
        await this.bridge.saveArtifact({
          runId,
          ticketId,
          kind: "agent_output",
          name: `${ticket.id}-attempt-${buildAttempts}-builder-mediated.log`,
          content: result.rawOutput,
          metadata: { source: "mediated-harness", sessionId: null }
        });
        return {
          intendedFiles,
          lastDiff,
          summary: buildCheck ? `${result.summary}\n${buildCheck}` : result.summary
        };
      } catch (err) {
        if (err instanceof OpenCodeLaunchError) {
          await this.saveOpenCodeLaunchArtifact({
            workspaceId: workspace.id,
            runId,
            ticketId,
            buildAttempts,
            launchInfo: err.launchInfo,
            status: "failure",
            error: err
          });
        }
        this.recordAgentStream({
          agentRole: "builder",
          source: "orchestrator",
          streamKind: "stderr",
          content: err instanceof OpenCodeLaunchError
            ? `${formatOpenCodeFailure(err)}. Falling back to plan mode.`
            : `Mediated harness failed: ${err instanceof Error ? err.message : String(err)}. Falling back to plan mode.`,
          runId,
          ticketId,
          epicId: ticket.epicId,
          sequence: 0
        });
      }
    }

    // OpenCode/Codex workspace builder
    if (this.gateway.runBuilderInWorkspace && !this.gateway.models.builder.startsWith("mediated:")) {
      try {
        const result = await this.gateway.runBuilderInWorkspace({
          cwd: workspace.worktreePath,
          prompt: builderToolingPrompt(ticket, packet),
          runId,
          ticketId,
          epicId: ticket.epicId,
          onStream: (event) => this.recordAgentStream(event)
        });
        await this.saveOpenCodeLaunchArtifact({
          workspaceId: workspace.id,
          runId,
          ticketId,
          buildAttempts,
          launchInfo: result.launchInfo ?? null,
          status: "success"
        });
        const lastDiff = await this.bridge.gitDiff(workspace.id);
        const intendedFiles = this.extractChangedFiles(lastDiff);
        const buildCheck = await this.maybeRunRequiredBuildCheck(workspace.id, runId, ticketId, ticket);
        await this.bridge.saveArtifact({
          runId,
          ticketId,
          kind: "diff",
          name: `${ticket.id}-attempt-${buildAttempts}.diff`,
          content: lastDiff,
          metadata: { source: "opencode", sessionId: result.sessionId ?? null }
        });
        await this.bridge.saveArtifact({
          runId,
          ticketId,
          kind: "agent_output",
          name: `${ticket.id}-attempt-${buildAttempts}-builder-opencode.log`,
          content: result.rawOutput,
          metadata: { source: "opencode", sessionId: result.sessionId ?? null }
        });
        return {
          intendedFiles,
          lastDiff,
          summary: buildCheck ? `${result.summary}\n${buildCheck}` : result.summary
        };
      } catch (err) {
        const launchInfo = err instanceof OpenCodeLaunchError ? err.launchInfo : null;
        await this.saveOpenCodeLaunchArtifact({
          workspaceId: workspace.id,
          runId,
          ticketId,
          buildAttempts,
          launchInfo,
          status: "failure",
          error: err
        });
        this.recordAgentStream({
          agentRole: "builder",
          source: "orchestrator",
          streamKind: "stderr",
          content: `${formatOpenCodeFailure(err)}. Falling back to plan mode.`,
          runId,
          ticketId,
          epicId: ticket.epicId,
          sequence: 0
        });
      }
    }

    this.recordAgentStream({ agentRole: "builder", source: "orchestrator", streamKind: "status", content: "Requesting builder plan...", runId, ticketId, epicId: ticket.epicId, sequence: 0 });
    const plan = await this.getBuilderPlanWithTimeout(ticket, packet);
    this.recordAgentStream({ agentRole: "builder", source: "orchestrator", streamKind: "assistant", content: plan.summary, runId, ticketId, epicId: ticket.epicId, sequence: 1 });
    const intended = new Set(plan.intendedFiles);
    const files = await Promise.all(plan.operations.map(async (operation) => ({
      path: operation.path,
      content: operation.kind === "append_file"
        ? `${await this.readOrDefault(workspace.id, allowedPaths, operation.path)}${operation.content}`
        : operation.content
    })));

    const changedFiles = await this.bridge.writeFiles({
      workspaceId: workspace.id,
      runId,
      ticketId,
      nodeName: "builder_apply",
      allowedPaths,
      files
    });

    for (const file of changedFiles) {
      if (!intended.has(file)) {
        throw new Error(`Builder touched unexpected file: ${file}`);
      }
    }

    this.recordAgentStream({ agentRole: "builder", source: "orchestrator", streamKind: "status", content: `Applied ${changedFiles.length} file(s): ${changedFiles.join(", ")}`, runId, ticketId, epicId: ticket.epicId, sequence: 2, done: true });
    const lastDiff = await this.bridge.gitDiff(workspace.id);
    const buildCheck = await this.maybeRunRequiredBuildCheck(workspace.id, runId, ticketId, ticket);
    await this.bridge.saveArtifact({
      runId,
      ticketId,
      kind: "diff",
      name: `${ticket.id}-attempt-${buildAttempts}.diff`,
      content: lastDiff
    });

    return {
      intendedFiles: plan.intendedFiles,
      lastDiff,
      summary: buildCheck ? `${plan.summary}\n${buildCheck}` : plan.summary
    };
  }

  private extractChangedFiles(diff: string): string[] {
    const files = new Set<string>();
    for (const line of diff.split(/\r?\n/)) {
      const match = /^\+\+\+ b\/(.+)$/.exec(line.trim());
      if (match?.[1]) files.add(match[1]);
    }
    return [...files];
  }

  private normalizeCompareRef(remoteBranch: string): string {
    // git push returns "<remote>/<branch>", while GitHub compare expects "<branch>".
    return remoteBranch.replace(/^[^/]+\//, "");
  }

  private async saveOpenCodeLaunchArtifact(input: {
    workspaceId: string;
    runId: string;
    ticketId: string;
    buildAttempts: number;
    launchInfo: OpenCodeLaunchInfo | null;
    status: "success" | "failure";
    error?: unknown;
  }): Promise<void> {
    const workspace = this.bridge.requireWorkspace(input.workspaceId);
    const payload = {
      status: input.status,
      runId: input.runId,
      ticketId: input.ticketId,
      workspaceId: input.workspaceId,
      launch: input.launchInfo,
      error: input.error instanceof OpenCodeLaunchError
        ? {
            kind: input.error.kind,
            message: input.error.message,
            exitCode: input.error.exitCode,
            launchInfo: input.error.launchInfo
          }
        : input.error instanceof Error
          ? { message: input.error.message, stack: input.error.stack ?? null }
          : input.error ?? null
    };
    await this.bridge.saveArtifact({
      runId: input.runId,
      ticketId: input.ticketId,
      kind: "launch",
      name: `${input.ticketId}-attempt-${input.buildAttempts}-builder-opencode-launch.json`,
      content: JSON.stringify(payload, null, 2),
      metadata: {
        workspacePath: workspace.worktreePath,
        status: input.status,
        launchKind: input.error instanceof OpenCodeLaunchError
          ? input.error.kind
          : input.status === "failure"
            ? "unknown"
            : "ok"
      }
    });
  }

  private recordAgentStream(event: AgentStreamPayload): void {
    this.db.recordEvent({
      aggregateType: event.ticketId ? "ticket" : "epic",
      aggregateId: event.ticketId ?? event.epicId ?? event.runId ?? "stream",
      runId: event.runId ?? null,
      ticketId: event.ticketId ?? null,
      kind: "agent_stream",
      message: `${event.agentRole}:${event.streamKind}`,
      payload: event as any
    });
  }

  private heartbeat(runId: string, ticketId: string, node: string, message: string): void {
    const ticket = this.db.getTicket(ticketId);
    this.assertNotCancelled(ticketId, ticket?.epicId ?? null);
    const timestamp = nowIso();
    this.db.updateRun({ runId, status: "running", currentNode: node, heartbeatAt: timestamp, lastMessage: message });
    this.db.updateTicketRunState({ ticketId, currentNode: node, lastHeartbeatAt: timestamp, lastMessage: message });
  }

  private async withHeartbeat<T>(runId: string, ticketId: string, node: string, message: string, task: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      try {
        this.heartbeat(runId, ticketId, node, message);
      } catch {
        // Let the in-flight task surface the real failure.
      }
    }, this.heartbeatIntervalMs);
    try {
      return await task();
    } finally {
      clearInterval(timer);
    }
  }

  private async writeHandoff(workspaceId: string, runId: string, ticketId: string, handoff: HandoffPacket): Promise<void> {
    await this.bridge.saveArtifact({
      runId,
      ticketId,
      kind: "handoff",
      name: `${handoff.role}-${ticketId}.json`,
      content: JSON.stringify(handoff, null, 2)
    });
  }

  private async readOrDefault(workspaceId: string, allowedPaths: string[], filePath: string): Promise<string> {
    try {
      const content = await this.bridge.readFiles(workspaceId, allowedPaths, [filePath]);
      return content[filePath] ?? "";
    } catch {
      return "";
    }
  }

  private async getBuilderPlanWithTimeout(ticket: TicketRecord, packet: TicketContextPacket) {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        this.gateway.getBuilderPlan(builderPrompt(ticket, packet)),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Builder planner timed out after ${this.builderPlanTimeoutMs}ms`));
          }, this.builderPlanTimeoutMs);
        })
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async getReviewerVerdictWithRetry(runId: string, ticket: TicketRecord, diff: string, workspaceId: string): Promise<ReviewerVerdict> {
    const runtimeConfig = loadConfig();
    const reviewerMode = this.resolveReviewerMode(runtimeConfig.reviewerMode);
    const reviewerTimeoutMs = reviewerMode === "mediated-deep"
      ? runtimeConfig.reviewDeepTimeoutMs
      : runtimeConfig.reviewFastTimeoutMs;
    const maxAttempts = reviewerMode === "mediated-deep" ? 2 : 1;
    const workspace = this.bridge.requireWorkspace(workspaceId);
    const contract = runtimeConfig.reviewGuardEnabled
      ? await loadReviewContract(workspace.worktreePath, runtimeConfig.reviewContractPath)
      : {
          found: false,
          valid: false,
          contractPath: runtimeConfig.reviewContractPath,
          warnings: ["Review guard disabled by configuration."],
          contract: null,
        } satisfies ReviewContractLoadResult;
    const destructiveBlockers = this.getDestructiveDiffBlockers(diff);
    const guard = runReviewGuard({
      diff,
      allowedPaths: ticket.allowedPaths,
      contract,
      destructiveBlockers,
    });

    this.recordAgentStream({
      agentRole: "reviewer",
      source: "orchestrator",
      streamKind: "status",
      content: `Review guard started (${reviewerMode}).`,
      runId,
      ticketId: ticket.id,
      epicId: ticket.epicId,
      sequence: 0,
      metadata: {
        reviewerMode,
        guardPassed: guard.passed,
        contractFound: contract.found,
        contractValid: contract.valid,
      }
    });

    if (!guard.passed || reviewerMode === "off") {
      const blockers = [...guard.blockers];
      const suggestions = [...guard.suggestions];
      if (reviewerMode === "off") {
        suggestions.unshift("Reviewer model disabled; guard-only review applied.");
      }
      const guardContent = destructiveBlockers.length > 0
        ? `Destructive diff guard triggered: ${destructiveBlockers.join(" | ")}`
        : `Review guard failed: ${guard.blockers.join(" | ")}`;
      this.recordAgentStream({
        agentRole: "reviewer",
        source: "orchestrator",
        streamKind: guard.passed ? "status" : "stderr",
        content: guard.passed
          ? "Review guard passed; reviewer skipped because mode is off."
          : guardContent,
        runId,
        ticketId: ticket.id,
        epicId: ticket.epicId,
        sequence: 1,
        metadata: {
          reviewerMode,
          guardRuleHits: guard.metadata.ruleHits,
          changedFiles: guard.metadata.changedFiles,
          contractPath: guard.metadata.contractPath,
        }
      });
      return {
        approved: guard.passed,
        blockers,
        suggestions,
        riskLevel: guard.passed ? "low" : "high",
      };
    }

    const reviewerContext = this.buildReviewerContext(ticket, diff, guard, contract);
    const useMediatedReviewer = reviewerMode === "mediated-deep" && Boolean(this.gateway.runReviewerInWorkspace);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        this.recordAgentStream({
          agentRole: "reviewer",
          source: "orchestrator",
          streamKind: "status",
          content: `Review model call started (${reviewerMode}).`,
          runId,
          ticketId: ticket.id,
          epicId: ticket.epicId,
          sequence: attempt,
          metadata: {
            reviewerMode,
            guardRuleHits: guard.metadata.ruleHits,
            changedFiles: guard.metadata.changedFiles,
          }
        });
        const verdict = await this.withHeartbeat(runId, ticket.id, "reviewer", "Reviewing diff.", () =>
          this.withTimeout(
            useMediatedReviewer
              ? this.gateway.runReviewerInWorkspace!({
                  cwd: workspace.worktreePath,
                  prompt: reviewerToolingPrompt(ticket),
                  runId,
                  ticketId: ticket.id,
                  epicId: ticket.epicId,
                  onStream: (event) => this.recordAgentStream(event)
                })
              : this.gateway.getReviewerVerdict(reviewerPrompt(ticket, null, null, diff)),
            reviewerTimeoutMs,
            `Reviewer timed out after ${reviewerTimeoutMs}ms`
          )
        );

        const blockers = [...new Set([...verdict.blockers, ...guard.blockers])];
        const suggestions = [...new Set([...verdict.suggestions, ...guard.suggestions])];
        const approved = blockers.length === 0 && verdict.approved;
        this.recordAgentStream({
          agentRole: "reviewer",
          source: "orchestrator",
          streamKind: "status",
          content: `Review model call completed (${reviewerMode}).`,
          runId,
          ticketId: ticket.id,
          epicId: ticket.epicId,
          sequence: attempt,
          metadata: {
            reviewerMode,
            approved,
            guardRuleHits: guard.metadata.ruleHits,
          }
        });
        return {
          approved,
          blockers,
          suggestions,
          riskLevel: blockers.length > 0 ? "high" : verdict.riskLevel,
        };
      } catch (error) {
        lastError = error;
        const isRetryable = reviewerMode === "mediated-deep" && this.isReviewerInfraError(error);
        const message = this.formatReviewerError(error);
        this.recordAgentStream({
          agentRole: "reviewer",
          source: "orchestrator",
          streamKind: "stderr",
          content: attempt < maxAttempts && isRetryable
            ? `${message}. Retrying reviewer (${attempt + 1}/${maxAttempts})...`
            : message,
          runId,
          ticketId: ticket.id,
          epicId: ticket.epicId,
          sequence: attempt,
          metadata: {
            reviewerMode,
            guardRuleHits: guard.metadata.ruleHits,
            changedFiles: guard.metadata.changedFiles,
          }
        });
        if (!isRetryable || attempt >= maxAttempts) {
          throw new Error(message);
        }
        await sleep(1000);
      }
    }
    throw new Error(this.formatReviewerError(lastError));
  }

  private resolveReviewerMode(rawMode: string | undefined | null): ReviewerMode {
    const normalized = String(rawMode ?? "").trim().toLowerCase();
    if (normalized === "off" || normalized === "mediated-deep" || normalized === "direct-fast") {
      return normalized;
    }
    return "direct-fast";
  }

  private buildReviewerContext(
    ticket: TicketRecord,
    diff: string,
    guard: ReturnType<typeof runReviewGuard>,
    contract: ReviewContractLoadResult
  ): string {
    const contractSummary = contract.contract
      ? [
          `Review contract: ${contract.contractPath}`,
          `Schema sources: ${contract.contract.schemaSources.join(", ") || "(none)"}`,
          `Derived schemas: ${contract.contract.derivedSchemas.map((rule) => `${rule.derived} <- ${rule.source}`).join(", ") || "(none)"}`,
          `Generated read-only paths: ${contract.contract.generatedReadOnlyPaths.join(", ") || "(none)"}`,
          `Folder ownership: ${contract.contract.folderOwnership.map((rule) => `${rule.path} -> ${rule.owner}`).join(", ") || "(none)"}`,
        ].join("\n")
      : [
          `Review contract unavailable: ${contract.contractPath}`,
          ...contract.warnings,
        ].join("\n");

    return [
      "Reviewer context:",
      `Ticket: ${ticket.title}`,
      `Allowed paths: ${ticket.allowedPaths.join(", ") || "(none)"}`,
      `Changed files: ${guard.metadata.changedFiles.join(", ") || "(none)"}`,
      `Guard rule hits: ${guard.metadata.ruleHits.join(", ") || "(none)"}`,
      contractSummary,
      "Diff:",
      diff,
    ].join("\n\n");
  }

  private isReviewerInfraError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return normalized.includes("fetch failed")
      || normalized.includes("ollama request failed")
      || normalized.includes("timed out")
      || normalized.includes("econnrefused")
      || normalized.includes("socket hang up")
      || normalized.includes("connect")
      || normalized.includes("network");
  }

  private formatReviewerError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (this.isReviewerInfraError(error)) {
      return `Reviewer/Ollama unavailable: ${message}`;
    }
    return message;
  }

  private getDestructiveDiffBlockers(diff: string): string[] {
    if (!diff.trim()) return [];
    const blockers: string[] = [];
    if (/^deleted file mode\s+/m.test(diff) || /^---\s+a\/.+\r?\n\+\+\+\s+\/dev\/null/m.test(diff)) {
      blockers.push("Diff deletes one or more files.");
    }

    const addedLines = diff
      .split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    const removedLineCount = diff
      .split(/\r?\n/)
      .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const addedLineCount = addedLines.length;

    const dangerousPatterns: Array<{ pattern: RegExp; reason: string }> = [
      { pattern: /\brm\s+-rf\b/i, reason: "Introduces recursive force delete command (`rm -rf`)." },
      { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "Introduces destructive git reset (`git reset --hard`)." },
      { pattern: /\bgit\s+clean\s+-f[dDxX]*\b/i, reason: "Introduces destructive git clean command." },
      { pattern: /\bdrop\s+database\b/i, reason: "Introduces `DROP DATABASE` SQL operation." },
      { pattern: /\btruncate\s+table\b/i, reason: "Introduces `TRUNCATE TABLE` SQL operation." },
      { pattern: /\bdelete\s+from\b(?!.*\bwhere\b)/i, reason: "Introduces `DELETE FROM` without `WHERE`." },
      { pattern: /\.deleteMany\(\s*\)/i, reason: "Introduces unbounded `.deleteMany()` call." },
      { pattern: /\.deleteMany\(\s*\{\s*\}\s*\)/i, reason: "Introduces `.deleteMany({})` (delete all records)." }
    ];

    for (const addedLine of addedLines) {
      for (const { pattern, reason } of dangerousPatterns) {
        if (pattern.test(addedLine)) blockers.push(reason);
      }
    }

    if (removedLineCount >= 300 && addedLineCount <= Math.max(20, Math.floor(removedLineCount * 0.2))) {
      blockers.push(`Large destructive churn detected (${removedLineCount} deletions vs ${addedLineCount} additions).`);
    }
    return [...new Set(blockers)];
  }

  private extractOutOfScopePaths(blockers: string[]): string[] {
    const prefix = "changed file outside allowed paths:";
    const extracted = blockers
      .map((value) => String(value || "").trim())
      .map((value) => {
        const lower = value.toLowerCase();
        if (!lower.startsWith(prefix)) return "";
        return value.slice(prefix.length).trim();
      })
      .filter(Boolean);
    return Array.from(new Set(extracted));
  }

  private async autoExpandAllowedPathsFromReviewerBlockers(
    runId: string | null,
    ticket: TicketRecord,
    blockers: string[]
  ): Promise<void> {
    const outOfScopePaths = this.extractOutOfScopePaths(blockers);
    if (!outOfScopePaths.length) return;

    const current = ticket.allowedPaths ?? [];
    const merged = Array.from(new Set([...current, ...outOfScopePaths]));
    if (merged.length === current.length) return;

    this.db.updateTicketAllowedPaths(ticket.id, merged);
    ticket.allowedPaths = merged;

    this.recordAgentStream({
      agentRole: "doctor",
      source: "orchestrator",
      streamKind: "assistant",
      content: `Auto-expanded allowed paths for ${ticket.id}: ${outOfScopePaths.join(", ")}. Retrying builder with updated scope.`,
      runId,
      ticketId: ticket.id,
      epicId: ticket.epicId,
      sequence: 1,
      done: true
    });
  }

  private async getFailureDecision(
    runId: string | null,
    ticket: TicketRecord,
    reviewVerdict: ReviewerVerdict | null,
    testSummary: string | null,
    flags: {
      repeatedBlockers: boolean;
      repeatedTestFailure: boolean;
      noDiff: boolean;
      infraFailure: boolean;
    }
  ): Promise<FailureDecision> {
    this.recordAgentStream({ agentRole: "doctor", source: "orchestrator", streamKind: "status", content: "Analyzing failure and determining recovery action...", runId, ticketId: ticket.id, epicId: ticket.epicId, sequence: 0, done: false });
    try {
      const decision = await this.gateway.getFailureDecision(doctorPrompt({
        ticket,
        reviewerVerdict: reviewVerdict,
        testSummary,
        ...flags
      }));
      this.recordAgentStream({ agentRole: "doctor", source: "orchestrator", streamKind: "assistant", content: `Decision: ${decision.decision}\nReason: ${decision.reason}`, runId, ticketId: ticket.id, epicId: ticket.epicId, sequence: 1, done: true });
      return decision;
    } catch {
      return deterministicDoctor(flags);
    }
  }

  private requiresBuildValidation(ticket: TicketRecord): boolean {
    const text = [
      ticket.title,
      ticket.description,
      ...(ticket.acceptanceCriteria ?? [])
    ]
      .join(" ")
      .toLowerCase();
    return /\b(build|compile|compiles|compilation)\b/.test(text);
  }

  private async maybeRunRequiredBuildCheck(
    workspaceId: string,
    runId: string,
    ticketId: string,
    ticket: TicketRecord
  ): Promise<string | null> {
    if (!this.requiresBuildValidation(ticket)) return null;

    this.recordAgentStream({
      agentRole: "builder",
      source: "orchestrator",
      streamKind: "status",
      content: "Running required build validation...",
      runId,
      ticketId,
      epicId: ticket.epicId,
      sequence: 9
    });

    const result = await this.bridge.runNamedCommand({
      workspaceId,
      runId,
      ticketId,
      nodeName: "builder_build_check",
      commandName: "build",
      timeoutMs: 300_000
    });

    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 2000);
      throw new Error(`Required build validation failed (exit ${result.exitCode}). ${output}`);
    }

    return "Required build validation passed.";
  }

  private isPushConflictError(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error ?? "");
    const lower = text.toLowerCase();
    return (
      lower.includes("non-fast-forward") ||
      lower.includes("failed to push some refs") ||
      (lower.includes("rebase") && lower.includes("could not apply"))
    );
  }

  private async autoRerunFromFreshHeadOnPushConflict(
    runId: string,
    ticket: TicketRecord,
    workspaceId: string,
    error: unknown
  ): Promise<TicketLoopResult> {
    const messageText = error instanceof Error ? error.message : String(error);
    const recentPushConflicts = this.db
      .listRunsForTicket(ticket.id)
      .filter((run) => {
        const text = `${run.lastMessage ?? ""}\n${run.errorText ?? ""}`.toLowerCase();
        return text.includes("non-fast-forward") || text.includes("failed to push some refs") || text.includes("could not apply");
      }).length;

    if (recentPushConflicts >= 2) {
      this.db.updateRun({
        runId,
        status: "failed",
        currentNode: "error",
        heartbeatAt: nowIso(),
        lastMessage: "Push conflict repeated; manual merge required.",
        errorText: messageText
      });
      this.db.updateTicketRunState({
        ticketId: ticket.id,
        status: "failed",
        currentNode: "error",
        lastHeartbeatAt: nowIso(),
        lastMessage: "Push conflict repeated; manual merge required."
      });
      if (workspaceId) await this.bridge.archiveWorkspace(workspaceId).catch(() => undefined);
      return {
        runId,
        workspaceId,
        status: "failed",
        lastDiff: "",
        reviewVerdict: null,
        testSummary: "Push conflict repeated; manual merge required."
      };
    }

    const nextRunId = await this.start(ticket.id, ticket.epicId);
    const note = `Push conflict while landing changes; auto-rerunning from fresh head as ${nextRunId}.`;
    this.db.updateRun({
      runId,
      status: "failed",
      currentNode: "error",
      heartbeatAt: nowIso(),
      lastMessage: note,
      errorText: messageText
    });
    this.db.updateTicketRunState({
      ticketId: ticket.id,
      status: "queued",
      currentRunId: nextRunId,
      currentNode: "queued",
      lastHeartbeatAt: nowIso(),
      lastMessage: note
    });
    this.recordAgentStream({
      agentRole: "doctor",
      source: "orchestrator",
      streamKind: "assistant",
      content: note,
      runId,
      ticketId: ticket.id,
      epicId: ticket.epicId,
      done: true
    });
    if (workspaceId) await this.bridge.archiveWorkspace(workspaceId).catch(() => undefined);
    return {
      runId,
      workspaceId,
      status: "failed",
      lastDiff: "",
      reviewVerdict: null,
      testSummary: note
    };
  }

  private async escalate(runId: string, workspaceId: string, ticketId: string, reason: string): Promise<TicketLoopResult> {
    this.db.updateRun({ runId, status: "escalated", currentNode: "escalated", heartbeatAt: nowIso(), lastMessage: reason, errorText: reason });
    this.db.updateTicketRunState({ ticketId, status: "escalated", currentNode: "escalated", lastHeartbeatAt: nowIso(), lastMessage: reason });
    await this.bridge.saveArtifact({
      runId,
      ticketId,
      kind: "escalation",
      name: `${ticketId}-escalation.json`,
      content: JSON.stringify({ reason, runId, ticketId }, null, 2)
    });
    await this.bridge.archiveWorkspace(workspaceId);
    return { runId, workspaceId, status: "escalated", lastDiff: "", reviewVerdict: null, testSummary: reason };
  }

  private assertNotCancelled(ticketId: string, epicId: string | null): void {
    if (this.lifecycle.isTicketCancelled(ticketId)) {
      throw new TicketCancelledError(`Ticket ${ticketId} cancelled by user.`);
    }
    if (epicId && this.lifecycle.isEpicCancelled(epicId)) {
      throw new TicketCancelledError(`Epic ${epicId} cancelled by user.`);
    }
  }

  private resolveMaxBuildAttempts(ticket: TicketRecord): number {
    const configured = Number(ticket.metadata.maxBuildAttempts ?? 3);
    if (!Number.isFinite(configured) || configured <= 0) return 3;
    return Math.min(3, Math.floor(configured));
  }

  private reviewerVerdictFingerprint(verdict: ReviewerVerdict, diff: string): string {
    const payload = JSON.stringify({
      approved: verdict.approved,
      blockers: verdict.blockers,
      suggestions: verdict.suggestions,
      diff: diff.slice(0, 8000)
    });
    return createHash("sha1").update(payload).digest("hex");
  }
}

class TicketCancelledError extends Error {}
