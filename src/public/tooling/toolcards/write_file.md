# Tool: write_file

Use for:
- Creating a new file or overwriting an existing one
- Saving changes to the codebase

Avoid when:
- You need to update multiple files -> use write_files
- You only need to append or make a small change (if an edit tool were available, but here write_file is the primary way)

Arguments:
- path: string (relative to workspace root)
- content: string (full content of the file)

Returns:
- Success or error message

Example:
{"tool_name":"write_file","arguments":{"path":"src/new_helper.ts","content":"export const help = () => 'done';"}}
