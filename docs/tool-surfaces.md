# LocalSpace Tool Surfaces

> Generated from `src/tool-catalog.ts`. Update the catalog, then regenerate this file; do not maintain a second handwritten tool list.

Tool lists below use `LOCALSPACE_WIDGETS=off`. Widget-dependent additions are listed separately.

## `hybrid` (29)

- `open_workspace`
- `read`
- `read_many`
- `doctor`
- `workspace_info`
- `session_summary`
- `entrypoints`
- `code_map`
- `project_map`
- `symbols`
- `imports`
- `references`
- `grep`
- `glob`
- `ls`
- `next_steps`
- `validation_summary`
- `final_report`
- `handoff_summary`
- `apply_patch`
- `exec_command`
- `run_checks`
- `write_stdin`
- `changes`
- `git_status`
- `git_diff`
- `git_add`
- `git_commit`
- `git_log`

## `codex` (17)

- `open_workspace`
- `read`
- `read_many`
- `doctor`
- `workspace_info`
- `session_summary`
- `entrypoints`
- `apply_patch`
- `exec_command`
- `run_checks`
- `write_stdin`
- `changes`
- `git_status`
- `git_diff`
- `git_add`
- `git_commit`
- `git_log`

## `full` (30)

- `open_workspace`
- `read`
- `doctor`
- `workspace_info`
- `session_summary`
- `entrypoints`
- `code_map`
- `project_map`
- `symbols`
- `imports`
- `references`
- `grep`
- `glob`
- `ls`
- `write`
- `edit`
- `bash`
- `validate_plan`
- `review_checklist`
- `next_steps`
- `task_summary`
- `validation_summary`
- `final_report`
- `handoff_summary`
- `changes`
- `git_status`
- `git_diff`
- `git_add`
- `git_commit`
- `git_log`

## `minimal` (16)

- `open_workspace`
- `read`
- `doctor`
- `workspace_info`
- `session_summary`
- `entrypoints`
- `write`
- `edit`
- `bash`
- `validate_plan`
- `review_checklist`
- `next_steps`
- `task_summary`
- `validation_summary`
- `final_report`
- `handoff_summary`

## Optional tool packs

- `LOCALSPACE_TOOL_PACKS=code-intelligence` adds `diagnostics`, `definition`, `implementations`, and `rename_preview` to every tool mode.
- Optional pack tools are absent when `LOCALSPACE_TOOL_PACKS` is unset.

## Widget overlays

- `LOCALSPACE_WIDGETS=changes` adds `show_changes` to every tool mode.
- `LOCALSPACE_WIDGETS=full` changes UI attachment only and does not add tools.
- `LOCALSPACE_WIDGETS=off` exposes no widget-only tools.
