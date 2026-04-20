import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { nowIso } from "../utils.ts";
import type {
  DirectChatMessageRecord,
  DirectChatSessionRecord,
  EpicRecord,
  Json,
  RunRecord,
  RunStatus,
  TicketRecord,
  TicketStatus,
  WorkspaceRecord
} from "../types.ts";

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
}

export class AppDatabase {
  readonly db: DatabaseSync;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    const journalModeRow = this.db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string } | undefined;
    if (String(journalModeRow?.journal_mode || "").toLowerCase() !== "wal") {
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (!message.includes("database is locked")) {
          throw error;
        }
      }
    }
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.ensureSchema();
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS epics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal_text TEXT NOT NULL,
        target_dir TEXT NOT NULL,
        target_branch TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    
    try {
      this.db.exec(`ALTER TABLE epics ADD COLUMN target_branch TEXT`);
    } catch {
      // Column may already exist
    }

    try {
      this.db.exec(`ALTER TABLE tickets ADD COLUMN diff_files_json TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE tickets ADD COLUMN pr_url TEXT`);
    } catch {
      // Column already exists
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        allowed_paths_json TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        current_run_id TEXT,
        current_node TEXT,
        last_heartbeat_at TEXT,
        last_message TEXT,
        diff_files_json TEXT,
        pr_url TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        epic_id TEXT,
        ticket_id TEXT,
        status TEXT NOT NULL,
        current_node TEXT,
        attempt INTEGER NOT NULL,
        heartbeat_at TEXT,
        last_message TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        head_commit TEXT,
        status TEXT NOT NULL,
        lease_owner TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        available_at TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        run_id TEXT,
        ticket_id TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS direct_chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        target_dir TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS direct_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES direct_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls_json TEXT,
        tool_results_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE(resource_type, resource_id)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        ticket_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        ticket_id TEXT,
        node_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        exit_code INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        stdout_path TEXT,
        stderr_path TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_available ON jobs(status, available_at);
      CREATE INDEX IF NOT EXISTS idx_runs_ticket_status ON runs(ticket_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_type, aggregate_id);
    `);

    // RAG tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_index_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_root TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(repo_root, commit_hash, model_name)
      );

      CREATE TABLE IF NOT EXISTS rag_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        index_id INTEGER NOT NULL REFERENCES rag_index_meta(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        chunk_type TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        token_estimate INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ast_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        index_id INTEGER NOT NULL REFERENCES rag_index_meta(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        symbol_kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        signature_text TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ast_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        index_id INTEGER NOT NULL REFERENCES rag_index_meta(id) ON DELETE CASCADE,
        source_file TEXT NOT NULL,
        target_file TEXT NOT NULL,
        dep_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rag_chunks_index_id ON rag_chunks(index_id);
      CREATE INDEX IF NOT EXISTS idx_rag_chunks_file_path ON rag_chunks(index_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_ast_edges_index_id ON ast_edges(index_id);
      CREATE INDEX IF NOT EXISTS idx_ast_edges_source ON ast_edges(index_id, source_file);
    `);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createEpic(epic: Omit<EpicRecord, "createdAt" | "updatedAt">): EpicRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO epics (id, title, goal_text, target_dir, target_branch, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(epic.id, epic.title, epic.goalText, epic.targetDir, epic.targetBranch, epic.status, now, now);
    return { ...epic, createdAt: now, updatedAt: now };
  }

  getEpic(id: string): EpicRecord | null {
    const row = this.db.prepare(`SELECT * FROM epics WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      goalText: row.goal_text,
      targetDir: row.target_dir,
      targetBranch: row.target_branch || null,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listEpics(options?: { limit?: number; offset?: number }): EpicRecord[] {
    if (options?.limit !== undefined) {
      return (this.db.prepare(`SELECT * FROM epics ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(options.limit, options.offset ?? 0) as any[]).map((row) => ({
        id: row.id,
        title: row.title,
        goalText: row.goal_text,
        targetDir: row.target_dir,
        targetBranch: row.target_branch || null,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    }
    return (this.db.prepare(`SELECT * FROM epics ORDER BY created_at DESC`).all() as any[]).map((row) => ({
      id: row.id,
      title: row.title,
      goalText: row.goal_text,
      targetDir: row.target_dir,
      targetBranch: row.target_branch || null,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  countEpics(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM epics`).get() as { count: number };
    return row.count;
  }

  updateEpicStatus(id: string, status: EpicRecord["status"]): void {
    this.db.prepare(`UPDATE epics SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), id);
  }

  deleteEpic(id: string): void {
    this.db.prepare(`DELETE FROM epics WHERE id = ?`).run(id);
  }

  createTicket(ticket: Omit<TicketRecord, "createdAt" | "updatedAt" | "currentRunId" | "currentNode" | "lastHeartbeatAt" | "lastMessage" | "diffFiles" | "prUrl"> & {
    currentRunId?: string | null;
    currentNode?: string | null;
    lastHeartbeatAt?: string | null;
    lastMessage?: string | null;
    diffFiles?: { path: string; additions: number; deletions: number }[];
    prUrl?: string | null;
  }): TicketRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO tickets (
        id, epic_id, title, description, acceptance_criteria_json, dependencies_json, allowed_paths_json,
        priority, status, current_run_id, current_node, last_heartbeat_at, last_message, diff_files_json, pr_url, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ticket.id,
      ticket.epicId,
      ticket.title,
      ticket.description,
      JSON.stringify(ticket.acceptanceCriteria),
      JSON.stringify(ticket.dependencies),
      JSON.stringify(ticket.allowedPaths),
      ticket.priority,
      ticket.status,
      ticket.currentRunId ?? null,
      ticket.currentNode ?? null,
      ticket.lastHeartbeatAt ?? null,
      ticket.lastMessage ?? null,
      ticket.diffFiles ? JSON.stringify(ticket.diffFiles) : null,
      ticket.prUrl ?? null,
      JSON.stringify(ticket.metadata),
      now,
      now
    );
    return {
      ...ticket,
      currentRunId: ticket.currentRunId ?? null,
      currentNode: ticket.currentNode ?? null,
      lastHeartbeatAt: ticket.lastHeartbeatAt ?? null,
      lastMessage: ticket.lastMessage ?? null,
      diffFiles: ticket.diffFiles ?? null,
      prUrl: ticket.prUrl ?? null,
      createdAt: now,
      updatedAt: now
    };
  }

  getTicket(id: string): TicketRecord | null {
    const row = this.db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as any;
    return row ? this.mapTicket(row) : null;
  }

  listTickets(epicId?: string): TicketRecord[] {
    const rows = epicId
      ? (this.db.prepare(`SELECT * FROM tickets WHERE epic_id = ? ORDER BY created_at ASC`).all(epicId) as any[])
      : (this.db.prepare(`SELECT * FROM tickets ORDER BY created_at DESC`).all() as any[]);
    return rows.map((row) => this.mapTicket(row));
  }

  updateTicketRunState(input: {
    ticketId: string;
    status?: TicketStatus;
    currentRunId?: string | null;
    currentNode?: string | null;
    lastHeartbeatAt?: string | null;
    lastMessage?: string | null;
    diffFiles?: { path: string; additions: number; deletions: number }[] | null;
    prUrl?: string | null;
  }): void {
    const current = this.getTicket(input.ticketId);
    if (!current) throw new Error(`Ticket not found: ${input.ticketId}`);
    this.db.prepare(`
      UPDATE tickets
      SET status = ?, current_run_id = ?, current_node = ?, last_heartbeat_at = ?, last_message = ?, diff_files_json = ?, pr_url = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.status ?? current.status,
      input.currentRunId ?? current.currentRunId,
      input.currentNode ?? current.currentNode,
      input.lastHeartbeatAt ?? current.lastHeartbeatAt,
      input.lastMessage ?? current.lastMessage,
      input.diffFiles !== undefined ? JSON.stringify(input.diffFiles) : current.diffFiles ? JSON.stringify(current.diffFiles) : null,
      input.prUrl !== undefined ? input.prUrl : current.prUrl,
      nowIso(),
      input.ticketId
    );
  }

  updateTicketAllowedPaths(ticketId: string, allowedPaths: string[]): void {
    this.db.prepare(`
      UPDATE tickets
      SET allowed_paths_json = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(allowedPaths), nowIso(), ticketId);
  }

  deleteTicket(id: string): void {
    this.db.prepare(`DELETE FROM tickets WHERE id = ?`).run(id);
  }

  createRun(run: Omit<RunRecord, "createdAt" | "updatedAt">): RunRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO runs (id, kind, epic_id, ticket_id, status, current_node, attempt, heartbeat_at, last_message, error_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.kind,
      run.epicId,
      run.ticketId,
      run.status,
      run.currentNode,
      run.attempt,
      run.heartbeatAt,
      run.lastMessage,
      run.errorText,
      now,
      now
    );
    return { ...run, createdAt: now, updatedAt: now };
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return this.mapRun(row);
  }

  listRuns(status?: RunStatus): RunRecord[] {
    const rows = status
      ? (this.db.prepare(`SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC`).all(status) as any[])
      : (this.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC`).all() as any[]);
    return rows.map((row) => this.mapRun(row));
  }

  listRunsForTicket(ticketId: string): RunRecord[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE ticket_id = ? ORDER BY created_at DESC`).all(ticketId) as any[]).map((row) => this.mapRun(row));
  }

  listRunsForEpic(epicId: string): RunRecord[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE epic_id = ? ORDER BY created_at DESC`).all(epicId) as any[]).map((row) => this.mapRun(row));
  }

  updateRun(input: {
    runId: string;
    status?: RunStatus;
    currentNode?: string | null;
    heartbeatAt?: string | null;
    lastMessage?: string | null;
    errorText?: string | null;
    attempt?: number;
  }): void {
    const current = this.getRun(input.runId);
    if (!current) throw new Error(`Run not found: ${input.runId}`);
    this.db.prepare(`
      UPDATE runs
      SET status = ?, current_node = ?, heartbeat_at = ?, last_message = ?, error_text = ?, attempt = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.status ?? current.status,
      input.currentNode ?? current.currentNode,
      input.heartbeatAt ?? current.heartbeatAt,
      input.lastMessage ?? current.lastMessage,
      input.errorText ?? current.errorText,
      input.attempt ?? current.attempt,
      nowIso(),
      input.runId
    );
  }

  deleteRun(runId: string): void {
    this.db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
  }

  createWorkspace(workspace: Omit<WorkspaceRecord, "createdAt" | "updatedAt">): WorkspaceRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO workspaces (id, ticket_id, run_id, repo_root, worktree_path, branch_name, base_commit, head_commit, status, lease_owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspace.id,
      workspace.ticketId,
      workspace.runId,
      workspace.repoRoot,
      workspace.worktreePath,
      workspace.branchName,
      workspace.baseCommit,
      workspace.headCommit,
      workspace.status,
      workspace.leaseOwner,
      now,
      now
    );
    return { ...workspace, createdAt: now, updatedAt: now };
  }

  getWorkspace(id: string): WorkspaceRecord | null {
    const row = this.db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(id) as any;
    return row ? this.mapWorkspace(row) : null;
  }

  findWorkspaceByRun(runId: string): WorkspaceRecord | null {
    const row = this.db.prepare(`SELECT * FROM workspaces WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`).get(runId) as any;
    return row ? this.mapWorkspace(row) : null;
  }

  findWorkspaceByWorktreePath(worktreePath: string): WorkspaceRecord | null {
    const row = this.db.prepare(`SELECT * FROM workspaces WHERE worktree_path = ? ORDER BY created_at DESC LIMIT 1`).get(worktreePath) as any;
    return row ? this.mapWorkspace(row) : null;
  }

  listArchivedWorkspacesOlderThan(cutoffIso: string): WorkspaceRecord[] {
    return (this.db.prepare(`
      SELECT * FROM workspaces
      WHERE status = 'archived' AND updated_at < ?
      ORDER BY updated_at ASC
    `).all(cutoffIso) as any[]).map((row) => this.mapWorkspace(row));
  }

  listOrphanedWorkspaces(cutoffIso: string): WorkspaceRecord[] {
    return (this.db.prepare(`
      SELECT * FROM workspaces
      WHERE status = 'active' AND updated_at < ?
      ORDER BY updated_at ASC
    `).all(cutoffIso) as any[]).map((row) => this.mapWorkspace(row));
  }

  listWorkspacesForTicket(ticketId: string): WorkspaceRecord[] {
    return (this.db.prepare(`
      SELECT * FROM workspaces
      WHERE ticket_id = ?
      ORDER BY created_at DESC
    `).all(ticketId) as any[]).map((row) => this.mapWorkspace(row));
  }

  deleteWorkspace(workspaceId: string): void {
    this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspaceId);
  }

  updateWorkspace(input: {
    workspaceId: string;
    headCommit?: string | null;
    status?: WorkspaceRecord["status"];
    leaseOwner?: string | null;
  }): void {
    const current = this.getWorkspace(input.workspaceId);
    if (!current) throw new Error(`Workspace not found: ${input.workspaceId}`);
    this.db.prepare(`
      UPDATE workspaces
      SET head_commit = ?, status = ?, lease_owner = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.headCommit ?? current.headCommit,
      input.status ?? current.status,
      input.leaseOwner ?? current.leaseOwner,
      nowIso(),
      input.workspaceId
    );
  }

  enqueueJob(kind: string, payload: Json, availableAt = nowIso()): string {
    const payloadRecord = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const runId = typeof payloadRecord?.runId === "string" ? payloadRecord.runId : null;
    if (runId) {
      const existing = this.db.prepare(`
        SELECT id FROM jobs
        WHERE kind = ?
          AND json_extract(payload_json, '$.runId') = ?
          AND status IN ('queued', 'running')
        ORDER BY created_at ASC
        LIMIT 1
      `).get(kind, runId) as { id?: string } | undefined;
      if (existing?.id) return existing.id;
    }
    const id = `job_${Math.random().toString(36).slice(2, 10)}`;
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO jobs (id, kind, payload_json, status, available_at, attempts, last_error, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, 0, NULL, ?, ?)
    `).run(id, kind, JSON.stringify(payload), availableAt, now, now);
    return id;
  }

  nextQueuedJob(): { id: string; kind: string; payload: Json; attempts: number } | null {
    return this.nextQueuedJobs(1)[0] ?? null;
  }

  nextQueuedJobs(n: number): { id: string; kind: string; payload: Json; attempts: number }[] {
    const rows = this.db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'queued' AND available_at <= ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(nowIso(), n) as any[];
    if (rows.length === 0) return [];
    const now = nowIso();
    for (const row of rows) {
      this.db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(now, row.id);
    }
    return rows.map(row => ({
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      attempts: row.attempts + 1
    }));
  }

  completeJob(id: string): void {
    this.db.prepare(`UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE id = ?`).run(nowIso(), id);
  }

  failJob(id: string, errorText: string, requeue = false, availableAt = nowIso()): void {
    this.db.prepare(`UPDATE jobs SET status = ?, last_error = ?, available_at = ?, updated_at = ? WHERE id = ?`)
      .run(requeue ? "queued" : "failed", errorText, availableAt, nowIso(), id);
  }

  listJobs(): Array<{ id: string; kind: string; status: string; attempts: number }> {
    return (this.db.prepare(`SELECT id, kind, status, attempts FROM jobs ORDER BY created_at DESC`).all() as any[]).map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts
    }));
  }

  listJobRecords(): Array<{ id: string; kind: string; status: string; attempts: number; payload: Json }> {
    return (this.db.prepare(`SELECT id, kind, status, attempts, payload_json FROM jobs ORDER BY created_at DESC`).all() as any[]).map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      payload: JSON.parse(row.payload_json)
    }));
  }

  deleteJob(id: string): void {
    this.db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
  }

  recordEvent(input: {
    aggregateType: string;
    aggregateId: string;
    runId?: string | null;
    ticketId?: string | null;
    kind: string;
    message: string;
    payload?: Json;
  }): void {
    this.db.prepare(`
      INSERT INTO events (aggregate_type, aggregate_id, run_id, ticket_id, kind, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.aggregateType,
      input.aggregateId,
      input.runId ?? null,
      input.ticketId ?? null,
      input.kind,
      input.message,
      input.payload ? JSON.stringify(input.payload) : null,
      nowIso()
    );
  }

  listEvents(limit = 200): Array<Record<string, unknown>> {
    return (this.db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>).map((row: any) => ({
      ...row,
      payload_json: row.payload_json,
      payload: row.payload_json ? JSON.parse(String(row.payload_json)) : null
    }));
  }

  listEventsAfterId(afterId = 0, options?: { kind?: string; runId?: string; ticketId?: string; limit?: number; newest?: boolean }): Array<Record<string, unknown>> {
    const limit = options?.limit ?? 200;
    const clauses = ['id > ?'];
    const params: any[] = [afterId];
    if (options?.kind) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    if (options?.runId) {
      clauses.push('run_id = ?');
      params.push(options.runId);
    }
    if (options?.ticketId) {
      clauses.push('ticket_id = ?');
      params.push(options.ticketId);
    }
    params.push(limit);
    let sql: string;
    if (options?.newest) {
      // Return the newest N events (subquery to reverse order)
      sql = `SELECT * FROM (SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
    } else {
      sql = `SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`;
    }
    return (this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map((row: any) => ({
      ...row,
      payload_json: row.payload_json,
      payload: row.payload_json ? JSON.parse(String(row.payload_json)) : null
    }));
  }

  listEventsForRun(runId: string, limit = 200): Array<Record<string, unknown>> {
    return (this.db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?`).all(runId, limit) as Array<Record<string, unknown>>).map((row: any) => ({
      ...row,
      payload_json: row.payload_json,
      payload: row.payload_json ? JSON.parse(String(row.payload_json)) : null
    }));
  }

  upsertLease(input: {
    resourceType: string;
    resourceId: string;
    owner: string;
    heartbeatAt: string;
    expiresAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO leases (resource_type, resource_id, owner, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(resource_type, resource_id)
      DO UPDATE SET owner = excluded.owner, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at
    `).run(input.resourceType, input.resourceId, input.owner, input.heartbeatAt, input.expiresAt);
  }

  getLease(resourceType: string, resourceId: string): { owner: string; heartbeatAt: string; expiresAt: string } | null {
    const row = this.db.prepare(`
      SELECT owner, heartbeat_at, expires_at FROM leases WHERE resource_type = ? AND resource_id = ?
    `).get(resourceType, resourceId) as any;
    if (!row) return null;
    return {
      owner: row.owner,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at
    };
  }

  deleteLease(resourceType: string, resourceId: string): void {
    this.db.prepare(`DELETE FROM leases WHERE resource_type = ? AND resource_id = ?`).run(resourceType, resourceId);
  }

  listExpiredLeases(now = nowIso()): Array<{ resourceType: string; resourceId: string; owner: string }> {
    return (this.db.prepare(`SELECT resource_type, resource_id, owner FROM leases WHERE expires_at < ?`).all(now) as any[]).map((row) => ({
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      owner: row.owner
    }));
  }

  addArtifact(input: {
    runId?: string | null;
    ticketId?: string | null;
    kind: string;
    name: string;
    path: string;
    checksum: string;
    bytes: number;
    metadata?: Json;
  }): void {
    this.db.prepare(`
      INSERT INTO artifacts (run_id, ticket_id, kind, name, path, checksum, bytes, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId ?? null,
      input.ticketId ?? null,
      input.kind,
      input.name,
      input.path,
      input.checksum,
      input.bytes,
      input.metadata ? JSON.stringify(input.metadata) : null,
      nowIso()
    );
  }

  listArtifacts(ticketId?: string): Array<Record<string, unknown>> {
    const rows = ticketId
      ? (this.db.prepare(`SELECT * FROM artifacts WHERE ticket_id = ? ORDER BY id DESC`).all(ticketId) as any[])
      : (this.db.prepare(`SELECT * FROM artifacts ORDER BY id DESC`).all() as any[]);
    return rows;
  }

  listArtifactsForRun(runId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT * FROM artifacts WHERE run_id = ? ORDER BY id DESC`).all(runId) as any[];
  }

  deleteArtifactsForTicket(ticketId: string): void {
    this.db.prepare(`DELETE FROM artifacts WHERE ticket_id = ?`).run(ticketId);
  }

  deleteArtifactsForRun(runId: string): void {
    this.db.prepare(`DELETE FROM artifacts WHERE run_id = ?`).run(runId);
  }

  addToolInvocation(input: {
    runId?: string | null;
    ticketId?: string | null;
    nodeName: string;
    toolName: string;
    input: Json;
    exitCode: number;
    durationMs: number;
    stdoutPath?: string | null;
    stderrPath?: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO tool_invocations (run_id, ticket_id, node_name, tool_name, input_json, exit_code, duration_ms, stdout_path, stderr_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId ?? null,
      input.ticketId ?? null,
      input.nodeName,
      input.toolName,
      JSON.stringify(input.input),
      input.exitCode,
      input.durationMs,
      input.stdoutPath ?? null,
      input.stderrPath ?? null,
      nowIso()
    );
  }

  deleteEventsForTicket(ticketId: string): void {
    this.db.prepare(`DELETE FROM events WHERE ticket_id = ? OR aggregate_id = ?`).run(ticketId, ticketId);
  }

  deleteEventsForEpic(epicId: string): void {
    this.db.prepare(`DELETE FROM events WHERE aggregate_id = ? OR (ticket_id IN (SELECT id FROM tickets WHERE epic_id = ?)) OR (run_id IN (SELECT id FROM runs WHERE epic_id = ?))`).run(epicId, epicId, epicId);
  }

  deleteEventsForRun(runId: string): void {
    this.db.prepare(`DELETE FROM events WHERE run_id = ?`).run(runId);
  }

  deleteToolInvocationsForTicket(ticketId: string): void {
    this.db.prepare(`DELETE FROM tool_invocations WHERE ticket_id = ?`).run(ticketId);
  }

  deleteToolInvocationsForRun(runId: string): void {
    this.db.prepare(`DELETE FROM tool_invocations WHERE run_id = ?`).run(runId);
  }

  mapTicket(row: any): TicketRecord {
    return {
      id: row.id,
      epicId: row.epic_id,
      title: row.title,
      description: row.description,
      acceptanceCriteria: parseJson(row.acceptance_criteria_json, []),
      dependencies: parseJson(row.dependencies_json, []),
      allowedPaths: parseJson(row.allowed_paths_json, []),
      priority: row.priority,
      status: row.status,
      currentRunId: row.current_run_id,
      currentNode: row.current_node,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastMessage: row.last_message,
      diffFiles: parseJson(row.diff_files_json, null),
      prUrl: row.pr_url || null,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  mapRun(row: any): RunRecord {
    return {
      id: row.id,
      kind: row.kind,
      epicId: row.epic_id,
      ticketId: row.ticket_id,
      status: row.status,
      currentNode: row.current_node,
      attempt: row.attempt,
      heartbeatAt: row.heartbeat_at,
      lastMessage: row.last_message,
      errorText: row.error_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  mapWorkspace(row: any): WorkspaceRecord {
    return {
      id: row.id,
      ticketId: row.ticket_id,
      runId: row.run_id,
      repoRoot: row.repo_root,
      worktreePath: row.worktree_path,
      branchName: row.branch_name,
      baseCommit: row.base_commit,
      headCommit: row.head_commit,
      status: row.status,
      leaseOwner: row.lease_owner,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // RAG Index Methods
  getRagIndex(
    repoRoot: string,
    commitHash: string,
    modelName: string
  ): { id: number; chunkCount: number } | null {
    const row = this.db.prepare(
      `SELECT id, chunk_count FROM rag_index_meta WHERE repo_root = ? AND commit_hash = ? AND model_name = ?`
    ).get(repoRoot, commitHash, modelName) as any;
    return row ? { id: row.id, chunkCount: row.chunk_count } : null;
  }

  getRagIndexByCommit(commitHash: string): { id: number; chunkCount: number } | null {
    const row = this.db.prepare(
      `SELECT id, chunk_count FROM rag_index_meta WHERE commit_hash = ? ORDER BY id DESC LIMIT 1`
    ).get(commitHash) as any;
    return row ? { id: row.id, chunkCount: row.chunk_count } : null;
  }


  createRagIndex(input: {
    repoRoot: string;
    commitHash: string;
    chunkCount: number;
    modelName: string;
  }): number {
    const result = this.db.prepare(
      `INSERT INTO rag_index_meta (repo_root, commit_hash, chunk_count, model_name, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(input.repoRoot, input.commitHash, input.chunkCount, input.modelName, nowIso()) as any;
    return result.lastInsertRowid as number;
  }

  insertRagChunks(
    indexId: number,
    chunks: Array<{
      filePath: string;
      chunkType: string;
      startLine?: number;
      endLine?: number;
      content: string;
      embedding: Buffer;
      tokenEstimate: number;
    }>
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO rag_chunks (index_id, file_path, chunk_type, start_line, end_line, content, embedding, token_estimate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const now = nowIso();
    for (const chunk of chunks) {
      stmt.run(
        indexId,
        chunk.filePath,
        chunk.chunkType,
        chunk.startLine ?? null,
        chunk.endLine ?? null,
        chunk.content,
        chunk.embedding,
        chunk.tokenEstimate,
        now
      );
    }
  }

  loadRagChunks(
    indexId: number,
    scopePaths?: string[]
  ): Array<{
    id: number;
    filePath: string;
    chunkType: string;
    content: string;
    embedding: Buffer;
    startLine?: number;
    endLine?: number;
    tokenEstimate: number;
  }> {
    const rows = this.db.prepare(
      `SELECT id, file_path, chunk_type, content, embedding, start_line, end_line, token_estimate
       FROM rag_chunks WHERE index_id = ?`
    ).all(indexId) as any[];

    let filtered = rows;
    if (scopePaths && scopePaths.length > 0) {
      filtered = rows.filter((row) =>
        scopePaths.some((p) => row.file_path.startsWith(p))
      );
    }

    return filtered.map((row) => ({
      id: row.id,
      filePath: row.file_path,
      chunkType: row.chunk_type,
      content: row.content,
      embedding: row.embedding,
      startLine: row.start_line,
      endLine: row.end_line,
      tokenEstimate: row.token_estimate,
    }));
  }

  deleteRagIndex(indexId: number): void {
    this.db.prepare(`DELETE FROM rag_index_meta WHERE id = ?`).run(indexId);
  }

  // AST Graph Methods
  insertAstNodes(
    indexId: number,
    nodes: Array<{
      filePath: string;
      symbolName: string;
      symbolKind: string;
      startLine: number;
      signatureText?: string;
    }>
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO ast_nodes (index_id, file_path, symbol_name, symbol_kind, start_line, signature_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const now = nowIso();
    for (const node of nodes) {
      stmt.run(indexId, node.filePath, node.symbolName, node.symbolKind, node.startLine, node.signatureText ?? null, now);
    }
  }

  insertAstEdges(
    indexId: number,
    edges: Array<{
      sourceFile: string;
      targetFile: string;
      depType: string;
    }>
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO ast_edges (index_id, source_file, target_file, dep_type, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    const now = nowIso();
    for (const edge of edges) {
      stmt.run(indexId, edge.sourceFile, edge.targetFile, edge.depType, now);
    }
  }

  loadAstEdgesForFile(
    indexId: number,
    filePath: string
  ): Array<{ sourceFile: string; targetFile: string; depType: string }> {
    return (
      this.db.prepare(
        `SELECT source_file, target_file, dep_type FROM ast_edges
         WHERE index_id = ? AND (source_file = ? OR target_file = ?)`
      ).all(indexId, filePath, filePath) as any[]
    ).map((r) => ({ sourceFile: r.source_file, targetFile: r.target_file, depType: r.dep_type }));
  }

  loadAstEdgesForIndex(
    indexId: number
  ): Array<{ sourceFile: string; targetFile: string; depType: string }> {
    return (
      this.db.prepare(
        `SELECT source_file, target_file, dep_type FROM ast_edges WHERE index_id = ?`
      ).all(indexId) as any[]
    ).map((r) => ({ sourceFile: r.source_file, targetFile: r.target_file, depType: r.dep_type }));
  }

  // Direct Chat Methods
  createDirectChatSession(session: Omit<DirectChatSessionRecord, "createdAt" | "updatedAt">): DirectChatSessionRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO direct_chat_sessions (id, title, target_dir, branch_name, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.title, session.targetDir, session.branchName, session.model, now, now);
    return { ...session, createdAt: now, updatedAt: now };
  }

  getDirectChatSession(id: string): DirectChatSessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM direct_chat_sessions WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      targetDir: row.target_dir,
      branchName: row.branch_name,
      model: row.model,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listDirectChatSessions(): DirectChatSessionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM direct_chat_sessions ORDER BY updated_at DESC`).all() as any[];
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      targetDir: row.target_dir,
      branchName: row.branch_name,
      model: row.model,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  appendDirectChatMessage(message: Omit<DirectChatMessageRecord, "id" | "createdAt">): DirectChatMessageRecord {
    const now = nowIso();
    const result = this.db.prepare(`
      INSERT INTO direct_chat_messages (session_id, role, content, tool_calls_json, tool_results_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(message.sessionId, message.role, message.content, message.toolCallsJson, message.toolResultsJson, now) as any;
    
    this.db.prepare(`UPDATE direct_chat_sessions SET updated_at = ? WHERE id = ?`).run(now, message.sessionId);
    
    return {
      id: Number(result.lastInsertRowid),
      ...message,
      createdAt: now
    };
  }

  listDirectChatMessages(sessionId: string): DirectChatMessageRecord[] {
    const rows = this.db.prepare(`SELECT * FROM direct_chat_messages WHERE session_id = ? ORDER BY id ASC`).all(sessionId) as any[];
    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role as any,
      content: row.content,
      toolCallsJson: row.tool_calls_json,
      toolResultsJson: row.tool_results_json,
      createdAt: row.created_at
    }));
  }

  deleteDirectChatSession(id: string): void {
    this.db.prepare(`DELETE FROM direct_chat_sessions WHERE id = ?`).run(id);
  }

  clearDirectChatMessages(sessionId: string): void {
    this.db.prepare(`DELETE FROM direct_chat_messages WHERE session_id = ?`).run(sessionId);
  }
}
