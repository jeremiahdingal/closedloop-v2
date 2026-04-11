# Tool: web_search

Use for:
- Searching the web for current information
- Finding documentation for libraries not in the codebase
- Troubleshooting errors using external resources

Avoid when:
- The information is available within the repo

Arguments:
- query: string
- count: number (optional, default 5)

Returns:
- List of search results with titles, URLs, and snippets

Example:
{"tool_name":"web_search","arguments":{"query":"React 19 breaking changes"}}
