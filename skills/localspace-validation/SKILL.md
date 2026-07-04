---
name: localspace-validation
description: Use when choosing validation commands, interpreting test/build results, or deciding whether a LocalSpace task is complete.
---

# LocalSpace Validation

Use this skill before marking an implementation task complete.

## Workflow

1. Inspect package scripts with `workspace_info` or `read package.json`.
2. Prefer focused tests for the changed area when available.
3. Run broader validation for shared logic, configuration, release, or workflow changes.
4. Include typecheck/build when TypeScript or packaged runtime behavior changed.
5. Report warnings separately from failures.

## Completion rule

A task is complete only when either validation passed, or the final report clearly states which validation could not be run and why.

