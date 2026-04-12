# Project Structure

Generated from: C:\Users\dinga\Projects\langgraph-opencode-streaming-updated

## Styling And UI Rules
- Use global `styles.css` for layout and theming; no CSS-in-JS or utility frameworks.
- React components must be semantic and accessible.
- Agent logs and documentation are rendered via `react-markdown` with GFM support.
- Modals (`EpicModal`, `TicketModal`) handle state transitions and confirmations.
- Event streams (`AgentEventCard`) must be concise and non-blocking.

## Elements And Component Rules
- Modals are stateless regarding business logic; orchestration happens in `src/orchestration/`.
- Components in `frontend/src/components/` must export typed React components.
- Event cards display `AgentEvent` types from `src/types.ts`.
- Planning and Review modals must support interactive refinement before commit.
- All UI elements must respect the `PathPolicy` constraints defined in the backend.

## Review Contract
- Agent outputs must conform to Zod schemas defined in `src/orchestration/validation.ts`.
- Review nodes (`reviewer`, `tester`) must validate state transitions before finalizing.
- Failures are classified by `doctor` and `review-guard` before escalation.
- Generated artifacts are read-only to prevent agent tampering with source snapshots.

## REVIEW_CONTRACT
```json
{
  "schemaSources": [],
  "derivedSchemas": [],
  "generatedReadOnlyPaths": [],
  "folderOwnership": [],
  "strictFolderBoundaries": false
}
```

<!-- START_GENERATED_TREE -->
## Directory Tree

[DIR] .claude
  [FILE] settings.local.json
[DIR] .playwright-mcp
[DIR] .qwen
  [FILE] settings.json
  [FILE] settings.json.orig
[DIR] config
  [FILE] agent-models.json
  [FILE] workspace.json
[DIR] data
  [DIR] audit
    [FILE] workspace.log
  [DIR] project-structures
    [FILE] 135b6c293c30-PROJECT_STRUCTURE.rag.md
  [DIR] restart-logs
    [FILE] api.err.log
    [FILE] worker.err.log
  [DIR] runtime-logs
    [FILE] api.stderr.log
    [FILE] worker-run.log
    [FILE] worker-test.log
    [FILE] worker-test.stderr.log
    [FILE] worker.stderr.log
  [FILE] app.db
  [FILE] state.db
  [FILE] state.db-shm
  [FILE] state.db-wal
[DIR] docs
[DIR] frontend
  [DIR] assets
    [FILE] mario-bg.png
  [DIR] public
    [DIR] assets
    [FILE] mascot.html
    [FILE] mascot.svg
  [DIR] src
    [DIR] assets
      [FILE] background.svg
      [FILE] mascot.svg
    [DIR] components
      [FILE] AgentEventCard.tsx
      [FILE] AgentModal.tsx
      [FILE] DirectChatModal.tsx
      [FILE] EpicModal.tsx
      [FILE] PlanningModal.tsx
      [FILE] TicketModal.tsx
    [FILE] App.tsx
    [FILE] main.tsx
    [FILE] styles.css
    [FILE] types.ts
    [FILE] utils.ts
  [FILE] index.html
