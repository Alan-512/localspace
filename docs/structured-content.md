# Structured Content

LocalSpace tools preserve plain text output for simple MCP hosts and also expose
typed `structuredContent` fields for model and UI consumers.

Every structured tool keeps this compatibility field:

| Field | Meaning |
| --- | --- |
| `result` | Human-readable result text. This is the stable compatibility field. |

Typed producer objects may use an internal `text` property while formatting a
response, but LocalSpace does not duplicate that property into public
`structuredContent`; consumers should use `result`. This is a LocalSpace 2.0
contract change; see [`v2-migration.md`](v2-migration.md).

## Code navigation and project orientation

| Tool | Structured fields |
| --- | --- |
| `symbols` | `summary`, `symbols[]` |
| `imports` | `summary`, `entries[]` |
| `references` | `summary`, `references[]` |
| `entrypoints` | `packageInfo`, `scripts[]`, `suggestedVerification[]`, `sourceEntrypoints[]`, `configFiles[]` |
| `code_map` | `scope`, `options`, `entrypoints`, `projectMap`, `symbols`, `imports` |
| `read_many` | `results[]`, `summary` |
| `run_checks` | `running`, `sessionId`, `wallTimeMs`, `queuedMs`, `checks[]`, `checkSummary`, `workspaceRevisionAtStart`, `workspaceRevisionAtEnd`, `workspaceChangedDuringRun`, `failFast`, `concurrency`, optional approval fields |
| `diagnostics` | `supported`, `reason`, `project`, `summary`, `diagnostics[]`, `projectDiagnostics[]` |
| `definition` | `supported`, `reason`, `project`, `locations[]`, `omittedExternal`, `truncated` |
| `implementations` | `supported`, `reason`, `project`, `locations[]`, `omittedExternal`, `truncated` |
| `rename_preview` | `supported`, `canRename`, `reason`, symbol display fields, `project`, `edits[]`, `files`, `omittedExternal`, `truncated` |

## Workspace, diagnostics, and Git review

Availability is controlled by the active tool surface. In particular,
`validate_plan`, `review_checklist`, and `task_summary` remain compatibility
helpers exposed by `minimal` and `full`. The default `hybrid` surface also
exposes the narrower completion set `next_steps`, `validation_summary`,
`final_report`, and `handoff_summary`; the experimental `codex` surface does
not. See [`tool-surfaces.md`](tool-surfaces.md).

| Tool | Structured fields |
| --- | --- |
| `open_workspace` | `workspaceId`, `root`, `mode`, optional worktree fields, `agentsFiles[]`, `availableAgentsFiles[]`, at most 12 detailed `skills[]` entries, `skillsTotal`, `skillsReturned`, `skillsTruncated`, compact `skillIndex[]`, `recommendedSkills[]`, `skillDiagnostics[]`, `policy`, `instruction` |
| `doctor` | `configuration`, `runtime`, `workspace`, `checks[]`, `overall` |
| `workspace_info` | `workspace`, `git`, `package`; bounded Git data includes `statusTotal`, `statusReturned`, `statusTruncated`, `statusOmitted`, and equivalent recent-commit fields |
| `session_summary` | `totalEvents`, `successfulEvents`, `failedEvents`, `runningEvents`, `truncatedEvents`, `processPolls`, `averageDurationMs`, `maxDurationMs`, `averageQueuedMs`, `maxQueuedMs`, `blockedEvents`, `approvedEvents`, `durableAuditEvents`, `tools`, `categories`, `concurrencyClasses`, `toolStats`, `paths`, `commands`, `risks`, `recentEvents`, `recentAuditEvents`, `requestMetrics` |
| `next_steps` | `steps[]` |
| `validate_plan` | `packageName`, `commands[]`, `missingScripts[]`, `notes[]` |
| `review_checklist` | `dirty`, `staged`, `unstaged`, `untracked`, `changedPaths[]`, `automation`, `checks[]`, `recommendedActions[]` |
| `task_summary` | `changedPaths[]`, `git`, `audit`, `validation`, `automation`, `recommendedFinalResponse[]`, `warnings[]` |
| `validation_summary` | `commandPreviewEnabled`, `recommendedCommands[]`, `recentExecCommands`, `recentFailures`, `recentSuccesses`, `detectedResults[]`, `automation`, `notes[]` |
| `final_report` | `taskTitle`, `summary[]`, `changedFiles[]`, `git`, `validation`, `commit`, `warnings[]`, `nextRecommendedStep` |
| `handoff_summary` | `project`, `currentPhase`, `completedPhases[]`, `changedFiles[]`, `validation`, `remainingTasks[]`, `knownWarnings[]`, `nextRecommendedStep`, `suggestedFirstPrompt` |
| `changes` | `isRepository`, `clean`, `mode`, `staged`, `branch`, `statusEntries[]`, `groups[]`, `stat`, `truncated` |
| `git_status` | `isRepository`, `branch`, `clean`, `statusLines[]`, `truncated` |
| `git_diff` | `isRepository`, `staged`, `stat`, `empty`, `truncated` |
| `git_add` | `isRepository`, `paths[]`, `stagedCount`, `truncated` |
| `git_commit` | `isRepository`, `message`, `committed`, `truncated`, optional approval/block fields, `workspaceRevision`, `commandRisk`, `commandSafetyFindings[]`, `automation` |
| `git_log` | `isRepository`, `limit`, `commits[]`, `truncated` |
| `exec_command` | `command`, `workingDirectory`, `running`, `exitCode`, `wallTimeMs`, `queuedMs`, `startedAt`, optional `completedAt`, `outputCharacters`, `outputTruncated`, `commandRisk`, `commandSafetyFindings[]`, `blocked`, `approvalRequired`, `approvalToken`, `approvalTokenExpiresAt`, `commandApproved` |
| `write_stdin` | Process sessions preserve `command`, `workingDirectory`, timing fields, `outputCharacters`, `running`, `exitCode`, `wallTimeMs`, `queuedMs`, and `outputTruncated`; check groups additionally return `checks[]`, `checkSummary`, revision fields, `failFast`, and `concurrency` |

## Convention

- Text-first compatibility remains mandatory: do not remove `result`.
- Tool callbacks are validated against their declared output schema before the
  MCP SDK serializes them. Contract mismatches and callback failures are
  returned as tool-level errors with `content`, `isError: true`, and a stable
  `_meta.error` object containing code, recoverable/retryable flags, bounded
  details, and a suggested next action. Error results intentionally omit
  `structuredContent` because official MCP clients validate any present
  structured object against the tool's success schema.
- `_meta.card.payload` is retained only when a Widget is attached to that tool;
  non-Widget responses do not duplicate their full text there.
- New structured tools should expose concise arrays and summaries rather than
  requiring consumers to parse text.
- Include truncation flags whenever output can be clipped.
- Keep structured data bounded; large patches and long command output should
  stay in text or widget payloads unless a consumer needs typed fields.

The deterministic `automation` object contains changed/source/package/sensitive
paths, validation and package-validation freshness, validation evidence kinds,
latest detected timestamps, `commitReviewRequired`, and bounded
`recommendations[]`. Recommendations are evidence and workflow guidance; they
are not a claim that LocalSpace executed the suggested command.
