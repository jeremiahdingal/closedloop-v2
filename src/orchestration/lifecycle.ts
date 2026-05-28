import { rm } from "node:fs/promises";
import { AppDatabase } from "../db/database.ts";
import { WorkspaceBridge } from "../bridge/workspace-bridge.ts";
import type { RunRecord, TicketRecord, WorkspaceRecord } from "../types.ts";
import { nowIso } from "../utils.ts";
import { git } from "../bridge/git.ts";

type CleanupSummary = {
  deletedRemoteBranches: string[];
  failedRemoteBranches: string[];
  activeRunIds: string[];
};

export class LifecycleService {
  private readonly db: AppDatabase;
  private readonly bridge: WorkspaceBridge;

  constructor(db: AppDatabase, bridge: WorkspaceBridge) {
    this.db = db;
    this.bridge = bridge;
  }

  async cancelTicket(ticketId: string): Promise<CleanupSummary> {
    const ticket = this.db.getTicket(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
    return this.cancelTicketRecord(ticket);
  }

  async deleteTicket(ticketId: string): Promise<CleanupSummary> {
    const ticket = this.db.getTicket(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const summary = await this.cancelTicketRecord(ticket);
    const runs = this.db.listRunsForTicket(ticket.id);
    await this.removeArtifactsForRuns(runs);
    await this.removeArtifactsForTicket(ticket.id);

    this.db.transaction(() => {
      for (const workspace of this.db.listWorkspacesForTicket(ticket.id)) {
        this.db.deleteLease("workspace", workspace.id);
        this.db.deleteWorkspace(workspace.id);
      }
      for (const run of runs) {
        this.db.deleteEventsForRun(run.id);
        this.db.deleteToolInvocationsForRun(run.id);
        this.db.deleteArtifactsForRun(run.id);
        this.db.deleteRun(run.id);
      }
      this.db.deleteToolInvocationsForTicket(ticket.id);
      this.db.deleteEventsForTicket(ticket.id);
      this.db.deleteArtifactsForTicket(ticket.id);
      this.deleteScopedJobs((payload) => payload.ticketId === ticket.id || Boolean(payload.runId && runs.some((run) => run.id === payload.runId)));
      this.db.deleteTicket(ticket.id);
    });

    return summary;
  }

  async cancelEpic(epicId: string): Promise<CleanupSummary> {
    const epic = this.db.getEpic(epicId);
    if (!epic) throw new Error(`Epic not found: ${epicId}`);

    this.db.updateEpicStatus(epic.id, "cancelled");
    
    // 1. Revert any changes in the target directory
    try {
      console.log(`[LIFECYCLE] Reverting changes in ${epic.targetDir} for epic ${epicId}...`);
      await git(epic.targetDir, ["reset", "--hard", "HEAD"]);
      await git(epic.targetDir, ["clean", "-fd"]);
    } catch (err) {
      console.warn(`[LIFECYCLE] Failed to revert changes in ${epic.targetDir}: ${err}`);
    }

    const tickets = this.db.listTickets(epic.id);
    const summaries = await Promise.all(tickets.map((ticket) => this.cancelTicketRecord(ticket)));
    const runs = this.db.listRunsForEpic(epic.id).filter((run) => !run.ticketId);
    const activeRunIds = runs.filter((run) => run.status === "queued" || run.status === "running" || run.status === "waiting").map((run) => run.id);
    for (const run of runs) {
      this.db.updateRun({
        runId: run.id,
        status: "cancelled",
        currentNode: "cancelled",
        heartbeatAt: nowIso(),
        lastMessage: `Epic cancelled at ${nowIso()}`,
        errorText: "Cancelled by user."
      });
    }
    this.deleteScopedJobs((payload) => payload.epicId === epic.id);
    this.db.recordEvent({
      aggregateType: "epic",
      aggregateId: epic.id,
      kind: "epic_cancelled",
      message: "Epic cancelled by user.",
      payload: { epicId: epic.id, activeRunIds }
    });

    return {
      deletedRemoteBranches: summaries.flatMap((item) => item.deletedRemoteBranches),
      failedRemoteBranches: summaries.flatMap((item) => item.failedRemoteBranches),
      activeRunIds: [...activeRunIds, ...summaries.flatMap((item) => item.activeRunIds)]
    };
  }

  async deleteEpic(epicId: string): Promise<CleanupSummary> {
    const epic = this.db.getEpic(epicId);
    if (!epic) throw new Error(`Epic not found: ${epicId}`);
    const tickets = this.db.listTickets(epic.id);
    const summary = await this.cancelEpic(epic.id);
    for (const ticket of tickets) {
      if (this.db.getTicket(ticket.id)) {
        await this.deleteTicket(ticket.id);
      }
    }

    const epicRuns = this.db.listRunsForEpic(epic.id).filter((run) => !run.ticketId);
    await this.removeArtifactsForRuns(epicRuns);
    this.db.transaction(() => {
      for (const run of epicRuns) {
        this.db.deleteEventsForRun(run.id);
        this.db.deleteToolInvocationsForRun(run.id);
        this.db.deleteArtifactsForRun(run.id);
        this.db.deleteRun(run.id);
      }
      this.deleteScopedJobs((payload) => payload.epicId === epic.id);
      this.db.deleteEventsForEpic(epic.id);
      this.db.deleteEpic(epic.id);
    });

    return summary;
  }

  async redecodeEpic(epicId: string): Promise<{ clearedTicketCount: number; clearedEpicRunCount: number }> {
    const epic = this.db.getEpic(epicId);
    if (!epic) throw new Error(`Epic not found: ${epicId}`);

    const tickets = this.db.listTickets(epic.id);
    for (const ticket of tickets) {
      if (this.db.getTicket(ticket.id)) {
        await this.deleteTicket(ticket.id);
      }
    }

    const epicRuns = this.db.listRunsForEpic(epic.id).filter((run) => !run.ticketId);
    await this.removeArtifactsForRuns(epicRuns);

    this.db.transaction(() => {
      for (const run of epicRuns) {
        this.db.deleteEventsForRun(run.id);
        this.db.deleteToolInvocationsForRun(run.id);
        this.db.deleteArtifactsForRun(run.id);
        this.db.deleteRun(run.id);
      }
      this.deleteScopedJobs((payload) => payload.epicId === epic.id);
      this.db.deleteEventsForEpic(epic.id);
      this.db.updateEpicPausedFromStatus(epic.id, null);
      this.db.updateEpicStatus(epic.id, "planning");
    });

    return { clearedTicketCount: tickets.length, clearedEpicRunCount: epicRuns.length };
  }

  isTicketCancelled(ticketId: string): boolean {
    const ticket = this.db.getTicket(ticketId);
    return !ticket || ticket.status === "cancelled";
  }

  isEpicCancelled(epicId: string): boolean {
    const epic = this.db.getEpic(epicId);
    return !epic || epic.status === "cancelled";
  }

  isEpicPaused(epicId: string): boolean {
    const epic = this.db.getEpic(epicId);
    return epic?.status === "paused";
  }

  async pauseEpic(epicId: string): Promise<void> {
    const epic = this.db.getEpic(epicId);
    if (!epic) throw new Error(`Epic not found: ${epicId}`);
    if (epic.status === "paused") throw new Error("Epic is already paused");
    if (["cancelled", "done", "failed"].includes(epic.status)) throw new Error(`Cannot pause epic in ${epic.status} status`);

    const previousStatus = epic.status;

    this.db.updateEpicPausedFromStatus(epicId, previousStatus);
    this.db.updateEpicStatus(epicId, "paused");

    const tickets = this.db.listTickets(epicId);
    for (const ticket of tickets) {
      const runs = this.db.listRunsForTicket(ticket.id);
      const activeRuns = runs.filter(r => r.status === "queued" || r.status === "running" || r.status === "waiting");
      for (const run of activeRuns) {
        this.db.updateRun({
          runId: run.id, status: "cancelled", currentNode: "paused",
          heartbeatAt: nowIso(), lastMessage: "Epic paused.", errorText: "Paused by user."
        });
      }
      if (["building", "reviewing", "testing"].includes(ticket.status)) {
        this.db.updateTicketRunState({
          ticketId: ticket.id, status: "queued", currentRunId: null, currentNode: null,
          lastHeartbeatAt: nowIso(), lastMessage: "Paused by user. Reset to queued."
        });
      }
    }

    const epicRuns = this.db.listRunsForEpic(epicId).filter(r => !r.ticketId);
    for (const run of epicRuns) {
      if (run.status === "queued" || run.status === "running" || run.status === "waiting") {
        this.db.updateRun({
          runId: run.id, status: "cancelled", currentNode: "paused",
          heartbeatAt: nowIso(), lastMessage: "Epic paused.", errorText: "Paused by user."
        });
      }
    }

    this.deleteScopedJobs((payload) => payload.epicId === epicId);

    this.db.recordEvent({
      aggregateType: "epic", aggregateId: epicId, kind: "epic_paused",
      message: "Epic paused by user.", payload: { epicId, previousStatus }
    });
  }

  async resumeEpic(epicId: string): Promise<string> {
    const epic = this.db.getEpic(epicId);
    if (!epic) throw new Error(`Epic not found: ${epicId}`);
    if (epic.status !== "paused") throw new Error(`Epic is not paused (status: ${epic.status})`);

    const targetStatus = epic.pausedFromStatus || (this.db.listTickets(epicId).length > 0 ? "executing" : "planning");
    this.db.updateEpicStatus(epicId, targetStatus);
    this.db.updateEpicPausedFromStatus(epicId, null);

    this.db.recordEvent({
      aggregateType: "epic", aggregateId: epicId, kind: "epic_resumed",
      message: `Epic resumed to ${targetStatus}.`, payload: { epicId, targetStatus }
    });

    return targetStatus;
  }

  private async cancelTicketRecord(ticket: TicketRecord): Promise<CleanupSummary> {
    this.db.updateTicketRunState({
      ticketId: ticket.id,
      status: "cancelled",
      currentNode: "cancelled",
      lastHeartbeatAt: nowIso(),
      lastMessage: "Ticket cancelled by user.",
      prUrl: null
    });
    const runs = this.db.listRunsForTicket(ticket.id);
    const activeRunIds = runs.filter((run) => run.status === "queued" || run.status === "running" || run.status === "waiting").map((run) => run.id);
    for (const run of runs) {
      this.db.updateRun({
        runId: run.id,
        status: "cancelled",
        currentNode: "cancelled",
        heartbeatAt: nowIso(),
        lastMessage: "Ticket cancelled by user.",
        errorText: "Cancelled by user."
      });
    }
    this.deleteScopedJobs((payload) => payload.ticketId === ticket.id || activeRunIds.includes(String(payload.runId ?? "")));

    const workspaces = this.db.listWorkspacesForTicket(ticket.id);
    const { deletedRemoteBranches, failedRemoteBranches } = await this.cleanupTicketBranchesAndWorkspaces(workspaces);

    this.db.recordEvent({
      aggregateType: "ticket",
      aggregateId: ticket.id,
      runId: ticket.currentRunId,
      ticketId: ticket.id,
      kind: "ticket_cancelled",
      message: "Ticket cancelled by user.",
      payload: { ticketId: ticket.id, activeRunIds, deletedRemoteBranches, failedRemoteBranches }
    });

    return { deletedRemoteBranches, failedRemoteBranches, activeRunIds };
  }

  private deleteScopedJobs(predicate: (payload: Record<string, unknown>) => boolean): void {
    for (const job of this.db.listJobRecords()) {
      if (predicate((job.payload ?? {}) as Record<string, unknown>)) {
        this.db.deleteJob(job.id);
      }
    }
  }

  private async cleanupTicketBranchesAndWorkspaces(workspaces: WorkspaceRecord[]): Promise<{ deletedRemoteBranches: string[]; failedRemoteBranches: string[] }> {
    const deletedRemoteBranches: string[] = [];
    const failedRemoteBranches: string[] = [];

    for (const workspace of workspaces) {
      const remoteDeleted = await this.deleteRemoteBranch(workspace);
      if (remoteDeleted === true) deletedRemoteBranches.push(workspace.branchName);
      if (remoteDeleted === false) failedRemoteBranches.push(workspace.branchName);

      await this.bridge.cleanupWorkspace(workspace.id, true).catch(async () => {
        // Only rm if it's a separate worktree directory, not the target repo itself
        if (workspace.worktreePath !== workspace.repoRoot) {
          await rm(workspace.worktreePath, { recursive: true, force: true }).catch(() => undefined);
        }
      });
    }

    return { deletedRemoteBranches, failedRemoteBranches };
  }

  private async deleteRemoteBranch(workspace: WorkspaceRecord): Promise<boolean | null> {
    try {
      await git(workspace.repoRoot, ["ls-remote", "--exit-code", "--heads", "origin", workspace.branchName]);
    } catch {
      return null;
    }

    try {
      await git(workspace.repoRoot, ["push", "origin", "--delete", workspace.branchName]);
      return true;
    } catch {
      return false;
    }
  }

  private async removeArtifactsForTicket(ticketId: string): Promise<void> {
    const artifacts = this.db.listArtifacts(ticketId);
    await Promise.all(artifacts.map((artifact) => this.removeArtifactPath(String((artifact as any).path ?? ""))));
  }

  private async removeArtifactsForRuns(runs: RunRecord[]): Promise<void> {
    for (const run of runs) {
      const artifacts = this.db.listArtifactsForRun(run.id);
      await Promise.all(artifacts.map((artifact) => this.removeArtifactPath(String((artifact as any).path ?? ""))));
    }
  }

  private async removeArtifactPath(filePath: string): Promise<void> {
    if (!filePath) return;
    await rm(filePath, { force: true }).catch(() => undefined);
  }
}
