# Tool: run_command

Use for:
- Running whitelisted commands like test, lint, typecheck
- Executing build or status scripts defined in the workspace

Avoid when:
- You can achieve the same with more specific tools like git_status
- The command is not whitelisted

Arguments:
- name: string (e.g., 'test', 'lint', 'typecheck')

Returns:
- Command output

Example:
{"tool_name":"run_command","arguments":{"name":"test"}}
