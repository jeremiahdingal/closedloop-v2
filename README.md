# ClosedLoop Orchestrator

A local-first, production-oriented AI coding agent that decomposes goals into tickets, executes them in isolated git worktrees, and reviews the result — all driven by whatever model stack you have available.

---

## Architecture overview

```
                        ┌─────────────────────────────────┐
                        │          React UI (Vite)         │
                        │  epics · tickets · live streams  │
                        │       Plan Mode modal            │
                        └────────────┬────────────────────┘
                                     │ HTTP + SSE
                        ┌────────────▼────────────────────┐
                        │           API server             │
                        │  /api/epics  /api/tickets        │
                        │  /api/agent-stream (SSE)         │
                        │  /api/plan-session/*             │
                        └────────────┬────────────────────┘
                                     │
              ┌──────────────────────▼──────────────────────┐
              │                  Worker loop                  │
              │  polls job queue · acquires leases · routes  │
              └───┬────────────────────────┬────────────────┘
                  │                        │
      ┌───────────▼──────────┐  ┌──────────▼────────────────┐
      │      GoalRunner       │  │       TicketRunner         │
      │  epic decomposition   │  │  build → review → test     │
      │  ticket orchestration │  │  approve / fail / escalate │
      │  epic review          │  │  LangGraph StateGraph       │
      └───────────┬──────────┘  └──────────┬────────────────┘
                  │                        │
      ┌───────────▼────────────────────────▼────────────────┐
      │                   ModelGateway                        │
      │  mediated: · opencode: · codex-cli · qwen-cli · raw  │
      └──────────────────────────────────────────────────────┘
                  │
      ┌───────────▼──────────────────────────────────────────┐
      │               WorkspaceBridge                         │
      │  git worktrees · file ops · git/gh · PathPolicy       │
      │  context packets · audit logs · artifact store        │
      └───────────────────────────────────────────────────────┘
                  │
      ┌───────────▼──────────────────────────────────────────┐
      │                   SQLite (AppDatabase)                 │
      │  epics · tickets · runs · workspaces · events         │
      │  jobs · artifacts · rag_index · ast_nodes/edges       │
      └───────────────────────────────────────────────────────┘
```

---

## Key subsystems

### Orchestration (`src/orchestration/`)

| Module | Role |
|---|---|
| `goal-runner.ts` | Decomposes an epic into tickets via the **epicDecoder** model, orchestrates ticket execution, re-decomposes failed/escalated tickets, runs the final **epicReviewer** |
| `ticket-runner.ts` | LangGraph `StateGraph`: `prepare_context → builder → reviewer → tester → classify → finalize_*`. Retries failed nodes up to the attempt budget. |
| `models.ts` | `ModelGateway` — routes each agent role to the configured backend (see *Model routing* below). Wraps OpenCode, Codex, Qwen, Mediated harness, and raw Ollama. |
| `prompts.ts` | System prompts for every role: builder, reviewer, tester, epicDecoder, epicReviewer, doctor |
| `validation.ts` | Zod schemas for all structured outputs: `GoalDecomposition`, `GoalReview`, `BuilderPlan`, `ReviewerVerdict`, `FailureDecision` |
| `plan-runner.ts` | Runs the epicDecoder in interactive **Plan Mode** — streaming output to the UI without creating runs or DB records |
| `recovery.ts` | `RecoveryService`: expires stale leases, heals duplicate job queues, auto-requeues stale runs |
| `project-structure.ts` | Generates a `PROJECT_STRUCTURE.md` snapshot of the target repo (file tree, LOC, tech) used as decoder context |
| `opencode.ts` / `codex.ts` / `qwen.ts` | Thin wrappers that shell out to the respective CLI tools and stream back structured output |

### Mediated Agent Harness (`src/mediated-agent-harness/`)

A local tool-call loop that replaces unreliable external tool execution. The harness:

1. Calls the configured Ollama model with an OpenAI-compatible tool schema
2. Intercepts raw tool calls (JSON or XML), remaps 40+ shell-command aliases to canonical names
3. Validates arguments with `PathPolicy` (blocks writes outside allowed paths)
4. Executes the tool locally and feeds results back
5. Detects stagnation (same tool 3×, 5 consecutive errors, no content change, iteration cap)
6. Terminates on `finish` tool or validated final-text fallback

**17 tools**: `glob_files`, `grep_files`, `list_dir`, `read_file`, `write_file`, `git_diff`, `git_status`, `run_command`, `read_context_packet`, `read_artifact`, `save_artifact`, `web_search`, `finish`, and aliases.

### RAG + AST context (`src/rag/`)

| Module | Role |
|---|---|
| `indexer.ts` | Walks the target repo, chunks `.ts`/`.tsx` files, generates embeddings (local `@xenova/transformers`), runs an AST pass to extract imports/exports/signatures |
| `ast-parser.ts` | TypeScript compiler API — extracts `AstImport`, `AstExport`, `AstSignature` per file |
| `retriever.ts` | Cosine similarity over stored embeddings + AST-neighbour boost (direct import → +0.15, 2-hop → +0.05) |
| `context-builder.ts` | `buildContextForTicket()` and `buildContextForQuery()` — assemble `codeContext` + `docContext` blocks injected into builder, epicDecoder, and epicReviewer prompts |

