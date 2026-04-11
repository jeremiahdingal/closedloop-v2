# Tool: read_files

Use for:
- Reading multiple files in a single call to save tokens and time
- Getting context from several related files simultaneously

Avoid when:
- You only need one file -> use read_file
- You are not sure if the files exist -> use glob_files first

Arguments:
- paths: string[] (array of paths relative to workspace root)

Returns:
- Map of file paths to their contents

Example:
{"tool_name":"read_files","arguments":{"paths":["src/types.ts", "src/utils.ts"]}}
