---
name: localspace-refactoring
description: Use when restructuring, renaming, moving, or consolidating code without intentionally changing externally observable behavior.
---

# LocalSpace Refactoring

Use this skill when behavior should remain stable while implementation structure changes.

## Workflow

1. Define the invariants, public API, data formats, configuration, and compatibility behavior that must remain unchanged.
2. Map declarations, references, imports, tests, documentation, and entrypoints before moving or renaming code.
3. Reuse existing abstractions and identify duplicate or obsolete implementations before creating new layers.
4. Apply small, reviewable patches. Introduce a temporary compatibility layer only when callers cannot migrate atomically.
5. Update tests and documentation in the same phase as the affected contract.
6. Remove deprecated paths only after every caller and compatibility requirement has been checked.
7. Run focused validation, then broader package checks; reject stale results when `workspaceChangedDuringRun` is true.
8. Review the final diff for accidental behavior changes, duplicated logic, and leftover dead code.

## Guardrails

- Do not disguise product behavior changes as refactoring.
- Do not combine unrelated cleanup that makes the behavioral diff harder to review.
- Preserve security checks, output bounds, structured schemas, and cross-platform behavior.
- Do not add personal absolute paths or project-specific assumptions to reusable code.
