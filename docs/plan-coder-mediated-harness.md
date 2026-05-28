# Plan: Coder in Mediated Harness (Read-Only, Output-Only)

## Goal
Move the Coder agent into the MediatedAgentHarness with explorer-only (read) tools, but keep it output-only — the coder produces a JSON edit plan, and the orchestration layer handles all file writing via the existing verifier.

## Current Flow
```
Explorer (9b, mediated harness, read-only tools)
  → explorerOutput (JSON with relevantFiles, recommendedFilesForCoding, etc.)
    → buildCanonicalEditPacket (reads files, builds SHA256 map)
      → Coder (30b, rawPrompt DIRECT call, NO tools, text-in/text-out)
        → coderOutput (JSON with operations[])
          → verifyAndApplyEdits (orchestration writes files)
```

## Proposed Flow
```
Explorer (9b, mediated harness, read-only tools)
  → explorerOutput (JSON)
    → buildCanonicalEditPacket (reads files, builds SHA256 map)
      → Coder (30b, mediated harness, read-only tools, prompt-injected edit packet + explorer output)
        → coderOutput (JSON with operations[])
          → verifyAndApplyEdits (orchestration writes files)
```

## Changes Required

### 1. New Role: "coder" in `harness/tools.ts`
- Add a `"coder"` case to `getAvailableToolsList()` returning explorer-equivalent read-only tools
- Coder gets: `explore_mode`, `read_file`, `read_files`, `glob_files`, `grep_files`, `list_dir`, `semantic_search`, `finish`
- Coder also gets `run_command` when `availableCommands` includes `"install"` (same pattern as explorer) — allows `npm install` for checking dependency resolution before planning edits
- Coder does NOT get: `write_file`, `write_files`, `remove_file`

### 2. New Prompt: `coderHarnessPrompt()` in `harness/prompts.ts`
- System prompt tells the coder it has read-only access but its job is to OUTPUT an edit plan
- **Inject the canonical edit packet + explorer output directly into the user prompt** (same as current `coderPrompt()` does — the entire edit packet JSON, explorer analysis, ticket, reviewer feedback all go into the prompt)
- The edit packet gives the coder:
  - All file contents (or excerpts for large files) — baseline context
  - SHA256 hashes — to reference in operations
  - `allowedPaths` — to constrain where it can edit
  - `destructivePermissions` — to know what's allowed
- The key addition: prompt tells the coder *"You have been given the edit packet below. You also have read-only file tools. USE THEM to verify file contents before writing search/replace blocks. The edit packet contents may be stale — always confirm with a live read."*
- Key prompt guidance: *"The explorer (lighter model) already identified relevant files and surface-level context. You are a stronger reasoning model. Focus on deep examination — type safety, edge cases, missing error handling, race conditions, subtle bugs. Then output your edit operations as a FINAL_JSON block."*

### 3. Update `getPromptForRole()` in `harness/prompts.ts`
- Add `case "coder":` pointing to the new `coderHarnessPrompt()`

### 4. New Gateway Method: `runCoderInWorkspace()` in `models.ts`
- Add alongside `runCoderDirect()` (keep direct as fallback — don't remove yet)
- Mirrors `runExplorerInWorkspace()` pattern:
  - Resolves coder model via `this.resolveHarnessModel("coder")`
  - Builds tool context with `this.buildToolContext(cwd, ticketId)` — no `install` commands
  - Instantiates `MediatedAgentHarness` with coder model (30b) and `"coder"` role
  - **The prompt is built from the same `coderPrompt()` function** — ticket, explorerOutput, editPacket, reviewerContext all serialized into the user prompt
  - Streams events (text, thinking, tool_call, tool_result) to frontend via `onStream` hooks
  - Returns raw text result containing the FINAL_JSON

### 5. Update `ticket-runner.ts` — `coderNode`
- Change from `this.gateway.runCoderDirect!()` → `this.gateway.runCoderInWorkspace!()`
- Pass `cwd: workspace.worktreePath` so the harness has filesystem access
- The prompt construction stays the same: `coderPrompt(ticket, state.explorerOutput, state.canonicalEditPacket, ...)`
- Output parsing stays the same: extract FINAL_JSON → `coderOutput` → `verifyAndApplyEdits`

### 6. Update `ModelGateway` interface in `models.ts`
- Add `runCoderInWorkspace?(input: { cwd: string; prompt: string; runId?; ticketId?; epicId?; onStream? })`
- Implement in `MediatedAgentHarnessGateway` (primary) and `OllamaGateway` (can fall back to direct)
- Keep `runCoderDirect?` on the interface for gateways that don't support workspace mode

### 7. Config Update: `agent-models.json`
- Change `"coder": "qwen3-coder:30b"` → `"coder": "mediated:qwen3-coder:30b"`
- The `"mediated:"` prefix signals the gateway to route through the harness

### 8. Update `loop.ts` — finish/convergence logic
- Add `"coder"` to `requiresExplicitFinish()` — coder must output FINAL_JSON and call finish
- Optionally add convergence nudges for coder (like explorer has at 60%/80% iterations)
- Coder should converge faster than explorer — suggest 3-5 tool calls max before outputting

## How the Edit Packet + Read Tools Work Together

The edit packet gives the coder a **pre-loaded snapshot** of all relevant files. The read tools let the coder **verify and extend** that snapshot:

1. **Edit packet provides**: file contents, SHA256 hashes, allowed paths, destructive permissions
2. **Read tools provide**: live verification — "does this file still match?", "let me read the import at the top", "what does this dependency function actually return?"
3. **The coder's advantage over current direct-call**: it can read files the edit packet *excluded* (dependencies, type definitions, test files) and verify the edit packet's SHA256 hashes are still current before planning operations

This means the coder gets the best of both worlds:
- **Pre-loaded context** (edit packet) → no wasted iterations reading files the explorer already found
- **Live verification** (read tools) → catches stale content, discovers additional context the explorer missed

## What Stays the Same
- Explorer (9b) — unchanged, same harness, same tools, same prompt
- `buildCanonicalEditPacket` — unchanged, still reads files, builds SHA256 map
- `coderPrompt()` function — unchanged, still serializes ticket + explorerOutput + editPacket + reviewerContext into text. This same function's output becomes the harness user prompt.
- `verifyAndApplyEdits` — unchanged, orchestration still owns ALL writes
- Coder output format — still `CoderOutput` JSON with `operations[]`
- Frontend streaming — same event shape, just richer (coder tool calls now visible)

## Key Benefits
1. Coder can read files to verify exact content before writing search/replace blocks → fewer failed edits
2. Coder can check SHA256 matches before planning → fewer stale operations
3. Coder can discover context the explorer missed (using its 30b reasoning) — type definitions, imports, tests
4. Coder can read files NOT in the edit packet (dependencies, sibling modules) for fuller context
5. All writes still go through verifier — no safety regression
6. Frontend gets visibility into coder's thinking (tool calls streamed live)
7. Edit packet prevents wasted iterations — coder has baseline context from the start

## Risk Mitigations
- Coder might waste iterations re-reading files explorer already found → edit packet pre-injected in prompt + explicit prompt instruction "the explorer already provided file contents below, only re-read if you suspect they're stale or need additional context"
- Coder might try to use write tools → role-based tool ACL in `loop.ts` blocks unauthorized tools
- Cost increase from 30b in harness vs direct → offset by fewer retry loops from bad search blocks and fewer failed verify cycles
- Edit packet might be large → already handled today (large files get excerpts, same approach carries over)
