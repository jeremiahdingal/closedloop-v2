# Tool: glob_files

Use for:
- Finding files matching a pattern
- Discovering file structure in a specific directory
- Searching for files by extension or name pattern

Avoid when:
- You know the exact path of the file -> use read_file
- You need to search inside file contents -> use grep_files
- You just need to see the contents of a directory -> use list_dir

Arguments:
- pattern: string (e.g., 'src/**/*.ts', 'tests/*.test.js')

Returns:
- List of matching file paths

Example:
{"tool_name":"glob_files","arguments":{"pattern":"src/**/*.ts"}}
