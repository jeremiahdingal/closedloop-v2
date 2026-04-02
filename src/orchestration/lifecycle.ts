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

  isTicketCancelled(ticketId: string): boolean {
    const ticket = this.db.getTicket(ticketId);
    return !ticket || ticket.status === "cancelled";
  }

  isEpicCancelled(epicId: string): boolean {
    const epic = this.db.getEpic(epicId);
    return !epic || epic.status === "cancelled";
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
        await rm(workspace.worktreePath, { recursive: true, force: true }).catch(() => undefined);
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
