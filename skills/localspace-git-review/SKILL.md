---
name: localspace-git-review
description: Use when reviewing changes, preparing a commit, checking Git state, or explaining what changed in a LocalSpace task.
---

# LocalSpace Git Review

Use this skill when the user asks for Git state, diff review, commit preparation, or task completion reporting.

## Workflow

1. Use `changes` for a human-readable summary of current modifications.
2. Use dedicated Git tools or `exec_command` for precise status, log, or commit operations when needed.
3. Before committing, confirm validation has passed or explicitly record skipped validation.
4. Use concise conventional commit messages when the project already follows that style.
5. After committing, verify `git status` and recent log.

## Reporting

Separate committed work, uncommitted work, validation results, and known issues. Do not say the tree is clean unless `git status` confirms it.

