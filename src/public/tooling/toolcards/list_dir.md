# Tool: list_dir

Use for:
- Listing files and subdirectories in a specific folder
- Exploring the immediate structure of a directory

Avoid when:
- You need to find files recursively -> use glob_files
- You know the exact path of a file and want its content -> use read_file

Arguments:
- path: string (relative to workspace root, defaults to root)

Returns:
- List of file and directory names in the specified path

Example:
{"tool_name":"list_dir","arguments":{"path":"src/orchestration"}}
