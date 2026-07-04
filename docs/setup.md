# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through LocalSpace.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash for Bash-specific commands, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local LocalSpace server

LocalSpace does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

## Install And Configure

From a published package, use the `localspace` CLI. From a local checkout, build
first and run the compiled CLI.

```bash
npm install
npm run build
node dist/cli.js init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders ChatGPT or another MCP client is allowed to open through
LocalSpace. Keep this narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

### Local Port

The default is `7676`.

The local MCP URL is:

```text
http://127.0.0.1:7676/mcp
```

### Public Base URL

Start your tunnel or reverse proxy before entering this value. Point the tunnel
at:

```text
http://127.0.0.1:7676
```

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

## Start The Server

Run:

```bash
node dist/cli.js serve
```

If your tunnel URL changes for one run, override it without rewriting config:

```bash
LOCALSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" node dist/cli.js serve
```

For a stable public URL, persist it:

```bash
node dist/cli.js config set publicBaseUrl https://localspace.example.com
node dist/cli.js serve
```

If LocalSpace is installed as a package, the same commands are:

```bash
localspace init
localspace serve
localspace config set publicBaseUrl https://localspace.example.com
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, LocalSpace shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.localspace/config.json
~/.localspace/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
node dist/cli.js doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, shell, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing LocalSpace itself instead of using a published package:

```bash
npm install --include=dev
npm run dev
```

The same setup rules apply.
*** Delete File: docs/security.md
*** Add File: docs/security.md
# Security Model

LocalSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

LocalSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`localspace init` generates an Owner password and stores it in:

```text
~/.localspace/auth.json
```

When an MCP client connects, LocalSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
LOCALSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

LocalSpace needs `LOCALSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `LOCALSPACE_PUBLIC_BASE_URL`.

By default, LocalSpace derives allowed Host headers from the local host and
public URL. Use `LOCALSPACE_ALLOWED_HOSTS=*` only for intentional local
debugging.

## Tunnels

LocalSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. LocalSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to LocalSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

High-risk `danger` commands are blocked before execution and require a one-time
approval token after explicit user confirmation.

## Sensitive Path Protection

LocalSpace protects sensitive paths with generic cross-platform rules. It does
not hard-code a user's personal absolute paths.

Write-like tools block protected paths before modifying or staging files:

- `write`
- `edit`
- `apply_patch`
- `git_add`

Protected path detection is based on:

- the current workspace root, such as `.git/config` and `.git/hooks/**`
- LocalSpace config roots, such as `stateDir`, `agentDir`, and `worktreeRoot`
- the current user's home directory root from `os.homedir()`
- operating system roots and system directories for the current platform
- secret-like filenames such as `.env`, `.env.*`, `auth.json`, `.npmrc`,
  `.pypirc`, private key extensions, and names containing `secret`, `token`, or
  `credential`

This protection is intentionally separate from the filesystem allowlist. The
allowlist decides what a workspace may open; sensitive path protection decides
which paths should not be modified or staged automatically inside an allowed
workspace.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Logs

By default, LocalSpace logs requests and tool calls. Shell command previews are
disabled unless `LOCALSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

## Audit Log

LocalSpace keeps an audit trail for key coding actions. It records recent events
in memory for `session_summary` and appends JSONL records to disk by default.

Audited events include workspace openings, file writes, file edits, patches,
dedicated Git staging/commits, shell command execution, blocked shell commands,
and approval-token usage. Shell command previews are only included when
`LOCALSPACE_LOG_SHELL_COMMANDS=1`.

Configuration:

```text
LOCALSPACE_AUDIT_LOG=1
LOCALSPACE_AUDIT_LOG_PATH=/path/to/audit.jsonl
LOCALSPACE_AUDIT_MAX_MEMORY_EVENTS=1000
```

Set `LOCALSPACE_AUDIT_LOG=0` to disable audit logging.
