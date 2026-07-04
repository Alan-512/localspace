---
name: localspace-release
description: Use when preparing LocalSpace package metadata, dry-run packaging, release notes, or deployment/restart guidance.
---

# LocalSpace Release

Use this skill for release-oriented LocalSpace tasks.

## Checklist

1. Check package metadata and package file inclusion.
2. Run a package dry-run when packaging behavior changes.
3. Run typecheck, tests, and build before release-facing commits.
4. Verify docs match actual supported behavior.
5. Distinguish committed code from deployed/running service state.

## Important wording

- Say “implemented” only for code that exists and passed validation.
- Say “supported” only when runtime behavior, docs, and tests align.
- Say “requires restart/rebuild” when the running LocalSpace service may still be using an older build.