[DIR] src
  [DIR] __tests__
    [FILE] harness-live.test.ts
  [DIR] apps
    [FILE] api.ts
    [FILE] bootstrap.ts
    [FILE] check-db.ts
    [FILE] cleanup-workspaces.ts
    [FILE] demo.ts
    [FILE] gemma-harness-smoke.ts
    [FILE] gemma-tool-dictionary.ts
    [FILE] glm-tool-dictionary.ts
    [FILE] invoke-review.ts
    [FILE] seed.ts
    [FILE] test-epic.ts
    [FILE] worker.ts
    [FILE] write-project-structure.ts
  [DIR] bridge
    [FILE] audit.ts
    [FILE] context.ts
    [FILE] doctor.ts
    [FILE] gh.ts
    [FILE] git.ts
    [FILE] policies.ts
    [FILE] workspace-bridge.ts
  [DIR] db
    [FILE] database.ts
  [DIR] mediated-agent-harness
    [DIR] __tests__
      [FILE] compact-tool-contract.test.ts
      [FILE] loop.test.ts
      [FILE] repair-hint-retry.test.ts
      [FILE] stream-parser.test.ts
      [FILE] tools.test.ts
      [FILE] validator.test.ts
    [FILE] errors.ts
    [FILE] index.ts
    [FILE] loop.ts
    [FILE] prompts.ts
    [FILE] stream-parser.ts
    [FILE] tools.ts
    [FILE] types.ts
    [FILE] validator.ts
  [DIR] orchestration
    [DIR] __tests__
      [FILE] review-guard.test.ts
      [FILE] tooling-prompt-assembly.test.ts
    [FILE] codex.ts
    [FILE] gemini.ts
    [FILE] goal-runner.ts
    [FILE] langgraph-adapter.ts
    [FILE] langgraph-loader.ts
    [FILE] lifecycle.ts
    [FILE] models.ts
    [FILE] opencode.ts
    [FILE] plan-runner.ts
    [FILE] play-loop.ts
    [FILE] project-structure.ts
    [FILE] prompts.ts
    [FILE] qwen.ts
    [FILE] recovery.ts
    [FILE] review-guard.ts
    [FILE] ticket-runner.ts
    [FILE] validation.ts
  [DIR] public
    [DIR] tooling
      [DIR] playbooks
      [DIR] repair
      [DIR] toolcards
    [FILE] index.html
  [DIR] rag
    [DIR] __tests__
      [FILE] tooling-indexer.test.ts
      [FILE] tooling-retriever.test.ts
    [FILE] ast-parser.ts
    [FILE] embeddings.ts
    [FILE] indexer.ts
    [FILE] retriever.ts
  [FILE] config.ts
  [FILE] types.ts
  [FILE] utils.ts
[DIR] tests
  [FILE] codex.test.ts
  [FILE] goal-runner.test.ts
  [FILE] helpers.ts
  [FILE] mediated-harness-prompts.test.ts
  [FILE] mediated-harness-xml.test.ts
  [FILE] opencode.test.ts
  [FILE] recovery-and-api.test.ts
  [FILE] ticket-runner.test.ts
  [FILE] validation.test.ts
  [FILE] workspace-bridge.test.ts
[FILE] EPIC_TESTER_FIX.md
[FILE] MEDIATED_TOOLING_PLAN.md
[FILE] nodemon.json
[FILE] package-lock.json
[FILE] package.json
[FILE] playwright_sprint.md
[FILE] README.md
[FILE] tsconfig.json
[FILE] UsersdingaProjectslanggraph-opencode-streaming-updateddatastate.db
[FILE] UsersdingaProjectslanggraph-opencode-streaming-updateddatastate.db-shm
[FILE] UsersdingaProjectslanggraph-opencode-streaming-updateddatastate.db-wal
[FILE] validation2.txt
[FILE] vite.config.ts

## File Index

