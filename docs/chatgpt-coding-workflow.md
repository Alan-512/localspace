# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

After opening a workspace, call `project_map` when you need a fast overview of
the repo layout before drilling into specific files with `read`, `grep`, `glob`,
or `ls`.

For TypeScript or JavaScript projects, call `symbols` to locate declarations by
name or kind before opening large files.

Use `imports` to inspect file dependencies and export surfaces. Use `references`
before changing a symbol to estimate where that identifier is used.

Call `workspace_info` when you need the current branch, Git cleanliness, recent
commits, and package scripts. Call `doctor` when commands, Git, shell selection,
or LocalSpace connectivity behave unexpectedly.

Call `entrypoints` early in an unfamiliar project to identify package `main`,
`bin`, `exports`, likely `src/*` source entry files, important config files, and
the best verification scripts.

Call `code_map` when you need one compact overview of the project. It combines
entrypoints, a directory tree, exported symbols, and import/export relationships.

Do not reopen the same folder unless:

- the `workspaceId` is rejected as unknown
- the user switches to another folder
- the user switches between checkout and worktree mode
- the user explicitly asks to reopen

## Checkout Mode

Checkout mode is the default. DevSpace opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, DevSpace loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `availableAgentsFiles`. The model
should read the relevant nested file before working under that directory.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`

It also keeps compatibility with:

- `LOCALSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `LOCALSPACE_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `LOCALSPACE_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

Skill paths may be outside the workspace. LocalSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `LOCALSPACE_SKILLS=0` to hide skills from workspace output.

## Tool Names

LocalSpace exposes these tool names in minimal mode:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`

Set `LOCALSPACE_TOOL_MODE=minimal` to expose only this small tool surface. In
that mode, dedicated `grep`, `glob`, and `ls` tools are hidden. Use `bash` with
command-line tools such as `rg`, `find`, and `ls` for search and directory
inspection.

Use `LOCALSPACE_TOOL_MODE=full` to restore dedicated search and directory tools.
Full mode also exposes `project_map` for compact directory-tree inspection and
`changes` for plain-text Git change review.

The experimental Codex-style surface is enabled with
`LOCALSPACE_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `read`
- `apply_patch`
- `exec_command`
- `write_stdin`
- `changes`
- `git_status`
- `git_diff`
- `git_add`
- `git_commit`
- `git_log`

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.

By default, LocalSpace uses `LOCALSPACE_TOOL_MODE=hybrid`, which combines the
Codex-style editing and process tools with dedicated `project_map`, `grep`,
`glob`, and `ls` inspection tools plus the plain-text `changes` review tool.

## Symbol Search

Use `symbols` to scan TypeScript and JavaScript files for declarations without
building a full language-server index. It reports workspace-relative file paths,
line numbers, symbol kinds, names, and whether the declaration is exported.

It supports:

- `query` for case-insensitive name filtering
- `kind` for `class`, `function`, `interface`, `type`, `enum`, `variable`, or
  `method`
- `includeNonExported: false` to focus on public API symbols
- `maxResults` and `maxFiles` to bound work on large repositories

The scan skips generated or dependency folders such as `.git`, `node_modules`,
`dist`, `build`, `.next`, `.turbo`, `.cache`, `coverage`, `.localspace`, and
`.devspace`.

## Imports and References

Use `imports` to scan TypeScript and JavaScript files for static imports,
dynamic imports, re-exports, and exported declarations. It reports
workspace-relative file paths, line numbers, imported/exported names, and module
specifiers.

Use `references` to find identifier references before editing a function, class,
variable, or exported API. By default it excludes definitions so the result
focuses on usage sites. Set `includeDefinitions: true` when you also need the
declaration sites.

## Code Map

Use `code_map` as a first-pass overview for unfamiliar projects. It aggregates
the most useful discovery tools into one response: `entrypoints`, a compact
project tree, exported symbols, and import/export relationships. Use the
specialized tools afterward when you need more depth.

The navigation tools also return structured content in addition to plain text.
For example, `symbols` returns `summary` and `symbols[]`; `imports` returns
`summary` and `entries[]`; `references` returns `summary` and `references[]`;
`entrypoints` returns package metadata, scripts, suggested verification commands,
source entrypoints, and config files; and `code_map` aggregates those structures.

