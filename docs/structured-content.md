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
| `read_many` | `results[]`, `summary` |
| `run_checks` | `running`, `sessionId`, `wallTimeMs`, `queuedMs`, `checks[]`, `checkSummary`, `workspaceRevisionAtStart`, `workspaceRevisionAtEnd`, `workspaceChangedDuringRun`, `failFast`, `concurrency`, optional approval fields |
| `diagnostics` | `supported`, `reason`, `project`, `summary`, `diagnostics[]`, `projectDiagnostics[]` |
| `definition` | `supported`, `reason`, `project`, `locations[]`, `omittedExternal`, `truncated` |
| `implementations` | `supported`, `reason`, `project`, `locations[]`, `omittedExternal`, `truncated` |
| `rename_preview` | `supported`, `canRename`, `reason`, symbol display fields, `project`, `edits[]`, `files`, `omittedExternal`, `truncated` |

## Workspace, diagnostics, and Git review

Availability is controlled by the active tool surface. In particular,
`next_steps`, `validate_plan`, `review_checklist`, `task_summary`,
`validation_summary`, `final_report`, and `handoff_summary` are compatibility
helpers exposed by `minimal` and `full`, not by the default `hybrid` or
experimental `codex` surfaces. See [`tool-surfaces.md`](tool-surfaces.md).

| Tool | Structured fields |
| --- | --- |
| `open_workspace` | `workspaceId`, `root`, `mode`, optional worktree fields, `agentsFiles[]`, `availableAgentsFiles[]`, `skills[]`, `skillDiagnostics[]`, `policy`, `instruction` |
| `doctor` | `configuration`, `runtime`, `workspace`, `checks[]`, `overall` |
| `workspace_info` | `workspace`, `git`, `package` |
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
| `exec_command` | `running`, `exitCode`, `wallTimeMs`, `queuedMs`, `outputTruncated`, `commandRisk`, `commandSafetyFindings[]`, `blocked`, `approvalRequired`, `approvalToken`, `approvalTokenExpiresAt`, `commandApproved` |
| `write_stdin` | Process sessions: `running`, `exitCode`, `wallTimeMs`, `queuedMs`, `outputTruncated`; check groups additionally return `checks[]`, `checkSummary`, revision fields, `failFast`, and `concurrency` |

## Convention

- Text-first compatibility remains mandatory: do not remove `result`.
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
