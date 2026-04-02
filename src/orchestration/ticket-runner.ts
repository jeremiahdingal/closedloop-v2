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
import { randomId, nowIso } from "../utils.ts";
import { builderPrompt, builderToolingPrompt, doctorPrompt, reviewerPrompt } from "./prompts.ts";
import type { ModelGateway } from "./models.ts";
import { loadLangGraphRuntime, type LangGraphRuntime } from "./langgraph-loader.ts";
import { OpenCodeLaunchError, formatOpenCodeFailure } from "./opencode.ts";
import { LifecycleService } from "./lifecycle.ts";

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
  repeatedBlockers: boolean;
  repeatedTestFailure: boolean;
  status: "pending" | "building" | "reviewing" | "testing" | "approved" | "escalated" | "failed";
};

export class TicketRunner {
  readonly config = loadConfig();
  private readonly heartbeatIntervalMs = 15_000;
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
      currentRunId: runId,
      currentNode: "queued",
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
      maxBuildAttempts: z.number().default(Number(ticket.metadata.maxBuildAttempts ?? 3)),
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
      failureDecision: z.enum(["retry_same_node", "retry_builder", "blocked", "todo", "escalate"]).default("retry_builder"),
      failureReason: z.string().default(""),
      noDiff: z.boolean().default(false),
      repeatedBlockers: z.boolean().default(false),
      repeatedTestFailure: z.boolean().default(false),
      status: z.enum(["pending", "building", "reviewing", "testing", "approved", "escalated", "failed"]).default("pending")
    });

    const prepareContext = async (_state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      this.db.updateRun({ runId, status: "running", currentNode: "prepare_context", heartbeatAt: nowIso(), lastMessage: "Preparing workspace." });
      this.db.updateTicketRunState({ ticketId: ticket.id, status: "building", currentRunId: runId, currentNode: "prepare_context", lastHeartbeatAt: nowIso(), lastMessage: "Preparing workspace." });
      const epic = this.db.getEpic(ticket.epicId);
      const workspace = await this.bridge.createWorkspace({ ticketId: ticket.id, runId, owner: runId, targetDir: epic?.targetDir || this.config.repoRoot });
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
        maxBuildAttempts: Number(ticket.metadata.maxBuildAttempts ?? 3),
        lastMessage: "Workspace prepared.",
        status: "building"
      } satisfies Partial<TicketGraphState>;
    };

    const builderNode = async (state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
      const workspace = this.bridge.requireWorkspace(state.workspaceId);
      const buildAttempts = state.buildAttempts + 1;
      this.heartbeat(runId, ticket.id, "builder_plan", `Builder attempt ${buildAttempts}.`);
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
        attempt: buildAttempts
      };
      await this.bridge.saveContextPacket(packet);
      const builderResult = await this.withHeartbeat(runId, ticket.id, "builder_plan", `Builder attempt ${buildAttempts}.`, () =>
        this.executeBuilder(workspace.id, runId, ticket.id, ticket.allowedPaths, ticket, packet, buildAttempts)
      );

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
      this.heartbeat(runId, ticket.id, "reviewer", "Reviewing diff.");
      this.recordAgentStream({ agentRole: "reviewer", source: "orchestrator", streamKind: "status", content: "Reviewing diff...", runId, ticketId: ticket.id, epicId: ticket.epicId, sequence: 0, done: false });
      const reviewVerdict = await this.withHeartbeat(runId, ticket.id, "reviewer", "Reviewing diff.", () =>
        this.gateway.getReviewerVerdict(reviewerPrompt(ticket, state.lastDiff))
      );
      this.recordAgentStream({ agentRole: "reviewer", source: "orchestrator", streamKind: "assistant", content: `Approved: ${reviewVerdict.approved}\nBlockers: ${reviewVerdict.blockers.join(", ") || "none"}\nSuggestions: ${reviewVerdict.suggestions.join(", ") || "none"}`, runId, ticketId: ticket.id, epicId: ticket.epicId, sequence: 1, done: true });
      await this.writeHandoff(state.workspaceId, runId, ticket.id, {
        role: "reviewer",
        state: reviewVerdict.approved ? "approved" : "rejected",
        summary: reviewVerdict.approved ? "Approved for testing." : "Changes require another build.",
        files: state.intendedFiles,
        payload: reviewVerdict as any
      });
      const blockerKey = reviewVerdict.blockers.join("|");
      const repeatedBlockers = Boolean(blockerKey) && state.blockHistory.includes(blockerKey);
      return {
        reviewApproved: reviewVerdict.approved,
        reviewBlockers: reviewVerdict.blockers,
        reviewSuggestions: reviewVerdict.suggestions,
        blockHistory: blockerKey ? [...state.blockHistory, blockerKey] : state.blockHistory,
        repeatedBlockers,
        lastMessage: reviewVerdict.approved ? "Reviewer approved changes." : reviewVerdict.blockers.join("; ") || "Reviewer rejected changes.",
        status: reviewVerdict.approved ? "testing" : "reviewing"
      } satisfies Partial<TicketGraphState>;
    };

    const testerNode = async (state: TicketGraphState) => {
      this.assertNotCancelled(ticket.id, ticket.epicId);
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
      const failure = await this.getFailureDecision(runId, ticket, state.reviewApproved ? {
        approved: state.reviewApproved,
        blockers: state.reviewBlockers,
        suggestions: state.reviewSuggestions,
        riskLevel: state.reviewApproved ? "low" : "medium"
      } : null, state.testSummary || null, {
        repeatedBlockers: state.repeatedBlockers,
        repeatedTestFailure: state.repeatedTestFailure,
        noDiff: state.noDiff,
        infraFailure: false
      });
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
      
      let prUrl: string | null = null;
      if (!commitResult.startsWith("noop:")) {
        try {
          const remoteBranch = await this.bridge.gitPush({ workspaceId: state.workspaceId });
          const remoteUrl = await this.bridge.gitRemoteUrl(state.workspaceId);
          if (remoteUrl && (remoteUrl.includes("github.com") || remoteUrl.includes("gitlab.com"))) {
            const baseUrl = remoteUrl.replace(/\.git$/, "").replace(/git@([^:]+):/, "https://$1/");
            prUrl = `${baseUrl}/compare/${state.workspaceId.split("_")[1]}...${remoteBranch}`;
          }
        } catch (pushError) {
          console.warn("Failed to push branch:", pushError);
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
      .addNode("builder", builderNode)
      .addNode("reviewer", reviewerNode)
      .addNode("tester", testerNode)
      .addNode("classify", classifyNode)
      .addNode("finalize_success", finalizeSuccess)
      .addNode("finalize_escalated", finalizeEscalated)
      .addNode("finalize_failed", finalizeFailed)
      .addEdge(START, "prepare_context")
      .addEdge("prepare_context", "builder")
      .addConditionalEdges("builder", (state: TicketGraphState) => state.noDiff ? "classify" : "reviewer", ["classify", "reviewer"])
      .addConditionalEdges("reviewer", (state: TicketGraphState) => state.reviewApproved ? "tester" : "classify", ["tester", "classify"])
      .addConditionalEdges("tester", (state: TicketGraphState) => state.testPassed ? "finalize_success" : "classify", ["finalize_success", "classify"])
      .addConditionalEdges(
        "classify",
        (state: TicketGraphState) => {
          if (state.buildAttempts >= state.maxBuildAttempts) return "finalize_failed";
          if (["escalate", "blocked", "todo"].includes(state.failureDecision)) return "finalize_escalated";
          return "builder";
        },
        ["builder", "finalize_escalated", "finalize_failed"]
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
    const workspace = await this.bridge.createWorkspace({ ticketId: ticket.id, runId, owner: runId, targetDir: epic?.targetDir || this.config.repoRoot });
    await this.bridge.acquireWorkspaceLease(workspace.id, runId);

    let reviewVerdict: ReviewerVerdict | null = null;
    let testSummary: string | null = null;
    let lastDiff = "";
    let blockHistory: string[] = [];
    let testHistory: string[] = [];
    let buildAttempts = 0;
    const maxBuildAttempts = Number(ticket.metadata.maxBuildAttempts ?? 3);

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
      reviewVerdict = await this.withHeartbeat(runId, ticket.id, "reviewer", "Reviewing diff.", () =>
        this.gateway.getReviewerVerdict(reviewerPrompt(ticket, lastDiff))
      );
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
          const repeatedBlockers = blockerKey.length > 0 && blockHistory.includes(blockerKey);
          blockHistory.push(blockerKey);
          packet.reviewBlockers = reviewVerdict.blockers;
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
          
          let prUrl: string | null = null;
          if (!commitResult.startsWith("noop:")) {
            try {
              const remoteBranch = await this.bridge.gitPush({ workspaceId: workspace.id });
              const remoteUrl = await this.bridge.gitRemoteUrl(workspace.id);
              if (remoteUrl && (remoteUrl.includes("github.com") || remoteUrl.includes("gitlab.com"))) {
                const baseUrl = remoteUrl.replace(/\.git$/, "").replace(/git@([^:]+):/, "https://$1/");
                prUrl = `${baseUrl}/compare/${workspace.id.split("_")[1]}...${remoteBranch}`;
              }
            } catch (pushError) {
              console.warn("Failed to push branch:", pushError);
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
      }

      this.db.updateRun({ runId, status: "failed", currentNode: "complete", heartbeatAt: nowIso(), lastMessage: "Ticket exceeded retry budget.", errorText: "Retry budget exceeded." });
      this.db.updateTicketRunState({ ticketId: ticket.id, status: "failed", currentNode: "complete", lastHeartbeatAt: nowIso(), lastMessage: "Ticket exceeded retry budget." });
      await this.bridge.archiveWorkspace(workspace.id);
      return { runId, workspaceId: workspace.id, status: "failed", lastDiff, reviewVerdict, testSummary };
    } catch (error) {
      if (error instanceof TicketCancelledError) {
        await this.bridge.archiveWorkspace(workspace.id);
        return { runId, workspaceId: workspace.id, status: "failed", lastDiff, reviewVerdict, testSummary: error.message };
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
          summary: result.summary
        };
      } catch (err) {
        this.recordAgentStream({
          agentRole: "builder",
          source: "orchestrator",
          streamKind: "stderr",
          content: `Mediated harness failed: ${err instanceof Error ? err.message : String(err)}. Falling back to plan mode.`,
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
          summary: result.summary
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
    const plan = await this.gateway.getBuilderPlan(builderPrompt(ticket, packet));
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
      summary: plan.summary
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
}

class TicketCancelledError extends Error {}
