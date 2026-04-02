# Mediated Agent Harness

## Why

The current stack has OpenCode and Codex producing malformed tool calls —
invalid tool names, missing arguments, pseudo-tool output that isn't real
execution. Patching these issues ad-hoc hasn't worked. The mediated agent
harness replaces unreliable external tool execution with a local loop that
intercepts model tool calls, validates them, and executes them against the
workspace. The model server is any OpenAI-compatible local server (Ollama,
LM Studio, vLLM). The caller sees one method call; the multi-step tool loop
is hidden inside the harness.

## Key Design Decisions

- Local SSE parser owned by bridge (don't trust SDK for approximately-compatible servers)
- WorkspaceBridge wraps existing file/git/command logic — no duplication
- `finish` tool + validated final-text fallback as dual termination
- "Thinking" text is opportunistic, never required
- Ollama default with override via config
- Temperature 0 for tool calling accuracy

## Tool Surface

| Tool | Params | Backed By |
|---|---|---|
| glob_files | pattern | node:fs + PathPolicy |
| grep_files | pattern, scope? | child_process -> rg + PathPolicy |
| list_dir | path? | node:fs.readdir + PathPolicy |
| read_file | path | WorkspaceBridge.readFiles |
| read_files | paths[] | WorkspaceBridge.readFiles |
| write_file | path, content | WorkspaceBridge.writeFiles |
| write_files | files[] | WorkspaceBridge.writeFiles |
| git_diff | (none) | WorkspaceBridge.gitDiff (plain) |
| git_diff_staged | (none) | Direct git diff --staged |
| git_status | (none) | WorkspaceBridge.gitStatus |
| list_changed_files | (none) | Parse git diff --name-only |
| run_command | name | WorkspaceBridge.runNamedCommand (explicit CommandCatalog) |
| read_context_packet | (none) | readFile(context.json) |
| read_artifact | name?, kind? | DB lookup + readFile |
| save_artifact | name, content, kind? | WorkspaceBridge.saveArtifact |
| web_search | query, count? | Brave Search API (BRAVE_API_KEY in .env) |
| finish | summary, result | Terminal tool |

## Alias Remapping

ls -> glob_files
find -> glob_files
cat -> read_file
head -> read_file
tail -> read_file
touch -> write_file
bash/sh/shell/exec/run -> run_command
rm/cp/mv/npm/npx/node/python -> run_command
mkdir/tee/write/append/edit/create/update -> write_file
grep/search/rg -> grep_files
sed/awk/sort/wc/diff/git/delete -> run_command
walk/glob -> glob_files
tree/dir/ls_dir -> list_dir
search_web/brave/websearch/google -> web_search

## Stagnation Detection

- Same tool + same args 3x consecutively -> StagnationError
- 5 consecutive tool errors -> StagnationError
- No content change + no new files across 3 iterations -> StagnationError
- Iteration cap (default 25) -> StagnationError

## File Structure

```
src/mediated-agent-harness/
  index.ts              # createMediatedAgentHarness() — public entry point
  types.ts              # ToolDef, ToolCall, ToolResult, MediatedHarnessConfig, MediatedHarnessEvent, MediatedHarnessResult
  tools.ts              # Tool definitions (OpenAI format) + implementations
  validator.ts          # Alias remapping, arg normalization, PathPolicy, stagnation detection
  loop.ts               # The streaming tool-call loop engine
  stream-parser.ts      # Local SSE parser — own the parsing, handle approximately-compatible servers
  prompts.ts            # System prompts per role
  errors.ts             # MediatedHarnessError, ToolValidationError, StagnationError
  __tests__/
    stream-parser.test.ts
    validator.test.ts
    tools.test.ts
    loop.test.ts
```

## Integration

- config/agent-models.json: "mediated:qwen2.5-coder:32b" prefix
- models.ts: MediatedAgentHarnessGateway implements ModelGateway
- goal-runner.ts fallback: codex-cli -> mediated -> ollama (opencode optional)

## Public API

```typescript
import { createMediatedAgentHarness } from "./mediated-agent-harness";

const harness = createMediatedAgentHarness({
  baseURL: "http://localhost:11434/v1",
  model: "qwen2.5-coder:32b",
  braveApiKey: process.env.BRAVE_API_KEY,
  toolContext: { cwd, workspaceId, allowedPaths, readFiles, writeFiles, ... },
});

const result = await harness.run("epicDecoder", "Decompose this epic into tickets...");
```

## Implementation Status

Complete (57 unit tests passing, live-tested with qwen3-coder:30b and glm-4.7-flash):
- [x] types.ts, errors.ts
- [x] stream-parser.ts
- [x] tools.ts (17 tools), validator.ts
- [x] loop.ts (dual termination)
- [x] prompts.ts, index.ts
- [x] Unit tests (57 passing)
- [x] Argument type validation (validateArgTypes)
- [x] Expanded alias remapping (40+ aliases)
- [x] web_search via Brave Search API (.env: BRAVE_API_KEY)
- [x] Path blocking for .git and node_modules (cross-platform)
- [x] XML tool call extraction for qwen-style models (extractXmlToolCalls)
- [x] models.ts integration (MediatedAgentHarnessGateway)
- [x] goal-runner.ts integration (epicDecoder, epicReviewer)
- [x] ticket-runner.ts integration (builder role)

## Fallback Chains

**Epic Decoder / Epic Reviewer** (goal-runner.ts):
codex-cli -> opencode -> mediated -> ollama

**Builder** (ticket-runner.ts):
mediated -> opencode/codex -> plan mode (ollama)

## Activation

Set in config/agent-models.json:
```json
{
  "epicDecoder": "mediated:qwen3-coder:30b",
  "epicReviewer": "mediated:qwen3-coder:30b",
  "builder": "mediated:qwen3-coder:30b"
}
```

## Quick Test

```bash
node --experimental-strip-types src/__tests__/harness-live.test.ts qwen3-coder:30b "List the files in the config/ directory"
```
