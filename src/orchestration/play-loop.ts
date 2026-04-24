import { writeFile, mkdir, symlink, stat, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { AppDatabase } from "../db/database.ts";
import { randomId, nowIso } from "../utils.ts";
import { epicDecoderPrompt, epicDecoderToolingPrompt, epicReviewerPrompt, epicReviewerToolingPrompt, epicReviewerCodexPrompt, epicReviewerBuildFixPrompt, playWriterPrompt, playTesterPrompt } from "./prompts.ts";
import type { ModelGateway } from "./models.ts";
import type { AgentStreamPayload, EpicRecord, GoalDecomposition, GoalReview, GoalTicketPlan, TicketRecord } from "../types.ts";
import { TicketRunner } from "./ticket-runner.ts";
import { loadConfig } from "../config.ts";
import { loadLangGraphRuntime, type LangGraphRuntime } from "./langgraph-loader.ts";
import { formatOpenCodeFailure } from "./opencode.ts";
import { formatCodexFailure } from "./codex.ts";
import { formatQwenFailure } from "./qwen.ts";
import { LifecycleService } from "./lifecycle.ts";
import { WorkspaceBridge } from "../bridge/workspace-bridge.ts";
import { buildContextForQuery } from "../rag/context-builder.ts";
import { git } from "../bridge/git.ts";
import { ensureProjectStructureFile } from "./project-structure.ts";

type PlayWriterResult = {
  testsCreated: string[];
  buildFixed: boolean;
  summary: string;
};

type PlayTesterTestResult = {
  testFile: string;
  testName: string;
  status: "passed" | "failed";
  steps: number;
  error: string | null;
};

type PlayTesterResult = {
  status: "passed" | "failed";
  summary: { total: number; passed: number; failed: number };
  results: PlayTesterTestResult[];
};

export type { PlayWriterResult, PlayTesterTestResult, PlayTesterResult };

interface PlayLoopCallbacks {
  runEpicDecoder: (epic: EpicRecord, runId: string) => Promise<GoalDecomposition>;
  executeTickets: (epic: EpicRecord, tickets: TicketRecord[], runId: string) => Promise<void>;
  runEpicReview: (epic: EpicRecord, tickets: TicketRecord[], runId: string) => Promise<GoalReview>;
}

export class PlayLoopService {
  private db: AppDatabase;
  private bridge: WorkspaceBridge;
  private gateway: ModelGateway;
  private ticketRunner: TicketRunner;
  private lifecycle: LifecycleService;
  private epicReviewTimeoutMs: number;
  private heartbeatIntervalMs: number;
  private callbacks: PlayLoopCallbacks;

  constructor(
    db: AppDatabase,
    bridge: WorkspaceBridge,
    gateway: ModelGateway,
    ticketRunner: TicketRunner,
    lifecycle: LifecycleService,
    callbacks: PlayLoopCallbacks,
    epicReviewTimeoutMs: number = 10 * 60 * 1000,
    heartbeatIntervalMs: number = 30_000
  ) {
    this.db = db;
    this.bridge = bridge;
    this.gateway = gateway;
    this.ticketRunner = ticketRunner;
    this.lifecycle = lifecycle;
    this.callbacks = callbacks;
    this.epicReviewTimeoutMs = epicReviewTimeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
  }

  private recordAgentStream(e: AgentStreamPayload): void {
    // This would need to be implemented to match GoalRunner's method
    // For now, we'll use console.log for debugging
    if (e.streamKind === "stderr" || e.streamKind === "status") {
      console.error(`[${e.agentRole}] ${e.content}`);
    }
  }

  private async startDevServer(
    cwd: string,
    command: string,
    readyMs: number
  ): Promise<ChildProcess> {
    const [cmd, ...args] = command.split(" ");
    const proc = spawn(cmd, args, {
      cwd,
      stdio: "ignore",
      detached: false,
      shell: process.platform === "win32"
    });
    proc.on("error", (err) => {
      console.warn(`[PlayTester] Dev server process error: ${err.message}`);
    });
    await new Promise<void>(resolve => setTimeout(resolve, readyMs));
    return proc;
  }

  private stopDevServer(proc: ChildProcess): void {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" });
      } else {
        proc.kill("SIGTERM");
      }
    } catch (err) {
      console.warn(`[PlayTester] Failed to stop dev server: ${err}`);
    }
  }

  private async listExistingTestFiles(targetDir: string): Promise<string[]> {
    const testsDir = `${targetDir}/tests`;
    try {
      const entries = await readdir(testsDir);
      return entries
        .filter(f => f.endsWith(".spec.ts"))
        .map(f => `tests/${f}`);
    } catch {
      return [];
    }
  }

  private parsePlayWriterResult(rawText: string): PlayWriterResult | null {
    const match = rawText.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1].trim());
      return {
        testsCreated: Array.isArray(parsed.testsCreated) ? parsed.testsCreated : [],
        buildFixed: Boolean(parsed.buildFixed),
        summary: String(parsed.summary ?? "")
      };
    } catch {
      return null;
    }
  }

  private parsePlayTesterResult(rawText: string): PlayTesterResult | null {
    const match = rawText.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1].trim());
      return {
        status: parsed.status === "passed" ? "passed" : "failed",
        summary: {
          total: Number(parsed.summary?.total ?? 0),
          passed: Number(parsed.summary?.passed ?? 0),
          failed: Number(parsed.summary?.failed ?? 0)
        },
        results: Array.isArray(parsed.results) ? parsed.results.map((r: any) => ({
          testFile: String(r.testFile ?? ""),
          testName: String(r.testName ?? ""),
          status: r.status === "passed" ? "passed" : "failed",
          steps: Number(r.steps ?? 0),
          error: r.error ?? null
        })) : []
      };
    } catch {
      return null;
    }
  }

  private async buildRagContext(
    repoPath: string,
    query: string
  ): Promise<{ codeContext: string; docContext: string; indexId: number | null } | null> {
    try {
      const headResult = await git(repoPath, ["rev-parse", "HEAD"]);
      const commitHash = headResult.stdout.trim();
      const ctx = await buildContextForQuery({
        query: query.slice(0, 1000),
        db: this.db,
        repoRoot: repoPath,
        commitHash,
      });
      return { codeContext: ctx.codeContext, docContext: ctx.docContext, indexId: ctx.indexId };
    } catch (err) {
      console.warn(`[RAG] buildRagContext failed: ${err}`);
      return null;
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

  private async withHeartbeat<T>(runId: string, epicId: string, node: string, message: string, task: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      try {
        this.db.updateRun({ runId, status: "running", currentNode: node, heartbeatAt: nowIso(), lastMessage: message });
      } catch {
        // ignore
      }
    }, this.heartbeatIntervalMs);
    try {
      return await task();
    } finally {
      clearInterval(timer);
    }
  }

  async runPlayLoop(
    epic: EpicRecord,
    tickets: TicketRecord[],
    runId: string
  ): Promise<boolean> {
    return await this.withHeartbeat(runId, epic.id, "play_loop", "Running Playwright loop.", async () => {
      const MAX_LOOP_ATTEMPTS = 3;
      const config = loadConfig();

      const playWorkspace = await this.bridge.createWorkspace({
        ticketId: `${epic.id}__PLAY_LOOP`,
        runId,
        owner: runId,
        targetDir: epic.targetDir
      });
      await this.bridge.acquireWorkspaceLease(playWorkspace.id, runId);
      let cleaned = false;
      const cleanupWorkspace = async () => {
        if (cleaned) return;
        cleaned = true;
        await this.bridge.archiveWorkspace(playWorkspace.id);
        this.bridge.releaseLease("workspace", playWorkspace.id);
      };

      try {
        // Run Play Writer
        const worktreePath = playWorkspace.worktreePath;
        
        const tcResult = await this.bridge.runNamedCommand({
          workspaceId: playWorkspace.id,
          runId,
          ticketId: `${epic.id}__PLAY_WRITER`,
          nodeName: "playWriter",
          commandName: "typecheck",
          timeoutMs: 120_000
        }).catch(() => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }));

        const buildErrors = tcResult.exitCode !== 0
          ? `${tcResult.stdout}\n${tcResult.stderr}`.trim()
          : null;

        const existingTestFiles = await this.listExistingTestFiles(epic.targetDir);
        const ragCtx = await this.buildRagContext(epic.targetDir, `${epic.title} ${epic.goalText}`);

        const writerPrompt = playWriterPrompt(
          { ...epic, targetDir: worktreePath },
          tickets,
          existingTestFiles,
          buildErrors,
          ragCtx
        );

        this.recordAgentStream({
          agentRole: "playWriter",
          source: "orchestrator",
          streamKind: "status",
          content: `Play Writer started${buildErrors ? " (build errors found, fixing first)" : " (build clean)"}...`,
          runId,
          epicId: epic.id
        });

        let rawText = "";

        if (this.gateway.runEpicReviewerCodex && config.models.playWriter === "qwen-cli") {
          try {
            const result = await this.withTimeout(
              this.gateway.runEpicReviewerCodex({
                cwd: worktreePath,
                prompt: writerPrompt,
                runId,
                epicId: epic.id,
                onStream: (e: AgentStreamPayload) => {
                  this.recordAgentStream({ ...e, agentRole: "playWriter" });
                  rawText += e.content ?? "";
                }
              }),
              this.epicReviewTimeoutMs,
              "Play Writer timed out"
            );
            rawText = JSON.stringify(result);
          } catch (err) {
            this.recordAgentStream({
              agentRole: "playWriter",
              source: "orchestrator",
              streamKind: "stderr",
              content: `qwen-cli failed: ${err instanceof Error ? err.message : String(err)}. Falling back to codex-cli.`,
              runId,
              epicId: epic.id
            });
            rawText = "";
          }
        }

        if (!rawText && this.gateway.runEpicReviewerCodex) {
          try {
            const result = await this.withTimeout(
              this.gateway.runEpicReviewerCodex({
                cwd: worktreePath,
                prompt: writerPrompt,
                runId,
                epicId: epic.id,
                onStream: (e: AgentStreamPayload) => {
                  this.recordAgentStream({ ...e, agentRole: "playWriter" });
                  rawText += e.content ?? "";
                }
              }),
              this.epicReviewTimeoutMs,
              "Play Writer (codex fallback) timed out"
            );
            rawText = JSON.stringify(result);
          } catch (err) {
            this.recordAgentStream({
              agentRole: "playWriter",
              source: "orchestrator",
              streamKind: "stderr",
              content: `codex-cli fallback also failed: ${err instanceof Error ? err.message : String(err)}`,
              runId,
              epicId: epic.id
            });
          }
        }

        const parsed = this.parsePlayWriterResult(rawText);

        if (!parsed || parsed.testsCreated.length === 0) {
          this.recordAgentStream({
            agentRole: "playWriter",
            source: "orchestrator",
            streamKind: "stderr",
            content: "Play Writer did not produce any test files. Skipping Play Tester loop.",
            runId,
            epicId: epic.id
          });
          return true;
        }

        this.recordAgentStream({
          agentRole: "playWriter",
          source: "orchestrator",
          streamKind: "assistant",
          content: `Play Writer complete. Tests created: ${parsed.testsCreated.join(", ")}. ${parsed.summary}`,
          runId,
          epicId: epic.id,
          done: true
        });

        // Play Tester loop
        let currentTestFiles = parsed.testsCreated;
        let previousFailures: PlayTesterTestResult[] | undefined = undefined;
        let currentTickets = tickets;

        for (let attempt = 1; attempt <= MAX_LOOP_ATTEMPTS; attempt++) {
          const previousFailuresJson = previousFailures && previousFailures.length > 0
            ? JSON.stringify(previousFailures, null, 2)
            : null;

          const testerPrompt = playTesterPrompt(
            { ...epic, targetDir: worktreePath },
            currentTestFiles,
            config.playwrightDevServerUrl,
            config.playwrightDevServerCommand,
            attempt,
            previousFailuresJson
          );

          this.recordAgentStream({
            agentRole: "playTester",
            source: "orchestrator",
            streamKind: "status",
            content: `Play Tester started (attempt ${attempt}/3). Starting dev server: ${config.playwrightDevServerCommand}`,
            runId,
            epicId: epic.id
          });

          const devServer = await this.startDevServer(
            worktreePath,
            config.playwrightDevServerCommand,
            config.playwrightDevServerReadyMs
          );

          let testerRawText = "";

          try {
            if (!this.gateway.runGoalReviewInWorkspace) {
              throw new Error("Mediated harness not available. Play Tester requires a mediated model.");
            }

            const result = await this.withTimeout(
              this.gateway.runGoalReviewInWorkspace({
                cwd: worktreePath,
                prompt: testerPrompt,
                runId,
                epicId: epic.id,
                db: this.db,
                onStream: (e: AgentStreamPayload) => {
                  this.recordAgentStream({ ...e, agentRole: "playTester" });
                  testerRawText += e.content ?? "";
                }
              }),
              30 * 60 * 1000,
              "Play Tester timed out after 30 minutes"
            );
            testerRawText = testerRawText || JSON.stringify(result);
          } catch (err) {
            this.recordAgentStream({
              agentRole: "playTester",
              source: "orchestrator",
              streamKind: "stderr",
              content: `Play Tester failed: ${err instanceof Error ? err.message : String(err)}`,
              runId,
              epicId: epic.id
            });
            this.stopDevServer(devServer);
            return false;
          } finally {
            this.stopDevServer(devServer);
            this.recordAgentStream({
              agentRole: "playTester",
              source: "orchestrator",
              streamKind: "status",
              content: "Dev server stopped.",
              runId,
              epicId: epic.id
            });
          }

          const testerParsed = this.parsePlayTesterResult(testerRawText);

          if (!testerParsed) {
            this.recordAgentStream({
              agentRole: "playTester",
              source: "orchestrator",
              streamKind: "stderr",
              content: "Play Tester did not produce a valid FINAL_JSON. Treating as full failure.",
              runId,
              epicId: epic.id
            });
            return false;
          }

          this.recordAgentStream({
            agentRole: "playTester",
            source: "orchestrator",
            streamKind: "assistant",
            content: `Play Tester complete (attempt ${attempt}). ${testerParsed.summary.passed}/${testerParsed.summary.total} passed.`,
            runId,
            epicId: epic.id,
            done: true
          });

          if (testerParsed.status === "passed") {
            return true;
          }

          const failingTests = testerParsed.results.filter(r => r.status === "failed");
          previousFailures = failingTests;

          this.recordAgentStream({
            agentRole: "playTester",
            source: "orchestrator",
            streamKind: "stderr",
            content: `Attempt ${attempt}/${MAX_LOOP_ATTEMPTS}: ${failingTests.length} test(s) failed:\n` +
              failingTests.map(f => `  - ${f.testName} in ${f.testFile}: ${f.error}`).join("\n"),
            runId,
            epicId: epic.id
          });

          if (attempt >= MAX_LOOP_ATTEMPTS) {
            const failureSummary = failingTests
              .map(f => `${f.testName} (${f.testFile}): ${f.error}`)
              .join("\n");

            this.recordAgentStream({
              agentRole: "playTester",
              source: "orchestrator",
              streamKind: "stderr",
              content: `Exhausted ${MAX_LOOP_ATTEMPTS} Play Tester attempts. Escalating epic.\n\nFailing tests:\n${failureSummary}`,
              runId,
              epicId: epic.id,
              done: true
            });
            return false;
          }

          // === REFEEP: Feed failures back to Epic Decoder for re-decomposition ===
          const failureContext = [
            `## Playwright Test Failures (Attempt ${attempt})`,
            "",
            "The following tests were generated for this epic and are now failing.",
            "You must decompose new tickets to fix ONLY these failing tests.",
            "Do not change tickets that are already working.",
            "",
            "## Failing Tests",
            ...failingTests.map(f => [
              `### ${f.testName}`,
              `**File:** ${f.testFile}`,
              `**Error:** ${f.error}`,
              `**Steps executed before failure:** ${f.steps}`,
            ].join("\n")),
            "",
            "## Instructions for Re-Decomposition",
            "Create tickets that fix the root cause of each failing test.",
            "Each ticket should fix exactly one failing test.",
            "Do not create tickets for tests that already pass.",
            "The test files themselves should generally NOT be changed — fix the app code instead.",
            "Only change a test file if the test itself is wrong (e.g. wrong selector, wrong URL).",
          ].join("\n");

          this.recordAgentStream({
            agentRole: "epicDecoder",
            source: "orchestrator",
            streamKind: "status",
            content: `Re-feeding ${failingTests.length} failures into Epic Decoder for attempt ${attempt + 1}...`,
            runId,
            epicId: epic.id
          });

          // 1. Call Epic Decoder with failure context
          const epicWithFailure: EpicRecord = {
            ...epic,
            goalText: `${epic.goalText}\n\n${failureContext}`
          };

          const decomposition = await this.callbacks.runEpicDecoder(epicWithFailure, runId);

          if (!decomposition.tickets || decomposition.tickets.length === 0) {
            this.recordAgentStream({
              agentRole: "epicDecoder",
              source: "orchestrator",
              streamKind: "stderr",
              content: "Epic Decoder returned no tickets for the failure context. Escalating.",
              runId,
              epicId: epic.id
            });
            return false;
          }

          // 2. Create repair tickets in DB
          const repairTickets: TicketRecord[] = [];
          for (const ticketPlan of decomposition.tickets) {
            const repairId = `${ticketPlan.id}-REPAIR-${Date.now()}`;
            const ticket = this.db.createTicket({
              id: repairId,
              epicId: epic.id,
              title: ticketPlan.title,
              description: ticketPlan.description,
              acceptanceCriteria: ticketPlan.acceptanceCriteria ?? [],
              dependencies: [],
              allowedPaths: ticketPlan.allowedPaths ?? ["src/"],
              priority: ticketPlan.priority ?? "high",
              status: "queued",
              metadata: { isRepairTicket: true, sourceTicketId: repairId }
            });
            repairTickets.push(ticket);
          }

          this.recordAgentStream({
            agentRole: "epicDecoder",
            source: "orchestrator",
            streamKind: "assistant",
            content: `Re-decomposition created ${repairTickets.length} repair ticket(s): ${repairTickets.map(t => t.id).join(", ")}`,
            runId,
            epicId: epic.id,
            done: true
          });

          // 3. Execute repair tickets (build + review)
          await this.callbacks.executeTickets(epic, repairTickets, runId);

          // 4. Run Epic Reviewer again
          await this.callbacks.runEpicReview(epic, [...tickets, ...repairTickets], runId);

          // Update current tickets for next iteration
          currentTickets = [...tickets, ...repairTickets];

          // Loop continues - will run Play Writer again, then Play Tester
        }

        return true;
      } finally {
        await cleanupWorkspace();
      }
    });
  }
}
