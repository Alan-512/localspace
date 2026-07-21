---
name: localspace-debugging
description: Use when reproducing, diagnosing, or fixing a bug, failing test, crash, regression, or unexpected behavior in a LocalSpace workspace.
---

# LocalSpace Debugging

Use this skill when the root cause is not yet established.

## Workflow

1. Read project instructions and inspect `workspace_info`, recent commits, and relevant configuration.
2. Reproduce the problem with the smallest meaningful command or test. Preserve the exact error, inputs, and environment details.
3. Narrow the path with `grep`, `symbols`, `references`, `imports`, `read`, or `read_many` before editing.
4. Separate the visible symptom from the root cause. Check state, lifecycle, concurrency, platform, and recent-change boundaries when relevant.
5. Add or identify a focused failing regression test before the fix when practical.
6. Apply the smallest root-cause fix and remove code that is now genuinely obsolete.
7. Run focused validation first, then broader independent package checks with `run_checks` when appropriate.
8. Review the final diff and report residual risks, untested paths, or reproduction limits.

## Guardrails

- Do not hide failures by weakening tests, swallowing errors, or removing required behavior.
- Do not present a suspected cause as confirmed without supporting code, logs, or a reproducer.
- Do not use destructive cleanup as a debugging shortcut without explicit approval.
- When reproduction is impossible, state exactly what was verified and what remains uncertain.
