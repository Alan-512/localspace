---
name: localspace-code-review
description: Use when reviewing or auditing code, a Git diff, or a proposed change for correctness, compatibility, security, concurrency, tests, documentation, or unsupported claims.
---

# LocalSpace Code Review

Use this skill when the primary output is findings rather than an implementation.

## Workflow

1. Establish the review scope with project instructions, `git_status`, `git_diff`, `changes`, and recent commits.
2. Inspect affected callers and dependencies with `symbols`, `references`, `imports`, `grep`, `read`, or `read_many`; do not review the patch in isolation.
3. Check correctness, compatibility, security boundaries, input validation, error handling, lifecycle and concurrency, bounded output, and cross-platform behavior.
4. Verify that tests cover the changed failure modes and that documentation matches the implemented capability boundary.
5. Run focused validation only when it materially confirms or rejects a finding. Do not modify code unless the user also asked for fixes.
6. Report findings first, ordered by severity, with the affected path, evidence, impact, and a concrete remediation direction.

## Guardrails

- Prioritize defects and regressions over style preferences or speculative cleanup.
- Do not claim a test passed unless it was actually run against the reviewed state.
- Do not describe an unfinished or unvalidated capability as supported.
- If no blocking finding is found, say so and identify any remaining test or scope limitations.
