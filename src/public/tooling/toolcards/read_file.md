# Tool: read_file

Use for:
- Reading the full content of a single known file

Avoid when:
- You need to read multiple files -> use read_files
- You are looking for a file but don't know its path -> use glob_files or list_dir
- You only need to see if a file exists -> use list_dir or glob_files

Arguments:
- path: string (relative to workspace root)

Returns:
- File content as a string

Example:
{"tool_name":"read_file","arguments":{"path":"src/config.ts"}}
