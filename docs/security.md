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

## Workspace Policy

Projects can add `.localspace/policy.json` to reduce the permissions available
inside that workspace. Policies can mark paths read-only, deny command patterns,
allowlist package scripts, lower `read_many` limits, disable arbitrary commands
or PTYs, and require approval for every `exec_command` or `run_checks` call.

Project policy is not a trust grant. It cannot add allowed roots, enable hidden
tools, enlarge limits, disable sensitive-path checks, or auto-approve a command.
LocalSpace persists the first valid policy as a state-directory anchor and
monotonically merges later versions, so a repository cannot relax or delete its
own previously accepted restrictions. Managed worktrees use the source
checkout's policy rather than treating a copied worktree file as a new trust
root.

Malformed or unknown policy content fails closed for mutations and commands.
Policy decisions and blocks are written to the audit log, while read-only tools
remain usable for diagnosis. The policy file itself is protected from
LocalSpace-driven modification.

The shell boundary remains important: `readOnlyPaths` protects dedicated file
and Git tools, not every possible side effect of an arbitrary operating-system
command. Use `allowCommands: false` when a project must prevent shell-based
writes, and prefer allowlisted `run_checks` scripts for deterministic validation.
Package-script allowlists also cover existing `pre*` and `post*` lifecycle
hooks, and command-risk analysis evaluates those hooks before starting a check.

Dedicated Git staging uses literal, explicit file paths rather than broad
directories or pathspec magic. Commit-time validation rechecks all staged paths,
including rename sources and destinations, against workspace containment,
sensitive-path protection, and the active read-only policy.

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
- the workspace policy file at `.localspace/policy.json`
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
