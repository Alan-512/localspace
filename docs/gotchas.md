# Troubleshooting Gotchas

This page collects the setup issues users are most likely to hit.

## `devspace` Command Not Found

Use `npx`:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

If you installed globally, confirm npm's global bin directory is on `PATH`.

## Unsupported Node Version

DevSpace requires Node `>=22.19 <27`.

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
npx @waishnav/devspace doctor
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
npx @waishnav/devspace config set publicBaseUrl https://your-tunnel-host.example.com
```

## Tunnel URL Changed

Temporary tunnels often change URLs between runs.

For a one-off run:

```bash
LOCALSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" localspace serve
```

For a stable URL:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Host Header Or 403 Problems

DevSpace derives allowed hosts from the configured public URL.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm the public URL hostname appears in allowed hosts. If you changed tunnel
URLs, update `publicBaseUrl`.

Use this only for intentional local debugging:

```bash
LOCALSPACE_ALLOWED_HOSTS="*" localspace serve
```

## OAuth Redirect Host Rejected

By default, DevSpace allows redirects for:

```text
chatgpt.com
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, configure:

```bash
LOCALSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" localspace serve
```

## Owner Password Not Accepted

Make sure you are entering the Owner password from:

```text
~/.devspace/auth.json
```

To regenerate setup:

```bash
npx @waishnav/devspace init --force
```

## Unknown `workspaceId`

`workspaceId` values are session identifiers. If the server restarts and the
client receives an unknown workspace error, call `open_workspace` again for that
project.

Workspace session metadata is persisted, but clients should still treat
`open_workspace` as the way to begin a fresh working session.

## Workspace Path Rejected

The path must be inside one of the allowed roots configured during setup.

Run:

```bash
npx @waishnav/devspace config get
```

Then either open a project under an allowed root or rerun setup:

```bash
npx @waishnav/devspace init --force
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
localspace doctor
```

Confirm your expected shell tools are available.

## Skills Do Not Appear

Skills are enabled by default. Check:

```bash
LOCALSPACE_SKILLS=1 localspace serve
```

LocalSpace looks in standard Agent Skills locations:

- `~/.agents/skills`
- project `.agents/skills`

It also checks compatibility and custom paths:

- `LOCALSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `LOCALSPACE_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `LOCALSPACE_SKILL_PATHS` when needed.

If a skill appears in `open_workspace`, the model must read that skill's
`SKILL.md` before reading other files inside the skill directory.

## Review Card Does Not Appear

Per-tool widget cards are enabled by default with:

```bash
LOCALSPACE_WIDGETS=full
```

The aggregate `show_changes` tool is only exposed with
`LOCALSPACE_WIDGETS=changes`. Plain MCP clients may ignore ChatGPT Apps widget
metadata and only show text results.