### Bridge (`src/bridge/`)

| Module | Role |
|---|---|
| `workspace-bridge.ts` | Creates/archives git worktrees; resolves `baseRef`; exposes typed file/git/command ops |
| `git.ts` / `gh.ts` | `git()` and `gh()` subprocess wrappers |
| `policies.ts` | `PathPolicy` — enforces allowed-path lists per ticket; `CommandCatalog` maps role names to shell commands |
| `context.ts` | Writes `.orchestrator/context.json` into each worktree before agent execution |
| `doctor.ts` | `deterministicDoctor()` — classifies run failures (stagnation, blockers, test failures, no-diff) and returns a recovery decision |
| `audit.ts` | Appends timestamped entries to per-run audit files under `data/audit/` |

### Database (`src/db/database.ts`)

Single SQLite file (default `data/state.db`). Tables:

- `epics`, `tickets`, `runs`, `workspaces` — core domain
- `events` — append-only agent event log
- `jobs` — persistent job queue (kind: `run_ticket` | `run_epic` | `run_epic_review`)
- `leases` — optimistic concurrency locks on workspaces
- `artifacts` — binary/text artifacts per run (escalation reports, context dumps)
- `rag_index_meta`, `rag_chunks` — embedding index per commit hash
- `ast_nodes`, `ast_edges` — AST dependency graph

---

## Model routing

Each agent role is assigned a model in `config/agent-models.json`. Supported prefixes:

| Prefix | Backend |
|---|---|
| `mediated:<model>` | Local Ollama via the mediated harness (tool loop) |
| `opencode:<model>` | OpenCode CLI — workspace-aware coding session |
| `codex-cli` | ChatGPT API via the `codex` CLI |
| `qwen-cli` | Local Qwen CLI |
| *(bare name)* | Raw Ollama prompt (no tools) |

**Roles**: `builder`, `reviewer`, `tester`, `epicDecoder`, `epicReviewer`, `doctor`

The gateway tries each backend in the configured order and falls back through the chain on failure. Models can be swapped at runtime from the UI without restarting the worker.

---

## Plan Mode

The UI's **Plan Mode** lets you interactively refine a goal decomposition before committing it:

1. Fill in epic title, description, and optional target branch → **📐 Start Planning**
2. The epicDecoder streams its analysis into a live terminal (Phase 1)
3. When a valid `GoalDecomposition` is found, Phase 2 shows the structured plan (tickets, priorities, dependencies)
4. Send follow-up messages to refine the plan; the terminal resets for each re-run
5. **✅ Approve Plan** materialises the tickets and queues the epic run

The plan session is ephemeral (in-memory); nothing is written to the DB until approval.

---

## Stale-run recovery

The worker runs a recovery sweep on every poll cycle:

1. **Lease expiry** — removes leases held by crashed processes
2. **Queue healing** — drops duplicate jobs; resets orphaned `running` jobs to `queued`
3. **Stale runs** — any `running` run without a heartbeat for > `STALE_RUN_AFTER_MS` (default 3 min) is picked up by the Doctor:
   - Doctor reads recent `agent_stream` events and classifies the failure
   - Decision: `retry` (requeue), `blocked`, or `escalate` (mark failed)
   - Max `STALE_RUN_MAX_RECOVERIES` (default 3) attempts per run

---

## Requirements

- Node 22+
- Git on `PATH`
- Ollama running locally (or any OpenAI-compatible endpoint)
- OpenCode, Codex CLI, or Qwen CLI if using those backends

---

## Install

```bash
npm install
```

---

## Running

**Terminal 1 — worker**
```bash
npm run worker
```

**Terminal 2 — API server**
```bash
npm run api
```

**Terminal 3 — UI (dev)**
```bash
npm run ui
```

- React UI: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:4010`

To serve the built UI directly from the API server:
```bash
npm run build:ui && npm run api
# open http://127.0.0.1:4010
```

---

## Tests

```bash
npm test
```

Live integration test for the mediated harness (requires a running Ollama model):
```bash
node --experimental-strip-types src/__tests__/harness-live.test.ts qwen3-coder:30b "List files in config/"
```

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REPO_ROOT` | `process.cwd()` | Target repository the agents operate on |
| `DATA_DIR` | `./data` | SQLite DB, workspaces, artifacts, audit logs |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `API_PORT` | `4010` | API server port |
| `USE_LANGGRAPH` | `1` | Set to `0` to use the legacy controller |
| `DRY_RUN` | — | `1` = deterministic dry-run gateway (no real model calls) |
| `STALE_RUN_AFTER_MS` | `180000` | Heartbeat age before a run is considered stale |
| `STALE_RUN_MAX_RECOVERIES` | `3` | Max auto-recovery attempts per run |
| `TEST_COMMAND` | — | Override the default test command |
| `LINT_COMMAND` | — | Override the default lint command |
| `TYPECHECK_COMMAND` | — | Override the default typecheck command |
| `QWEN_CLI_MODEL` | — | Model passed to `qwen --model` |
