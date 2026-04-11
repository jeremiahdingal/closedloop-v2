# Tool: write_files

Use for:
- Applying changes across multiple files atomically
- Saving a batch of related updates

Avoid when:
- You only need to update one file -> use write_file

Arguments:
- files: { path: string, content: string }[]

Returns:
- Summary of written files

Example:
{"tool_name":"write_files","arguments":{"files":[{"path":"src/a.ts", "content":"..."}, {"path":"src/b.ts", "content":"..."}]}}
