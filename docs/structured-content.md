# Structured Content

LocalSpace tools preserve plain text output for simple MCP hosts and also expose
typed `structuredContent` fields for model and UI consumers.

Every structured tool keeps this compatibility field:

| Field | Meaning |
| --- | --- |
| `result` | Human-readable result text. This is the stable compatibility field. |
| `text` | Same text as `result`, included by typed data producers. |

## Code navigation and project orientation

| Tool | Structured fields |
| --- | --- |
| `symbols` | `summary`, `symbols[]` |
| `imports` | `summary`, `entries[]` |
| `references` | `summary`, `references[]` |
| `entrypoints` | `packageInfo`, `scripts[]`, `suggestedVerification[]`, `sourceEntrypoints[]`, `configFiles[]` |
| `code_map` | `scope`, `options`, `entrypoints`, `projectMap`, `symbols`, `imports` |

## Workspace, diagnostics, and Git review

| Tool | Structured fields |
| --- | --- |
| `doctor` | `configuration`, `runtime`, `workspace`, `checks[]`, `overall` |
| `workspace_info` | `workspace`, `git`, `package` |
| `changes` | `isRepository`, `clean`, `mode`, `staged`, `branch`, `statusEntries[]`, `groups[]`, `stat`, `truncated` |
| `git_status` | `isRepository`, `branch`, `clean`, `statusLines[]`, `truncated` |
| `git_diff` | `isRepository`, `staged`, `stat`, `empty`, `truncated` |
| `git_add` | `isRepository`, `paths[]`, `stagedCount`, `truncated` |
| `git_commit` | `isRepository`, `message`, `committed`, `truncated` |
| `git_log` | `isRepository`, `limit`, `commits[]`, `truncated` |

## Convention

- Text-first compatibility remains mandatory: do not remove `result`.
- New structured tools should expose concise arrays and summaries rather than
  requiring consumers to parse text.
- Include truncation flags whenever output can be clipped.
- Keep structured data bounded; large patches and long command output should
  stay in text or widget payloads unless a consumer needs typed fields.
