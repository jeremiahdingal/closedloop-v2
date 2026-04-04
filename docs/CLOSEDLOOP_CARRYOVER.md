# ClosedLoop Learnings Applied

These ideas were carried forward from ClosedLoop into this starter:

- **Central bridge / control plane**: repo access, tool execution, artifacts, and context packets all flow through one bridge layer.
- **Pre-execution context**: every ticket run writes `.orchestrator/context.json` into the worktree.
- **Agent doctor**: repeated blockers, repeated test failures, and no-diff outputs route through a doctor decision path.
- **Diff discipline**: builder writes are validated against allowed paths and intended files.
- **Per-ticket locks**: workspaces use leases so only one active owner can mutate them.
- **Epic reconciliation**: the goal runner performs a final review after ticket execution.
- **Model routing**: role-specific model assignments live in `config/agent-models.json`.
