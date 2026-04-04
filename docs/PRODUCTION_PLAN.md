# Production Hardening Checklist

This repository already includes the major backend changes requested:

- real worktree isolation
- SQLite persistence
- leases and stale-run recovery
- typed bridge commands
- artifacts and audit logs
- queue/worker separation
- deterministic context packets
- doctor/recovery classification

## Next backend steps after this starter

1. Replace `DryRunGateway` in the worker with a real `OllamaGateway` or remote router.
2. Add authenticated API endpoints and job control.
3. Add PR creation and branch merge policies.
4. Add command sandboxes or containerized execution if you need stronger safety.
5. Add richer workspace cleanup and retention jobs.
6. Expand test coverage for parallel execution and cancellation.
