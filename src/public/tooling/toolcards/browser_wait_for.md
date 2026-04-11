# Tool: browser_wait_for

Use for:
- Waiting for specific text or an element to appear on the page
- Handling asynchronous UI updates

Arguments:
- text: string (text to wait for)
- selector: string (optional CSS selector)
- time: number (optional max wait time in seconds, default 10)

Returns:
- Success message

Example:
{"tool_name":"browser_wait_for","arguments":{"text":"Success!"}}
