# Troubleshooting Gotchas

This page collects the setup issues users are most likely to hit.

## `localspace` Command Not Found

If you are running from a local checkout, build first and use the compiled CLI:

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js serve
```

If you installed LocalSpace as a package, confirm npm's global bin directory is
on `PATH`.

## Unsupported Node Version

LocalSpace requires Node `>=22.19 <27`.

Check:

```bash
node --version
```

Install Node 22 LTS with your preferred version manager such as `nvm`, `fnm`, or
`mise`.

## `better-sqlite3` Could Not Load

This usually means native dependencies were installed under a different Node
runtime.

Try:

```bash
npm rebuild better-sqlite3
```

Then run:

```bash
node dist/cli.js doctor
```

Release starts run a native dependency check before launching.

## Public URL Includes `/mcp`

Use the origin for setup:

```text
https://your-tunnel-host.example.com
```

Use the MCP endpoint in the client:

```text
https://your-tunnel-host.example.com/mcp
```

If you saved the wrong value:

```bash
node dist/cli.js config set publicBaseUrl https://your-tunnel-host.example.com
```

## Tunnel URL Changed

Temporary tunnels often change URLs between runs.

For a one-off run:

```bash
LOCALSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" node dist/cli.js serve
```

For a stable URL:

```bash
node dist/cli.js config set publicBaseUrl https://localspace.example.com
```

## Host Header Or 403 Problems

LocalSpace derives allowed hosts from the configured public URL.

Run:

```bash
node dist/cli.js doctor
```

Confirm the public URL hostname appears in allowed hosts. If you changed tunnel
URLs, update `publicBaseUrl`.

Use this only for intentional local debugging:

```bash
LOCALSPACE_ALLOWED_HOSTS="*" node dist/cli.js serve
```

## OAuth Redirect Host Rejected

By default, LocalSpace allows redirects for:

```text
chatgpt.com
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, configure:

```bash
LOCALSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" node dist/cli.js serve
```

## Owner Password Not Accepted

Make sure you are entering the Owner password from:

```text
~/.localspace/auth.json
```

To regenerate setup:

```bash
node dist/cli.js init --force
```

## Unknown `workspaceId`

`workspaceId` values are session identifiers. If the server restarts and the
client receives an unknown workspace error, call `open_workspace` again for that
project.

Workspace session metadata is persisted, but clients should still treat
`open_workspace` as the way to begin a fresh working session.

## Long-Running Server Memory Growth

If LocalSpace runs for many hours while an MCP client repeatedly reconnects,
stale MCP transports can accumulate when a browser tab or tunnel does not close
the old session cleanly. LocalSpace now bounds this state with idle cleanup and a
maximum active MCP session cap. See `LOCALSPACE_MCP_SESSION_IDLE_TTL_MS`,
`LOCALSPACE_MCP_SESSION_CLEANUP_INTERVAL_MS`, and
`LOCALSPACE_MCP_MAX_SESSIONS` in `configuration.md`.

If a client tries to use a session that has expired, reconnect the MCP server in
the client and call `open_workspace` again.

## Workspace Path Rejected

The path must be inside one of the allowed roots configured during setup.

Run:

```bash
node dist/cli.js config get
```

Then either open a project under an allowed root or rerun setup:

```bash
node dist/cli.js init --force
```

## Worktree Mode Fails

Worktree mode requires:

- Git installed
- the path is inside a Git repository
- the repository has at least one commit
- the requested `baseRef` resolves to a commit

For a new repository, create the first commit or use checkout mode.

Uncommitted source checkout changes are not copied into the managed worktree.
Commit, stash, or ask the model to work in checkout mode if those changes are
needed.

## Windows Shell Commands Fail

LocalSpace command execution uses the platform default command shell by default.
On Windows, common commands such as `node`, `npm`, and `git` should work
directly, while Bash-specific syntax still requires Git Bash, WSL, MSYS2, or
Cygwin Bash.

Run:

```bash
node dist/cli.js doctor
```

Confirm your expected shell tools are available.

## ChatGPT Shows `Failed To Fetch Template`

This usually means ChatGPT failed to load the optional Apps iframe template. It
does not necessarily mean the LocalSpace tool call failed.

First check whether the tool still returned normal text or structured output. If
tools such as `read`, `grep`, `git_status`, or `doctor` still return data, the
MCP server is still working and the problem is limited to the optional widget UI.

To reduce iframe usage, run with:

```bash
LOCALSPACE_WIDGETS=changes node dist/cli.js serve
```

In `changes` mode, LocalSpace attaches widget UI only to `open_workspace` and
`show_changes`. Other tools still return text and structured output without
loading the workspace iframe.

To disable widget UI completely:

```bash
LOCALSPACE_WIDGETS=off node dist/cli.js serve
```

## Skills Do Not Appear

Skills are enabled by default. Check:

```bash
LOCALSPACE_SKILLS=1 node dist/cli.js serve
```

LocalSpace looks in standard Agent Skills locations:

- `~/.agents/skills`
- project `.agents/skills`

It also checks compatibility and custom paths:

- `LOCALSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `LOCALSPACE_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through
`LOCALSPACE_SKILL_PATHS` when needed.

If a skill appears in `open_workspace`, the model must read that skill's
`SKILL.md` before reading other files inside the skill directory.

## Review Card Does Not Appear

Per-tool workspace widgets are enabled by default with:

```bash
LOCALSPACE_WIDGETS=full
```

The aggregate `show_changes` tool is exposed only with:

```bash
LOCALSPACE_WIDGETS=changes
```

Plain MCP clients may ignore ChatGPT Apps widget metadata and only show text
results. ChatGPT's normal "called tool" cards are platform tool-call logs, not
LocalSpace workspace widgets.
