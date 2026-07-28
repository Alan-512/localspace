# LocalSpace 2.0 Migration

LocalSpace 2.0 makes two model-visible MCP response changes that are not
compatible with the published 1.0.6 contract. The major version records those
changes explicitly instead of silently replacing a 1.0.6 build.

## Structured result text

Successful structured tool responses expose human-readable compatibility text
through:

```text
structuredContent.result
```

The duplicate public field below has been removed:

```text
structuredContent.text
```

Consumers should read `result`. Tool errors are different: they return
`content`, `isError: true`, and `_meta.error`, but no `structuredContent`. This
avoids official MCP clients validating an error object against the tool's
success-only output schema.

## Workspace skills

`open_workspace.skills` is now a bounded detailed subset rather than the full
discovered skill list. It returns at most 12 entries:

- up to 8 project skills;
- four core LocalSpace workflow skills when available;
- unused detailed slots may be filled by other non-project skills.

All remaining model-visible skills are returned in `skillIndex` with their
name, path, and scope. Use these fields to reason about completeness:

- `skillsTotal`;
- `skillsReturned`;
- `skillsTruncated`.

Clients that previously treated `skills` as exhaustive must combine `skills`
and `skillIndex`.

## Server metadata

The MCP server implementation version is now loaded from `package.json`, so
`initialize` metadata and the published package version do not drift.
