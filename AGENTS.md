# LocalSpace

This project exposes a local development workspace over MCP so ChatGPT, Claude,
or another MCP-capable host can operate directly on this machine's approved
development directories.

The goal is not to delegate work to a separate local coding agent. The MCP host
should call tools that read files, edit files, search code, apply patches, run
validation commands, and review Git state directly against approved local
project roots.

LocalSpace implements its local coding primitives directly with bounded Node.js
filesystem, Git, search, and process helpers. The MCP server wraps those native
primitives with workspace allowlists, concurrency control, policy enforcement,
approval, activity metrics, and durable audit records. It does not embed a
separate local coding agent or model-provider runtime.

The model-facing workflow is workspace based. MCP clients should call
`open_workspace` once per local project directory or worktree, then reuse the
returned `workspaceId` for subsequent tool calls in that same folder. Do not
call `open_workspace` again for the same folder unless the `workspaceId` is
rejected as unknown, the client switches folders/worktrees or checkout/worktree
mode, or the user explicitly asks to reopen. `AGENTS.md` files are returned
automatically by `open_workspace` and by later tool calls when the requested path
enters a directory with instructions that have not been loaded for that
workspace.

Core constraints:

- Treat this as remote access to the local machine; security is part of the
  core design, not a later add-on.
- Start with a narrow filesystem allowlist.
- Prefer explicit, inspectable tool calls over autonomous local agent loops.
- Keep releases small enough to validate with real ChatGPT/Claude MCP clients
  before adding broader workflow or UI features.
