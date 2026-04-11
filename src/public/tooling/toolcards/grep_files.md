# Tool: grep_files

Use for:
- Searching for text or regex patterns within file contents
- Finding usages of a function, variable, or string
- Identifying files containing specific logic

Avoid when:
- You only need to find a file by name -> use glob_files
- You know the file path and want to read it -> use read_file
- You want to find conceptually related code -> use semantic_search

Arguments:
- pattern: string (regex)
- scope: string (optional subdirectory, e.g., 'src/')

Returns:
- List of matches with file paths, line numbers, and content

Example:
{"tool_name":"grep_files","arguments":{"pattern":"export function.*Config","scope":"src/"}}
