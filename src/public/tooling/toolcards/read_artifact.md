# Tool: read_artifact

Use for:
- Reading a previously saved artifact by name or kind
- Retrieving specific reports or documentation generated in earlier steps

Avoid when:
- You need current workspace files -> use read_file

Arguments:
- name: string (optional artifact name)
- kind: string (optional artifact kind)

Returns:
- Artifact content

Example:
{"tool_name":"read_artifact","arguments":{"name":"test-report"}}
