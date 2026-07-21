---
name: localspace-validation
description: Use when choosing validation commands, interpreting test/build results, or deciding whether a LocalSpace task is complete.
---

# LocalSpace Validation

Use this skill before marking an implementation task complete.

## Workflow

1. Inspect package scripts with `workspace_info` or `read package.json`.
2. Prefer focused tests for the changed area when available.
3. Use `run_checks` when multiple exact `package.json` scripts can run as one bounded group. Use `exec_command` for one script, non-package checks, or custom commands.
4. Keep check concurrency conservative; only enable fail-fast when later checks are not useful after an earlier failure.
5. Run broader validation for shared logic, configuration, release, or workflow changes.
6. Include typecheck/build when TypeScript or packaged runtime behavior changed.
7. Report warnings separately from failures, and treat a result as stale when `workspaceChangedDuringRun` is true.

## Completion rule

A task is complete only when either validation passed, or the final report clearly states which validation could not be run and why.

