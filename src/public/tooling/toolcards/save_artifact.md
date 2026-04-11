# Tool: save_artifact

Use for:
- Saving a named artifact to the workspace artifacts directory
- Storing intermediate results or reports

Avoid when:
- You are making a change to source code -> use write_file

Arguments:
- name: string
- content: string
- kind: string (optional)

Returns:
- Success message

Example:
{"tool_name":"save_artifact","arguments":{"name":"plan", "content":"...", "kind":"spec"}}