- .claude/settings.local.json
- .qwen/settings.json
- .qwen/settings.json.orig
- config/agent-models.json
- config/workspace.json
- data/app.db
- data/audit/workspace.log
- data/project-structures/135b6c293c30-PROJECT_STRUCTURE.rag.md
- data/restart-logs/api.err.log
- data/restart-logs/worker.err.log
- data/runtime-logs/api.stderr.log
- data/runtime-logs/worker-run.log
- data/runtime-logs/worker-test.log
- data/runtime-logs/worker-test.stderr.log
- data/runtime-logs/worker.stderr.log
- data/state.db
- data/state.db-shm
- data/state.db-wal
- EPIC_TESTER_FIX.md
- frontend/assets/mario-bg.png
- frontend/index.html
- frontend/public/mascot.html
- frontend/public/mascot.svg
- frontend/src/App.tsx
- frontend/src/assets/background.svg
- frontend/src/assets/mascot.svg
- frontend/src/components/AgentEventCard.tsx
- frontend/src/components/AgentModal.tsx
- frontend/src/components/DirectChatModal.tsx
- frontend/src/components/EpicModal.tsx
- frontend/src/components/PlanningModal.tsx
- frontend/src/components/TicketModal.tsx
- frontend/src/main.tsx
- frontend/src/styles.css
- frontend/src/types.ts
- frontend/src/utils.ts
- MEDIATED_TOOLING_PLAN.md
- nodemon.json
- package-lock.json
- package.json
- playwright_sprint.md
- README.md
- src/apps/api.ts
- src/apps/bootstrap.ts
- src/apps/check-db.ts
- src/apps/cleanup-workspaces.ts
- src/apps/demo.ts
- src/apps/gemma-harness-smoke.ts
- src/apps/gemma-tool-dictionary.ts
- src/apps/glm-tool-dictionary.ts
- src/apps/invoke-review.ts
- src/apps/seed.ts
- src/apps/test-epic.ts
- src/apps/worker.ts
- src/apps/write-project-structure.ts
- src/bridge/audit.ts
- src/bridge/context.ts
- src/bridge/doctor.ts
- src/bridge/gh.ts
- src/bridge/git.ts
- src/bridge/policies.ts
- src/bridge/workspace-bridge.ts
- src/config.ts
- src/db/database.ts
- src/mediated-agent-harness/errors.ts
- src/mediated-agent-harness/index.ts
- src/mediated-agent-harness/loop.ts
- src/mediated-agent-harness/prompts.ts
- src/mediated-agent-harness/stream-parser.ts
- src/mediated-agent-harness/tools.ts
- src/mediated-agent-harness/types.ts
- src/mediated-agent-harness/validator.ts
- src/mediated-agent-harness/__tests__/compact-tool-contract.test.ts
- src/mediated-agent-harness/__tests__/loop.test.ts
- src/mediated-agent-harness/__tests__/repair-hint-retry.test.ts
- src/mediated-agent-harness/__tests__/stream-parser.test.ts
- src/mediated-agent-harness/__tests__/tools.test.ts
- src/mediated-agent-harness/__tests__/validator.test.ts
- src/orchestration/codex.ts
- src/orchestration/gemini.ts
- src/orchestration/goal-runner.ts
- src/orchestration/langgraph-adapter.ts
- src/orchestration/langgraph-loader.ts
- src/orchestration/lifecycle.ts
- src/orchestration/models.ts
- src/orchestration/opencode.ts
- src/orchestration/plan-runner.ts
- src/orchestration/play-loop.ts
- src/orchestration/project-structure.ts
- src/orchestration/prompts.ts
- src/orchestration/qwen.ts
- src/orchestration/recovery.ts
- src/orchestration/review-guard.ts
- src/orchestration/ticket-runner.ts
- src/orchestration/validation.ts
- src/orchestration/__tests__/review-guard.test.ts
- src/orchestration/__tests__/tooling-prompt-assembly.test.ts
- src/public/index.html
- src/rag/ast-parser.ts
- src/rag/embeddings.ts
- src/rag/indexer.ts
- src/rag/retriever.ts
- src/rag/__tests__/tooling-indexer.test.ts
- src/rag/__tests__/tooling-retriever.test.ts
- src/types.ts
- src/utils.ts
- src/__tests__/harness-live.test.ts
- tests/codex.test.ts
- tests/goal-runner.test.ts
- tests/helpers.ts
- tests/mediated-harness-prompts.test.ts
- tests/mediated-harness-xml.test.ts
- tests/opencode.test.ts
- tests/recovery-and-api.test.ts
- tests/ticket-runner.test.ts
- tests/validation.test.ts
- tests/workspace-bridge.test.ts
- tsconfig.json
- UsersdingaProjectslanggraph-opencode-streaming-updateddatastate.db
- UsersdingaProjectslanggraph-opencode-streaming-updateddatastate.db-shm
- UsersdingaProjectslanggraph-opencode-streaming-updateddatastate.db-wal
- validation2.txt
- vite.config.ts

<!-- END_GENERATED_TREE -->
