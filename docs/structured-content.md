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

Availability is controlled by the active tool surface. In particular,
`next_steps`, `validate_plan`, `review_checklist`, `task_summary`,
`validation_summary`, `final_report`, and `handoff_summary` are compatibility
helpers exposed by `minimal` and `full`, not by the default `hybrid` or
experimental `codex` surfaces. See [`tool-surfaces.md`](tool-surfaces.md).

| Tool | Structured fields |
| --- | --- |
| `doctor` | `configuration`, `runtime`, `workspace`, `checks[]`, `overall` |
| `workspace_info` | `workspace`, `git`, `package` |
| `session_summary` | `totalEvents`, `successfulEvents`, `failedEvents`, `runningEvents`, `truncatedEvents`, `processPolls`, `averageDurationMs`, `maxDurationMs`, `averageQueuedMs`, `maxQueuedMs`, `blockedEvents`, `approvedEvents`, `durableAuditEvents`, `tools`, `categories`, `concurrencyClasses`, `toolStats`, `paths`, `commands`, `risks`, `recentEvents`, `recentAuditEvents`, `requestMetrics` |
| `next_steps` | `steps[]` |
| `validate_plan` | `packageName`, `commands[]`, `missingScripts[]`, `notes[]` |
| `review_checklist` | `dirty`, `staged`, `unstaged`, `untracked`, `changedPaths[]`, `checks[]`, `recommendedActions[]` |
| `task_summary` | `changedPaths[]`, `git`, `audit`, `validation`, `recommendedFinalResponse[]`, `warnings[]` |
| `validation_summary` | `commandPreviewEnabled`, `recommendedCommands[]`, `recentExecCommands`, `recentFailures`, `recentSuccesses`, `detectedResults[]`, `notes[]` |
| `final_report` | `taskTitle`, `summary[]`, `changedFiles[]`, `git`, `validation`, `commit`, `warnings[]`, `nextRecommendedStep` |
| `handoff_summary` | `project`, `currentPhase`, `completedPhases[]`, `changedFiles[]`, `validation`, `remainingTasks[]`, `knownWarnings[]`, `nextRecommendedStep`, `suggestedFirstPrompt` |
| `changes` | `isRepository`, `clean`, `mode`, `staged`, `branch`, `statusEntries[]`, `groups[]`, `stat`, `truncated` |
| `git_status` | `isRepository`, `branch`, `clean`, `statusLines[]`, `truncated` |
| `git_diff` | `isRepository`, `staged`, `stat`, `empty`, `truncated` |
| `git_add` | `isRepository`, `paths[]`, `stagedCount`, `truncated` |
| `git_commit` | `isRepository`, `message`, `committed`, `truncated` |
| `git_log` | `isRepository`, `limit`, `commits[]`, `truncated` |
| `exec_command` | `running`, `exitCode`, `wallTimeMs`, `queuedMs`, `outputTruncated`, `commandRisk`, `commandSafetyFindings[]`, `blocked`, `approvalRequired`, `approvalToken`, `approvalTokenExpiresAt`, `commandApproved` |
| `write_stdin` | `running`, `exitCode`, `wallTimeMs`, `queuedMs`, `outputTruncated` |

## Convention

- Text-first compatibility remains mandatory: do not remove `result`.
- New structured tools should expose concise arrays and summaries rather than
  requiring consumers to parse text.
- Include truncation flags whenever output can be clipped.
- Keep structured data bounded; large patches and long command output should
  stay in text or widget payloads unless a consumer needs typed fields.