Workspace and Git review tools also expose structured content. `doctor` returns
configuration, runtime, checks, and overall health. `workspace_info` returns
workspace, Git, and package metadata. `changes` returns branch, grouped changes,
status entries, and stat output. `git_status`, `git_diff`, `git_log`, `git_add`,
and `git_commit` preserve text output while also exposing normalized fields such
as clean state, commits, staged paths, and truncation status.

Use `next_steps` when you are unsure what to do next, `validate_plan` before
running verification commands, `validation_summary` after validation,
`review_checklist` before summarizing changes or committing, and `task_summary`
or `final_report` before final task summaries. Use `handoff_summary` when a long
conversation needs to continue in a new chat or window. These tools are
read-only; they recommend workflow actions and summarize state but do not run
commands or modify files.

High-risk shell commands are blocked before execution. When `exec_command`
returns `blocked: true` and an `approvalToken`, ask the user to explicitly
confirm before retrying the exact same command with that token. Approval tokens
are one-time, time-limited, and scoped to the same workspace, working directory,
command, and risk level.

## Diagnostics

Use `doctor` to inspect the LocalSpace server environment. It reports:

- tool mode and widget mode
- host, port, public base URL, allowed roots, state dir, worktree root, agent dir
- platform, architecture, Node runtime, and server cwd
- availability of `node`, `npm`, `git`, and the configured shell
- optional workspace information when `workspaceId` is provided

Use `workspace_info` after `open_workspace` to quickly inspect project state. It
reports workspace root/mode, Git repository status, branch, short HEAD, dirty
files, recent commits, and `package.json` name/version/engines/scripts.

Use `entrypoints` to understand where execution begins. It reports package
entrypoint fields, scripts, suggested verification commands, likely source entry
files, and orientation/configuration files such as `tsconfig.json`, Vite config,
`AGENTS.md`, and `README.md`.

## Review Changes

Use `changes` to inspect the workspace's current Git changes without depending
on widget mode. It supports:

- `mode: "summary"` for branch, changed paths, untracked files, and diff stat
- `mode: "stat"` for `git diff --stat`
- `mode: "patch"` for patch text
- `staged: true` to inspect staged changes

Use this before summarizing work, committing, or asking the user to review a
large patch.

## Dedicated Git Tools

Use the `git_*` tools for common repository workflow steps instead of shelling
out through `exec_command`:

- `git_status` shows branch and short status.
- `git_diff` shows unstaged, staged, patch, or stat output.
- `git_add` stages explicit workspace-relative paths after path validation.
- `git_commit` commits staged changes with a message. Use it only when the user
  asks to commit.
- `git_log` shows recent commits.

These tools use fixed `git` arguments through `execFile`; they do not accept raw
commands and do not run through the configured shell.

## Command Safety Warnings

`exec_command` performs a non-blocking safety analysis before running a command.
It still executes the requested command, but the response includes a warning when
the command appears risky.

Warnings currently cover common cases such as:

- recursive or forced file deletion
- disk/filesystem commands
- `git reset --hard`, `git clean`, forced pushes, and destructive branch deletion
- history rewrite or discard-style Git commands
- package publish or production deploy commands
- elevated privileges or execution policy changes
- broad permission changes such as `chmod 777`
- piping downloaded content or writing project files through shell redirection

These warnings are intentionally advisory. They help the model slow down and
explain the risk, while preserving the user's ability to run legitimate commands.

## Show Changes

By default, `LOCALSPACE_WIDGETS=full`.

In that mode, LocalSpace attaches widget UI to the exposed workspace, file, edit,
and shell tools. The aggregate `show_changes` tool is not exposed by default.

Use `LOCALSPACE_WIDGETS=off` to disable widget UI, or `LOCALSPACE_WIDGETS=changes`
to expose the aggregate show-changes flow.

When `show_changes` is exposed, models should call it exactly once after the
final file modification in any turn that changes files. The tool only requires
the `workspaceId`; DevSpace automatically compares against the last shown
checkpoint and advances that checkpoint after rendering the aggregate diff.

On Windows, `exec_command` uses the platform default command shell by default.
Portable commands such as `node`, `npm`, and `git` work directly. Bash-specific
syntax still requires an explicit Bash or WSL invocation.

Set `LOCALSPACE_SHELL` to make `exec_command` use a specific shell. Supported
common values include `cmd.exe`, `powershell.exe`, `pwsh`, Git Bash, and
`wsl.exe`. The dedicated `git_*` tools do not use this shell setting.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- package scripts
- environment checks

File writes should go through the edit/write tools rather than shell
redirection, heredocs, `tee`, `sed -i`, or generated scripts.
