# Ticket Pipeline Flow

## Recent Fixes (branch: `fix/explorer-direct-tools`)

| Commit | Fix |
|--------|-----|
| `ebd6cd9` | Explorer direct tools + relaxed SHA256 verification |
| `8330b6c` | Disconnect builder from graph, route classify → finalize only |
| `fe25421` | Reviewer rejection loops back to explorer with feedback |
| `bed477a` | Fix route target: reviewer → explorer (not build_packet) |
| `87703be` | Reviewer context flows to explorer & coder; rich info packets on failure |
| `e750fdb` | Verify node handles repairable/partial success properly |

### Key Architecture Changes
- **Builder disconnected**: `retry_builder` removed from graph; doctor always escalates
- **Reviewer loop**: rejection → explorer (with `reviewBlockers` + `reviewSuggestions`) → build_packet → coder → verify
- **Build attempt cap**: max 3 attempts via `resolveMaxBuildAttempts`; on exhaustion → classify → finalize
- **Partial success**: verify node commits applied ops even on `repairable` outcome, only signals `noDiff` on complete failure
- **Relaxed SHA256**: verifier warns on hash mismatch but applies if search block text is found

### Remaining Cleanup (non-blocking)
- `src/types.ts`: `FailureDecision` union still includes `"retry_builder"`
- `src/orchestration/models.ts`: MockGateway still returns `"retry_builder"`
- Dead builder code in ticket-runner.ts (builderNode, runExistingLegacy, etc.)

---

## Graph Definition

```
START
  ↓
prepare_context
  - Load workspace, save TicketContextPacket
  ↓
explorer
  - Seed files via keyword glob from ticket description/title/acceptance criteria
  - Run explore_mode harness (glob, list_dir, read_file, read_files, grep_files, web_search)
  - Convergence guards: 85% iteration budget, file dedup, token threshold
  - Returns: explorerOutput (recommendedFilesForCoding, relevantFiles, analysis)
  ↓
build_packet
  - Build CanonicalEditPacket from explorerOutput + workspace files
  - allowedPaths = explorer files ∪ ticket paths (union, never narrows)
  - Returns: canonicalEditPacket
  ↓
coder
  - Run coderPrompt(ticket, explorerOutput, canonicalEditPacket)
  - Each operation must reference acceptance criterion via 'ac' field
  - Returns: coderOutput (search_replace, create_file, append_file operations)
  ↓
verify
  - verifyAndApplyEdits(ticket, coderOutput, editPacket, workspacePath)
  - Validates paths, SHA256 hashes, destructive operations
  - On success: git commit, get diff
  - On failure: noDiff=true, route to classify
  ↓
  ├─ accepted (has diff) → reviewer
  │     ↓
  │   reviewer
  │     - Review diff against acceptance criteria
  │     - Returns: approved/rejected + blockers
  │     ↓
  │   ├─ approved → tester
  │   │     ↓
  │   │   tester
  │   │     - Run tests
  │   │     ↓
  │   │   ├─ pass → finalize_success → END
  │   │   └─ fail → classify
  │   │
  │   └─ rejected → classify
  │
  └─ failed (no diff) → classify

classify
  - Doctor prompt decides: retry_builder / escalate / blocked
  - Has re-run awareness (if coder said "already satisfied", approve)
  ↓
  ├─ retry_builder → builder (mediated tooling fallback)
  │     ↓
  │   builder → reviewer → tester → ...
  │
  ├─ escalate → finalize_escalated → END
  │
  └─ max attempts → finalize_failed → END
```

## Graph Wiring (addNode / addEdge)

```
.addNode("prepare_context", prepareContext)
.addNode("explorer", explorerNode)
.addNode("build_packet", buildPacketNode)
.addNode("coder", coderNode)
.addNode("verify", verifyNode)
.addNode("builder", builderNode)
.addNode("reviewer", reviewerNode)
.addNode("tester", testerNode)
.addNode("classify", classifyNode)
.addNode("finalize_success", finalizeSuccess)
.addNode("finalize_escalated", finalizeEscalated)
.addNode("finalize_failed", finalizeFailed)
.addEdge(START, "prepare_context")
.addEdge("prepare_context", "explorer")
.addEdge("explorer", "build_packet")
.addEdge("build_packet", "coder")
.addEdge("coder", "verify")
.addConditionalEdges("verify",
  (state) => state.noDiff ? "classify" : "reviewer",
  ["classify", "reviewer"]
)
.addConditionalEdges("reviewer",
  (state) => state.reviewApproved ? "tester" : "classify",
  ["tester", "classify"]
)
.addConditionalEdges("tester",
  (state) => state.testPassed ? "finalize_success" : "classify",
  ["finalize_success", "classify"]
)
.addConditionalEdges("classify",
  (state) => {
    if (state.buildAttempts >= state.maxBuildAttempts) return "finalize_failed";
    if (["escalate", "blocked", "todo"].includes(state.failureDecision)) return "finalize_escalated";
    return "builder";
  },
  ["builder", "finalize_escalated", "finalize_failed"]
)
.addEdge("finalize_success", END)
.addEdge("finalize_escalated", END)
.addEdge("finalize_failed", END)
```

