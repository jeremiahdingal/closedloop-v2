# LangGraph Workflow Bridge

A production-oriented local-first orchestration starter for:

- **LangGraph-driven** goal -> tickets -> builder/reviewer/tester -> goal reviewer flows
- **SQLite-backed** epics, tickets, runs, events, jobs, artifacts, and tool audit logs
- **Real git worktrees** per ticket run
- **Typed bridge operations** for file writes, git, command execution, context packets, and recovery
- **Minimal React UI** for epics, tickets, runs, and live agent stream modals
- **OpenCode-backed** builder and goal reviewer nodes with real-time stream capture

## What actually uses LangGraph

After `npm install`, the main orchestration path uses real LangGraph graphs when `USE_LANGGRAPH` is not set to `0`.

- `src/orchestration/ticket-runner.ts` builds the ticket loop as a `StateGraph`
- `src/orchestration/goal-runner.ts` builds the goal/epic flow as a `StateGraph`
- `src/orchestration/models.ts` uses `ChatOllama.withStructuredOutput()` when the Ollama integration packages are installed

If LangGraph packages are unavailable, the project falls back to the legacy controller so tests can still run in constrained environments.

## Requirements

- Node 22+
- Git installed and available on `PATH`
- Ollama running locally for the non-OpenCode nodes (goal decomposer, reviewer, tester, doctor)
- OpenCode installed via this repo's npm dependencies and configured with a provider/model that can run in your environment


## OpenCode-backed nodes

The **builder** and **goal reviewer** nodes run through `opencode run` inside LangGraph-controlled nodes. LangGraph still owns shared state, retries, ticket routing, and checkpointed graph execution; OpenCode owns the repo-active coding session for those specific nodes.

The UI subscribes to `/api/agent-stream` and shows per-agent modal views for the live stream emitted by those OpenCode-backed nodes.

## Install

```bash
npm install
```

## Run tests

```bash
npm test
```

## Start the backend

Terminal 1:

```bash
npm run worker
```

Terminal 2:

```bash
npm run api
```

## Start the React UI

Terminal 3:

```bash
npm run ui
```

Open:

- React UI: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:4010`

To serve the built UI from the API server instead of Vite:

```bash
npm run build:ui
npm run api
```

Then open `http://127.0.0.1:4010`.

## Dry-run mode

Use dry-run mode when you want deterministic local tests without real model calls:

```bash
DRY_RUN=1 npm run worker
DRY_RUN=1 npm run api
```

## Important env vars

- `REPO_ROOT` — repo to operate on
- `DATA_DIR` — SQLite DB and artifacts location
- `OLLAMA_BASE_URL` — Ollama endpoint, defaults to `http://127.0.0.1:11434`
- `USE_LANGGRAPH=0` — disable LangGraph and use the legacy controller
- `DRY_RUN=1` — use the deterministic dry-run model gateway
- `TEST_COMMAND`, `LINT_COMMAND`, `TYPECHECK_COMMAND` — command policy overrides

## Notes

- The backend is the focus. The UI is intentionally small.
- The DB is still the source of truth for operational state; LangGraph owns workflow execution and step routing.
- The bridge keeps the repo/CLI/tooling surface under your control while LangGraph handles the orchestration layer.
