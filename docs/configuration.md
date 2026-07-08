# Configuration Reference

LocalSpace can be configured through `localspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.localspace/config.json
~/.localspace/auth.json
```

Use another config directory with:

```bash
LOCALSPACE_CONFIG_DIR=/path/to/config localspace serve
```

## Commands

```bash
localspace init
localspace serve
localspace doctor
localspace config get
localspace config set publicBaseUrl https://localspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `LOCALSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `LOCALSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `LOCALSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `LOCALSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `LOCALSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.localspace/worktrees`. |
| `LOCALSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/localspace`. |
| `LOCALSPACE_SHELL` | Optional shell executable for `exec_command`, for example `cmd.exe`, `powershell.exe`, `pwsh`, Git Bash, or `wsl.exe`. |

## MCP Session Lifecycle

LocalSpace keeps one in-memory MCP transport per active client session. To avoid
stale browser or tunnel reconnections accumulating until Node.js runs out of
heap, sessions are now bounded and cleaned up automatically.

| Variable | Default |
| --- | --- |
| `LOCALSPACE_MCP_SESSION_IDLE_TTL_MS` | `14400000` |
| `LOCALSPACE_MCP_SESSION_CLEANUP_INTERVAL_MS` | `60000` |
| `LOCALSPACE_MCP_MAX_SESSIONS` | `128` |

When a session is idle past the TTL, LocalSpace closes and removes it. When the
session cap is exceeded, the least recently used session is removed first. MCP
clients can reconnect and call `open_workspace` again if they try to use a
session that has already expired.

## OAuth

LocalSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `LOCALSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `LOCALSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `LOCALSPACE_OAUTH_SCOPES` | `localspace` |
| `LOCALSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

LocalSpace is designed around `hybrid` as the default and recommended tool
surface. It keeps the complete ChatGPT coding loop available: safe workspace
inspection, code navigation, patching, process tools, Git helpers, and workflow
summaries.

`LOCALSPACE_TOOL_MODE` remains available for legacy compatibility and advanced
experiments, but most users should leave it unset.

| Value | Behavior |
| --- | --- |
| `hybrid` | Default. Exposes `open_workspace`, `doctor`, `workspace_info`, `entrypoints`, `read`, `code_map`, `project_map`, `symbols`, `imports`, `references`, `apply_patch`, `exec_command`, `write_stdin`, `changes`, `git_*`, plus dedicated `grep`, `glob`, and `ls`. |
| `codex` | Experimental compatibility. Exposes `open_workspace`, `doctor`, `workspace_info`, `entrypoints`, `read`, `apply_patch`, `exec_command`, `write_stdin`, `changes`, and `git_*` tools. Existing mutation and shell tools are hidden. |
| `full` | Legacy compatibility. Exposes the minimal tools plus dedicated `doctor`, `workspace_info`, `entrypoints`, `code_map`, `project_map`, `symbols`, `imports`, `references`, `grep`, `glob`, `ls`, `changes`, and `git_*` tools. |
| `minimal` | Legacy compatibility. Exposes `open_workspace`, `doctor`, `workspace_info`, `entrypoints`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |

`LOCALSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`LOCALSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `LOCALSPACE_TOOL_MODE`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

`project_map` renders a compact directory tree for an open workspace. It defaults
to `depth: 3`, `maxEntries: 300`, `includeFiles: true`, and `showHidden: false`,
and skips large/generated folders such as `.git`, `node_modules`, `dist`,
`build`, `.next`, `.turbo`, `.cache`, `coverage`, and `.localspace`.

`symbols` scans TypeScript and JavaScript files for top-level declarations and
class methods. It reports file paths, line numbers, symbol kinds, symbol names,
and export status. It supports name and kind filters plus result/file limits.

`imports` scans TypeScript and JavaScript files for imports, dynamic imports,
re-exports, and exported declarations. `references` scans TypeScript and
JavaScript AST identifiers to find usage sites for a symbol name.

`doctor` reports LocalSpace configuration and runtime diagnostics, including
tool mode, widget mode, roots, state directories, Node/npm/Git availability, and
configured shell health. Pass a `workspaceId` to include workspace diagnostics.

`workspace_info` reports workspace root/mode, Git branch/status/recent commits,
and package metadata/scripts for an open workspace.

`entrypoints` reports package entrypoint fields, scripts, likely source entry
files, suggested verification commands, and important config/orientation files.

`code_map` aggregates entrypoints, a compact project tree, exported symbols, and
import/export relationships for a bounded project overview.

The code navigation tools return plain text for human-readable MCP hosts and
structured content for model or UI consumers. `symbols`, `imports`,
`references`, `entrypoints`, and `code_map` expose typed arrays and summaries in
their `structuredContent` payloads while preserving the `result` text field.

