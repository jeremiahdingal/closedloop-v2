# Tool: semantic_search

Use for:
- Finding conceptually related code and documentation
- Natural language queries about the codebase
- When text-based grep is too restrictive

Avoid when:
- You know exactly what text pattern you are looking for -> use grep_files
- You know the file path -> use read_file

Arguments:
- query: string
- scope: string (optional)

Returns:
- List of relevant chunks with file paths and contents

Example:
{"tool_name":"semantic_search","arguments":{"query":"how does the RAG system index files?"}}