## State Fields (TicketGraphState)

```
runId: string
epicId: string
ticketId: string
workspaceId: string
buildAttempts: number (default 0)
maxBuildAttempts: number (default from ticket config)
intendedFiles: string[] (default [])
blockHistory: string[] (default [])
testHistory: string[] (default [])
reviewApproved: boolean (default false)
testPassed: boolean (default false)
noDiff: boolean (default false)
repeatedBlockers: boolean (default false)
repeatedTestFailure: boolean (default false)
failureReason: string (default "")
failureDecision: string (default "")
status: string (default "queued")
lastMessage: string (default "")
explorerOutput: ExplorerOutput | null
canonicalEditPacket: CanonicalEditPacket | null
coderOutput: CoderOutput | null
verificationResult: VerificationResult | null
diffFiles: string[] (default [])
prUrl: string (default "")
```

## Key Files

| File | Purpose |
|------|---------|
| `src/orchestration/ticket-runner.ts` | Graph definition, all node functions, pipeline orchestration |
| `src/orchestration/prompts.ts` | explorerPrompt, coderPrompt, reviewerPrompt, builderToolingPrompt, doctorPrompt |
| `src/orchestration/edit-packet.ts` | buildCanonicalEditPacket, allowedPaths union logic |
| `src/orchestration/verifier.ts` | verifyAndApplyEdits, path validation, SHA256, destructive guards |
| `src/orchestration/models.ts` | Gateway routing (Ollama, ZAI, Gemini, CLI), OllamaGateway, MediatedAgentHarnessGateway |
| `src/orchestration/langgraph-loader.ts` | Loads @langchain/langgraph + zod at runtime |
| `src/orchestration/ollama-memory-manager.ts` | Single-model loading, unload before switch |
| `src/orchestration/zai.ts` | Z AI runner (Anthropic-compatible API at api.z.ai) |
| `src/mediated-agent-harness/loop.ts` | Convergence guards (85% budget, dedup, token threshold) |
| `src/mediated-agent-harness/tools.ts` | explore_mode tool set, file dedup tracker |
| `src/mediated-agent-harness/validator.ts` | Stagnation detection, repeated call checking |
| `src/apps/bootstrap.ts` | OLLAMA_KEEP_ALIVE=0, OLLAMA_NUM_PARALLEL=1, ZAI_API_KEY |
| `src/apps/worker.ts` | Job queue loop, concurrency control |
| `src/apps/api.ts` | REST API, SWITCHABLE_ADAPTORS for model dropdowns |
| `src/db/database.ts` | SQLite persistence, ticket/run/event CRUD |

## Models

| Role | Default Model | Method |
|------|--------------|--------|
| Explorer | qwen3.5:9b | Mediated harness (explore_mode) |
| Coder | qwen3-coder:30b | Direct Ollama rawPrompt |
| Reviewer | Configurable | Mediated harness or ZAI |
| Builder fallback | Configurable | Mediated harness with tools |
| Doctor | Default Ollama | Direct Ollama rawPrompt |

## Gateway Routing (models.ts rawPrompt)

- `zai:` prefix → ZaiRunner (api.z.ai/api/anthropic/v1/messages)
- Everything else → OllamaGateway (localhost:11434/v1/chat/completions)

## Convergence Guards (loop.ts)

1. **File Dedup** — exploreModeReadFiles Set tracks read files, returns `[SKIPPED]` for re-reads
2. **Budget Halving** — at 85% of maxIterations, injects system message forcing `finish`
3. **Token Threshold** — after 85% mark, if estimated tokens > 70% of numCtx, forces finish

## Anti-Laziness Prompts

- **builderToolingPrompt**: Must make changes UNLESS all acceptance criteria verified with specific evidence
- **coderPrompt**: Must produce at least one operation. AC mapping via 'ac' field
- **doctorPrompt**: Re-run awareness — if coder justified "already satisfied", approve

## Memory Management

- `OLLAMA_KEEP_ALIVE=0` — models unload immediately after request
- `OLLAMA_NUM_PARALLEL=1` — one Ollama request at a time
- `ollama-memory-manager.ts` — tracks current model, unloads previous before loading new
- Integrated in: OllamaGateway.rawPrompt, all MediatedAgentHarnessGateway harness.run calls
