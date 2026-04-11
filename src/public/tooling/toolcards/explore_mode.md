# Tool: explore_mode

Use for:
- Batching multiple read-only tool calls in a single turn.
- Rapidly gathering context from multiple files or directories.
- Reducing overall turns and latency during the exploration phase.

## Usage

Provide an array of tool calls in the `calls` parameter. Each call must specify the `tool` name and its `args`.

Only read-only tools are allowed:
- `read_file`
- `read_files`
- `list_dir`
- `glob_files`
- `grep_files`
- `semantic_search`
- `git_status`
- `list_changed_files`

## Example

```xml
<function=explore_mode>
{
  "calls": [
    { "tool": "list_dir", "args": { "path": "src" } },
    { "tool": "read_file", "args": { "path": "package.json" } },
    { "tool": "glob_files", "args": { "pattern": "src/**/*.test.ts" } }
  ]
}
</function>
```

The output will be a concatenated string showing the results of each individual tool call.