Workspace and Git tools follow the same pattern. `doctor`, `workspace_info`,
`changes`, and `git_*` tools preserve text output and add structured summaries
for health checks, branch status, grouped changes, commits, and truncation flags.
See [`structured-content.md`](structured-content.md) for the field summary.

`exec_command` blocks `danger` risk commands before execution and returns a
one-time `approvalToken`. Retry the exact same command with `approvalToken` only
after the user explicitly confirms. Tokens are scoped to the same workspace,
working directory, command, and risk level.

Write-like tools also protect sensitive paths using generic rules rather than
hard-coded personal paths. Protected paths include workspace Git configuration
and hooks, `.env` files, secret/token/private-key-like filenames, LocalSpace
state/agent/worktree directories, home-directory roots, and platform system
directories.

Audit logging is enabled by default. It records recent events in memory for
`session_summary` and appends JSONL records to `LOCALSPACE_AUDIT_LOG_PATH`,
defaulting to `audit.jsonl` under the LocalSpace state directory. Use
`LOCALSPACE_AUDIT_LOG=0` to disable it and
`LOCALSPACE_AUDIT_MAX_MEMORY_EVENTS` to tune in-memory retention.

Workflow helper tools are read-only. `next_steps` recommends the next action,
`validate_plan` recommends validation commands from package scripts without
running them, `review_checklist` summarizes pre-summary or pre-commit checks
from Git state and detected validation scripts, `validation_summary` summarizes
recent validation-related command activity, and `task_summary` summarizes changed
paths, Git state, audit activity, validation recommendations, warnings, and
final-response guidance. `final_report` turns that state into a standard final
task report, and `handoff_summary` generates Markdown context for continuing a
long task in a new chat or window.

`changes` renders current Git changes as plain text. It supports `summary`,
`stat`, and `patch` modes, can inspect staged changes with `staged: true`, and
does not require `LOCALSPACE_WIDGETS=changes`.

Dedicated Git tools are exposed in `full`, `codex`, and `hybrid` modes:

- `git_status`
- `git_diff`
- `git_add`
- `git_commit`
- `git_log`

They use fixed `git` arguments through `execFile` and do not use `LOCALSPACE_SHELL`.
`git_commit` should only be used when the user asks to commit.

## Shell Selection

By default, `exec_command` uses `cmd.exe` on Windows and a POSIX shell on Linux
or macOS. Set `LOCALSPACE_SHELL` to force a specific shell:

```bash
LOCALSPACE_SHELL="pwsh" localspace serve
LOCALSPACE_SHELL="C:/Program Files/Git/bin/bash.exe" localspace serve
LOCALSPACE_SHELL="wsl.exe" localspace serve
```

LocalSpace automatically chooses shell flags for common shells: `cmd`,
PowerShell, `pwsh`, POSIX shells, Git Bash, and WSL.

`exec_command` also returns non-blocking command safety warnings for patterns
that commonly mutate files, Git history, remotes, permissions, deployments, or
system-level settings. The command still runs; the warning is included in the
tool response and structured output so MCP clients and models can surface it.

## Widgets

`LOCALSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `LOCALSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `LOCALSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `LOCALSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

LocalSpace ships built-in workflow skills. They are loaded from the package and
advertised by `open_workspace` alongside user/project skills:

- `localspace-code-editing`
- `localspace-code-navigation`
- `localspace-validation`
- `localspace-git-review`
- `localspace-release`
- `localspace-handoff`

Built-in skills provide progressive disclosure for workflow guidance. The MCP
tool surface remains `hybrid`; skills do not hide or reveal tools dynamically.
They tell the model which existing tools to combine for a task and when to run
validation, review changes, or produce a handoff.

LocalSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`

It also keeps compatibility with:

- `LOCALSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `LOCALSPACE_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `LOCALSPACE_SKILL_PATHS` when needed.

Example:

```bash
LOCALSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
localspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `LOCALSPACE_LOG_LEVEL` | `info` |
| `LOCALSPACE_LOG_FORMAT` | `json` |
| `LOCALSPACE_LOG_REQUESTS` | `1` |
| `LOCALSPACE_LOG_ASSETS` | `0` |
| `LOCALSPACE_LOG_TOOL_CALLS` | `1` |
| `LOCALSPACE_LOG_SHELL_COMMANDS` | `0` |
| `LOCALSPACE_TRUST_PROXY` | `0` |

Set `LOCALSPACE_LOG_FORMAT=pretty` for local debugging.

Set `LOCALSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
LOCALSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
LOCALSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
LOCALSPACE_PUBLIC_BASE_URL="https://localspace.example.com" \
LOCALSPACE_WORKTREE_ROOT="$HOME/.localspace/worktrees" \
LOCALSPACE_SHELL="pwsh" \
LOCALSPACE_TOOL_MODE="hybrid" \
LOCALSPACE_WIDGETS="full" \
localspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
