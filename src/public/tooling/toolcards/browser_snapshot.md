# Tool: browser_snapshot

Use for:
- Capturing the HTML content of the current page or a specific element
- Verifying the state of the UI for assertions

Arguments:
- element: string (optional CSS selector)

Returns:
- HTML content (truncated if too large)

Example:
{"tool_name":"browser_snapshot","arguments":{"element":".results-list"}}
