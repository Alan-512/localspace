<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Alan-512/localspace/main/docs/assets/devspace-logo-light.png" alt="LocalSpace logo" width="140">
  </picture>
</p>

<h1 align="center">LocalSpace</h1>

<p align="center">Bring a Codex-style coding workflow to ChatGPT.</p>

<p align="center">
  <a href="https://github.com/Alan-512/localspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Alan-512/localspace/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Alan-512/localspace/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
</p>

**Give ChatGPT a secure connection to your own machine and Turn ChatGPT into Codex**

LocalSpace is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your real local projects — your files, your tools, your terminal — without uploading anything to a third party. You run it on your machine, expose it through a tunnel you control, and approve the connection with a password only you have.

---

### 💖 Acknowledgement & Credits
LocalSpace is a fork of and built upon the original project [DevSpace](https://github.com/Waishnav/devspace) created by [Waishnav](https://x.com/wshxnv). We thank them for their great work in bringing Codex-style workflows to ChatGPT. This repository is customized and extended for hybrid coding assistant workflows.

## Installation

LocalSpace requires Node `>=22.19 <27`.

Install the dependencies:

```bash
npm install
npm run build
```

Then initialize and start the server:

```bash
node dist/cli.js init
node dist/cli.js serve
```

During setup, LocalSpace asks for:

- the local project folders ChatGPT is allowed to open through LocalSpace
- the local port, usually `7676` or `7680`
- your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or another reverse proxy

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

You will configure your MCP client with the public `/mcp` URL after setup.

When the client connects, LocalSpace opens an Owner password approval page. Enter the Owner password printed by `init`. It is also stored in:

```text
~/.localspace/auth.json
```

*(Note: LocalSpace has full backward-compatibility and automatically falls back to your old `~/.devspace/auth.json` if it exists.)*

Keep that password private.

## Connect Your MCP Client

The default local endpoint is:

```text
http://127.0.0.1:7680/mcp
```

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

## Tool Modes & What ChatGPT Can Do

Once connected, ChatGPT can open one of your approved project folders as a workspace. From there, it can inspect the repo, make scoped edits, run commands, and show you what changed.

LocalSpace supports multiple tool modes (`minimal`, `full`, `codex`, `hybrid`). By default, it runs in the **`hybrid`** mode, which gives the LLM the best balance of safety and power:

### Hybrid Mode Tools (Default)
- **`open_workspace`**: Open an allowed project directory.
- **`doctor`**: Check LocalSpace runtime, config, shell, Git, Node, npm, and workspace diagnostics.
- **`workspace_info`**: Summarize workspace root, Git status, recent commits, and package scripts.
- Workspace and Git tools return structured status data alongside text output.
- **`entrypoints`**: Identify package entrypoints, likely source entry files, config files, and verification scripts.
- **`read`**: Direct file read/inspection.
- **`project_map`**: Quickly view a compact project directory tree.
- **`code_map`**: Combine entrypoints, project structure, exported symbols, and imports/exports into one overview.
- **`symbols`**: Locate TypeScript/JavaScript declarations before reading files.
- **`imports`**: Inspect TypeScript/JavaScript import and export relationships.
- **`references`**: Find TypeScript/JavaScript identifier references before changing code.
- Navigation tools return both plain text and structured content for model/UI consumption.
- **`apply_patch`**: Apply a Codex-style unified patch to edit files.
- **`grep`**, **`glob`**, **`ls`**: Efficient directory and file structure inspection.
- **`exec_command`**: Run terminal commands (compiles, tests, builds, git status, etc.).
- **`write_stdin`**: Interact or poll running terminal processes.
- `exec_command` adds non-blocking safety warnings for risky commands such as recursive deletion, force push, deploy/publish, elevated privileges, and shell file writes.
- **`changes`**: Review current Git changes as plain text without requiring widget mode.
- **`git_status`**, **`git_diff`**, **`git_add`**, **`git_commit`**, **`git_log`**: Dedicated Git workflow tools using fixed Git arguments.

### Mental Model

LocalSpace is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local capabilities inside an opened workspace, including shell execution. Treat a connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `node dist/cli.js serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

LocalSpace supports Linux, macOS, and Windows environments. On Windows,
`exec_command` uses the platform default command shell by default. Portable
commands such as `node`, `npm`, and `git` work directly. Bash-specific syntax
still requires an explicit Bash or WSL invocation.

Set `LOCALSPACE_SHELL` when you want `exec_command` to use a specific shell such
as `cmd.exe`, `powershell.exe`, `pwsh`, Git Bash, or `wsl.exe`.

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Use Bash or WSL for Bash-specific syntax.      |
| Windows PowerShell or `cmd.exe` only              | Supported for common commands | Bash-specific scripts still require Bash or WSL. |

Run this to inspect your local setup:

```bash
node dist/cli.js doctor
```

## Local Development

For working on LocalSpace itself:

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```
