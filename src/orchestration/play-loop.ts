import { readdir } from "node:fs/promises";
import { AppDatabase } from "../db/database.ts";
import { nowIso } from "../utils.ts";
import { playWriterPrompt, playWriterFixPrompt, playTesterPrompt } from "./prompts.ts";
import type { ModelGateway } from "./models.ts";
import type { AgentStreamPayload, EpicRecord, GoalDecomposition, GoalReview, TicketRecord } from "../types.ts";
import { TicketRunner } from "./ticket-runner.ts";
import { loadConfig } from "../config.ts";
import { LifecycleService } from "./lifecycle.ts";
import { WorkspaceBridge } from "../bridge/workspace-bridge.ts";
import { buildContextForQuery } from "../rag/context-builder.ts";
import { git } from "../bridge/git.ts";

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

type PlayWriterFixResult = {
  fixesApplied: string[];
  summary: string;
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
    if (e.streamKind === "stderr" || e.streamKind === "status") {
      console.error(`[${e.agentRole}] ${e.content}`);
    }
    this.db.recordEvent({
      aggregateType: e.ticketId ? "ticket" : "epic",
      aggregateId: e.ticketId ?? e.epicId ?? e.runId ?? "stream",
      runId: e.runId ?? null,
      ticketId: e.ticketId ?? null,
      kind: "agent_stream",
      message: `${e.agentRole}:${e.streamKind}`,
      payload: e as any
    });
  }

  private async listAllTestFiles(targetDir: string): Promise<string[]> {
    const testsDir = `${targetDir}/tests`;
    try {
      const entries = await readdir(testsDir);
      return entries
        .filter(f => f.endsWith(".spec.ts") || f.endsWith(".test.ts"))
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

  private parsePlayWriterFixResult(rawText: string): PlayWriterFixResult | null {
    const match = rawText.match(/<FINAL_JSON>([\s\S]*?)<\/FINAL_JSON>/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1].trim());
      return {
        fixesApplied: Array.isArray(parsed.fixesApplied) ? parsed.fixesApplied : [],
        summary: String(parsed.summary ?? "")
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
      const MAX_LOOP_ATTEMPTS = 10;
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
        const worktreePath = playWorkspace.worktreePath;

        // ── Phase 1: Play Writer (fix build + generate tests) ──
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

        const existingTestFiles = await this.listAllTestFiles(epic.targetDir);
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
        const playWriterModel = config.models.playWriter ?? "";
        const MAX_PLAYWRITER_STALL_RETRIES = 3;

        for (let stallAttempt = 0; stallAttempt < MAX_PLAYWRITER_STALL_RETRIES; stallAttempt++) {
          rawText = "";
          const isRetry = stallAttempt > 0;
          const currentPrompt = isRetry
            ? "COMPACTED RETRY after stall. Be concise — fix build errors and generate tests quickly.\n\n" +
              `Epic: ${epic.title}\nGoal: ${epic.goalText}\nTarget: ${worktreePath}\n` +
              (buildErrors ? `Build errors:\n${buildErrors}\n\n` : "") +
              "Fix build errors if any, then create Playwright e2e test files in tests/. Return <FINAL_JSON> with testsCreated, buildFixed, summary."
            : writerPrompt;

          if (isRetry) {
            this.recordAgentStream({
              agentRole: "playWriter",
              source: "orchestrator",
              streamKind: "status",
              content: `Play Writer stalled (attempt ${stallAttempt + 1}/${MAX_PLAYWRITER_STALL_RETRIES}). Compacting prompt and retrying...`,
              runId,
              epicId: epic.id
            });
          }

          try {
            if (playWriterModel.startsWith("zai:") || playWriterModel.startsWith("mediated:")) {
              const result = await this.withTimeout(
                this.gateway.runEpicDecoderInWorkspace!({
                  cwd: worktreePath,
                  prompt: currentPrompt,
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
              rawText = rawText || JSON.stringify(result);
            } else if (this.gateway.runEpicReviewerCodex) {
              const result = await this.withTimeout(
                this.gateway.runEpicReviewerCodex({
                  cwd: worktreePath,
                  prompt: currentPrompt,
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
              rawText = rawText || JSON.stringify(result);
            }
            break; // Success
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isTimeout = errMsg.includes("timed out");
            if (!isTimeout || stallAttempt >= MAX_PLAYWRITER_STALL_RETRIES - 1) {
              this.recordAgentStream({
                agentRole: "playWriter",
                source: "orchestrator",
                streamKind: "stderr",
                content: `Play Writer failed after ${stallAttempt + 1} attempts: ${errMsg}`,
                runId,
                epicId: epic.id
              });
              break;
            }
          }
        }

        const parsed = this.parsePlayWriterResult(rawText);
        const allTestFiles = await this.listAllTestFiles(worktreePath);

        if (allTestFiles.length === 0) {
          this.recordAgentStream({
            agentRole: "playWriter",
            source: "orchestrator",
            streamKind: "stderr",
            content: "No test files found in tests/ directory. Skipping Play Tester loop.",
            runId,
            epicId: epic.id
          });
          return true;
        }

        this.recordAgentStream({
          agentRole: "playWriter",
          source: "orchestrator",
          streamKind: "assistant",
          content: `Play Writer complete. Test files: ${allTestFiles.join(", ")}. ${parsed?.summary ?? ""}`,
          runId,
          epicId: epic.id,
          done: true
        });

        // ── Phase 2: Play Tester loop (run npx playwright test) ──
        let previousFailures: PlayTesterTestResult[] | undefined = undefined;

        for (let attempt = 1; attempt <= MAX_LOOP_ATTEMPTS; attempt++) {
          const previousFailuresJson = previousFailures && previousFailures.length > 0
            ? JSON.stringify(previousFailures, null, 2)
            : null;

          const testerPrompt = playTesterPrompt(
            { ...epic, targetDir: worktreePath },
            allTestFiles,
            config.playwrightDevServerUrl,
            config.playwrightDevServerCommand,
            attempt,
            previousFailuresJson
          );

          this.recordAgentStream({
            agentRole: "playTester",
            source: "orchestrator",
            streamKind: "status",
            content: `Play Tester started (attempt ${attempt}/${MAX_LOOP_ATTEMPTS}). Running npx playwright test...`,
            runId,
            epicId: epic.id
          });

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
            const errMsg = err instanceof Error ? err.message : String(err);
            this.recordAgentStream({
              agentRole: "playTester",
              source: "orchestrator",
              streamKind: "stderr",
              content: `Play Tester error (attempt ${attempt}/${MAX_LOOP_ATTEMPTS}): ${errMsg}`,
              runId,
              epicId: epic.id
            });
            // Treat as a synthetic failure so playWriter can fix it
            previousFailures = [{
              testFile: "playwright",
              testName: "Play Tester execution error",
              status: "failed",
              steps: 0,
              error: `${errMsg}\n\nRaw output:\n${testerRawText.slice(0, 3000)}`
            }];
          }

          const testerParsed = this.parsePlayTesterResult(testerRawText);

          if (!testerParsed && !previousFailures) {
            this.recordAgentStream({
              agentRole: "playTester",
              source: "orchestrator",
              streamKind: "stderr",
              content: `Play Tester did not produce FINAL_JSON (attempt ${attempt}/${MAX_LOOP_ATTEMPTS}). Feeding raw output to Play Writer.`,
              runId,
              epicId: epic.id
            });
            previousFailures = [{
              testFile: "playwright",
              testName: "Play Tester produced no parseable output",
              status: "failed",
              steps: 0,
              error: `No FINAL_JSON in output.\n\nRaw output:\n${testerRawText.slice(0, 3000)}`
            }];
          } else if (testerParsed) {
            this.recordAgentStream({
              agentRole: "playTester",
              source: "orchestrator",
              streamKind: "assistant",
              content: `Play Tester complete (attempt ${attempt}/${MAX_LOOP_ATTEMPTS}). ${testerParsed.summary.passed}/${testerParsed.summary.total} passed.`,
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
          }

          // ── Exhausted all attempts? ──
          if (attempt >= MAX_LOOP_ATTEMPTS) {
            const failureSummary = (previousFailures ?? [])
              .map(f => `${f.testName} (${f.testFile}): ${f.error}`)
              .join("\n");

            this.recordAgentStream({
              agentRole: "playTester",
              source: "orchestrator",
              streamKind: "stderr",
              content: `Exhausted ${MAX_LOOP_ATTEMPTS} Play Tester attempts. Escalating.\n\nFailing tests:\n${failureSummary}`,
              runId,
              epicId: epic.id,
              done: true
            });
            return false;
          }

          // ── Phase 3: Play Writer FIX mode — fix failing tests and commit ──
          const failuresToFix = previousFailures ?? [];
          this.recordAgentStream({
            agentRole: "playWriter",
            source: "orchestrator",
            streamKind: "status",
            content: `Feeding ${failuresToFix.length} failures to Play Writer (fix mode)...`,
            runId,
            epicId: epic.id
          });

          const fixPrompt = playWriterFixPrompt(
            { ...epic, targetDir: worktreePath },
            failuresToFix
          );

          let fixRawText = "";
          const MAX_FIX_STALL_RETRIES = 3;

          for (let fixStallAttempt = 0; fixStallAttempt < MAX_FIX_STALL_RETRIES; fixStallAttempt++) {
            fixRawText = "";
            const isFixRetry = fixStallAttempt > 0;
            const currentFixPrompt = isFixRetry
              ? "COMPACTED RETRY after stall. Be concise — fix the errors quickly.\n\n" +
                `Target: ${worktreePath}\n` +
                `Failing tests:\n${failuresToFix.map(f => `- ${f.testName} (${f.testFile}): ${f.error}`).join("\n")}\n\n` +
                "Fix the code, commit changes. Return <FINAL_JSON> with fixesApplied, summary."
              : fixPrompt;

            if (isFixRetry) {
              this.recordAgentStream({
                agentRole: "playWriter",
                source: "orchestrator",
                streamKind: "status",
                content: `Play Writer fix stalled (attempt ${fixStallAttempt + 1}/${MAX_FIX_STALL_RETRIES}). Compacting and retrying...`,
                runId,
                epicId: epic.id
              });
            }

            try {
              if (playWriterModel.startsWith("zai:") || playWriterModel.startsWith("mediated:")) {
                const result = await this.withTimeout(
                  this.gateway.runEpicDecoderInWorkspace!({
                    cwd: worktreePath,
                    prompt: currentFixPrompt,
                    runId,
                    epicId: epic.id,
                    onStream: (e: AgentStreamPayload) => {
                      this.recordAgentStream({ ...e, agentRole: "playWriter" });
                      fixRawText += e.content ?? "";
                    }
                  }),
                  this.epicReviewTimeoutMs,
                  "Play Writer fix timed out"
                );
                fixRawText = fixRawText || JSON.stringify(result);
              } else if (this.gateway.runEpicReviewerCodex) {
                const result = await this.withTimeout(
                  this.gateway.runEpicReviewerCodex({
                    cwd: worktreePath,
                    prompt: currentFixPrompt,
                    runId,
                    epicId: epic.id,
                    onStream: (e: AgentStreamPayload) => {
                      this.recordAgentStream({ ...e, agentRole: "playWriter" });
                      fixRawText += e.content ?? "";
                    }
                  }),
                  this.epicReviewTimeoutMs,
                  "Play Writer fix timed out"
                );
                fixRawText = fixRawText || JSON.stringify(result);
              }
              break; // Success
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              const isTimeout = errMsg.includes("timed out");
              if (!isTimeout || fixStallAttempt >= MAX_FIX_STALL_RETRIES - 1) {
                this.recordAgentStream({
                  agentRole: "playWriter",
                  source: "orchestrator",
                  streamKind: "stderr",
                  content: `Play Writer fix failed after ${fixStallAttempt + 1} attempts: ${errMsg}`,
                  runId,
                  epicId: epic.id
                });
                break;
              }
            }
          }

          const fixParsed = this.parsePlayWriterFixResult(fixRawText);
          this.recordAgentStream({
            agentRole: "playWriter",
            source: "orchestrator",
            streamKind: "assistant",
            content: `Play Writer fix complete (attempt ${attempt}). ${fixParsed?.summary ?? "No FINAL_JSON produced."}`,
            runId,
            epicId: epic.id,
            done: true
          });

          // Loop continues — playTester will re-run npx playwright test
        }

        return true;
      } finally {
        await cleanupWorkspace();
      }
    });
  }
}
