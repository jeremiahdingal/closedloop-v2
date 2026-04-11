# Common Tool Call Errors and Repairs

## Malformed JSON
Error: The model output is not valid JSON or doesn't follow the tool call format.
Repair: Ensure you follow the exact format: `{"tool_name": "...", "arguments": {...}}`. Do not include any text before or after the JSON block.

## Missing Required Arguments
Error: A required argument for a tool is missing.
Repair: Check the tool's card for required arguments. For example, `read_file` requires `path`.

## Incorrect Argument Type
Error: An argument was provided with the wrong type (e.g., a string instead of an array).
Repair: Verify argument types in the tool card. `read_files` expects an array of strings in `paths`.

## Path Not Found
Error: The provided path does not exist in the workspace.
Repair: Use `list_dir` or `glob_files` to verify paths before calling tools that require a path. Remember paths should be relative to the workspace root.

## Tool Not Available
Error: The model tried to call a tool that is not available in the current session.
Repair: Only use tools listed in the "Available tools this run" section of the prompt.

## Permission Denied / Out of Scope
Error: Trying to access or modify files outside of `allowedPaths`.
Repair: Stay within the paths specified in your ticket. Use `list_dir` to see what's available within those paths.
