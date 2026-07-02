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

`LOCALSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |
| `hybrid` | Default. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, plus dedicated `grep`, `glob`, and `ls`. |

`LOCALSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`LOCALSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `LOCALSPACE_TOOL_MODE`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

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
LOCALSPACE_TOOL_MODE="hybrid" \
LOCALSPACE_WIDGETS="full" \
localspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
