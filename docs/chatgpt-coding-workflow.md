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

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.

By default, LocalSpace uses `LOCALSPACE_TOOL_MODE=hybrid`, which combines the
Codex-style editing and process tools with dedicated `project_map`, `grep`,
`glob`, and `ls` inspection tools plus the plain-text `changes` review tool.

## Review Changes

Use `changes` to inspect the workspace's current Git changes without depending
on widget mode. It supports:

- `mode: "summary"` for branch, changed paths, untracked files, and diff stat
- `mode: "stat"` for `git diff --stat`
- `mode: "patch"` for patch text
- `staged: true` to inspect staged changes

Use this before summarizing work, committing, or asking the user to review a
large patch.

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

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- package scripts
- environment checks

File writes should go through the edit/write tools rather than shell
redirection, heredocs, `tee`, `sed -i`, or generated scripts.
