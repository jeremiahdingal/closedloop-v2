# Tool: finish

Use for:
- Signaling that the task is complete
- Providing the final result of the work

Avoid when:
- You still have tasks to perform

Arguments:
- summary: string
- result: string (JSON string matching expected output schema)

Returns:
- None (ends the session)

Example:
{"tool_name":"finish","arguments":{"summary":"Updated config", "result":"{\"status\":\"success\"}"}}
