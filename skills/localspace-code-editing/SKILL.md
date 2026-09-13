---
name: localspace-code-editing
description: Use when modifying code in a LocalSpace workspace, especially before choosing between read, apply_patch, exec_command, and change review.
---

# LocalSpace Code Editing

Use this skill when the user asks you to change source code, configuration, tests, or documentation in a LocalSpace workspace.

## Workflow

1. Open the workspace once and reuse the returned `workspaceId`.
2. If the previous ChatGPT/client turn was interrupted, call `session_summary` before starting replacement work. Resume a matching recoverable process or check-group session with `write_stdin` instead of re-running the command. Completed sessions may still contain replayable output.
3. Inspect the existing architecture before editing. Prefer `read`, `grep`, `glob`, `ls`, `project_map`, or `code_map` over shell commands for file inspection.
4. Use `apply_patch` for targeted edits. Avoid broad rewrites unless the task requires them.
5. Run the smallest meaningful validation first, then broader validation if the change touches shared behavior.
6. Use `changes` or Git diff tools to review what changed before reporting completion.

## Guardrails

- Do not write hard-coded personal absolute paths into source or docs.
- Do not remove compatibility behavior unless the user explicitly approves the migration.
- Do not claim a capability is supported until code, docs, and validation agree.
- Prefer small, reviewable commits for completed phases.

