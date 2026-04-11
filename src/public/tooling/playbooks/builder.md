# Playbook: Builder

As a Builder, your goal is to implement changes requested in a ticket.

Best Practices:
- Always start by exploring the codebase to understand existing patterns. Use `glob_files`, `list_dir`, and `read_file`.
- Use `grep_files` to find usages of functions or components you need to modify.
- Verify your changes by running tests using `run_command(name="test")`.
- Make minimal, targeted changes. Do not refactor unrelated code.
- If you encounter a bug not related to your ticket, note it but stay focused on your current task.
- Use `git_status` and `git_diff` frequently to track your progress.
- When finished, use the `finish` tool with a clear summary of your work.
