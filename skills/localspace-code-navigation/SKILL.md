---
name: localspace-code-navigation
description: Use when exploring an unfamiliar LocalSpace workspace, finding symbols, tracing references, or deciding which inspection tool to use.
---

# LocalSpace Code Navigation

Use this skill when the task is primarily about understanding code before changing it.

## Tool selection

- Use `workspace_info` for branch, package metadata, scripts, and recent Git context.
- Use `project_map` for a bounded directory overview.
- Use `code_map` for entrypoints, project tree, exported symbols, and import/export relationships.
- Use `symbols` when looking for declarations by name or kind.
- Use `references` when tracing usage sites of a symbol.
- Use `grep` for exact text, configuration keys, comments, docs, and non-TypeScript files.
- Use `read` for one specific file, an image, or the first read of a Skill's `SKILL.md`.
- Use `read_many` when navigation has already identified several concrete text files; do not use it for broad discovery.

## Practice

Start broad only when the project is unfamiliar. Once likely files or symbols are identified, switch to focused reads and searches. Batch only independent known files; read a Skill's `SKILL.md` before batching any supporting files from that Skill. Do not scan generated folders unless the user explicitly asks.

