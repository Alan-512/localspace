import type { ToolMode, WidgetMode } from "./config.js";

export type ToolCategory =
  | "workspace"
  | "navigation"
  | "mutation"
  | "process"
  | "git"
  | "workflow"
  | "diagnostics";

export type ToolConcurrencyClass =
  | "shared-read"
  | "heavy-read"
  | "workspace-write"
  | "git-write"
  | "process-start"
  | "process-session"
  | "global-exclusive";

export const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  readMany: "read_many",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  doctor: "doctor",
  workspaceInfo: "workspace_info",
  sessionSummary: "session_summary",
  validatePlan: "validate_plan",
  reviewChecklist: "review_checklist",
  nextSteps: "next_steps",
  taskSummary: "task_summary",
  validationSummary: "validation_summary",
  finalReport: "final_report",
  handoffSummary: "handoff_summary",
  entrypoints: "entrypoints",
  codeMap: "code_map",
  projectMap: "project_map",
  symbols: "symbols",
  imports: "imports",
  references: "references",
  changes: "changes",
  gitStatus: "git_status",
  gitDiff: "git_diff",
  gitAdd: "git_add",
  gitCommit: "git_commit",
  gitLog: "git_log",
  applyPatch: "apply_patch",
  execCommand: "exec_command",
  runChecks: "run_checks",
  writeStdin: "write_stdin",
  showChanges: "show_changes",
  shell: "bash",
} as const;

export type ToolName = (typeof toolNames)[keyof typeof toolNames];

export interface ToolCatalogEntry {
  name: ToolName;
  modes: readonly ToolMode[];
  category: ToolCategory;
  concurrencyClass: ToolConcurrencyClass;
  summary: string;
  widgetMode?: "changes";
}

const allModes = ["minimal", "full", "codex", "hybrid"] as const satisfies readonly ToolMode[];
const legacyModes = ["minimal", "full"] as const satisfies readonly ToolMode[];
const navigationModes = ["full", "hybrid"] as const satisfies readonly ToolMode[];
const codexModes = ["codex", "hybrid"] as const satisfies readonly ToolMode[];
const gitModes = ["full", "codex", "hybrid"] as const satisfies readonly ToolMode[];

export const toolCatalog: readonly ToolCatalogEntry[] = [
  entry(toolNames.openWorkspace, allModes, "workspace", "shared-read", "Open an approved project directory or managed Git worktree and return its workspace context."),
  entry(toolNames.read, allModes, "navigation", "shared-read", "Read a bounded line range from a workspace file or an authorized Skill file."),
  entry(toolNames.readMany, codexModes, "navigation", "shared-read", "Read multiple known text files in one bounded call with ordered partial results and limited internal concurrency."),
  entry(toolNames.doctor, allModes, "diagnostics", "shared-read", "Report LocalSpace configuration, runtime, command availability, and optional workspace health."),
  entry(toolNames.workspaceInfo, allModes, "workspace", "shared-read", "Show workspace identity, Git state, recent commits, and package scripts."),
  entry(toolNames.sessionSummary, allModes, "workflow", "shared-read", "Summarize recent tool activity, MCP request timings, and durable security audit events for one or all workspaces."),
  entry(toolNames.entrypoints, allModes, "navigation", "shared-read", "Show package entrypoints, likely source entry files, important config files, and suggested verification commands."),

  entry(toolNames.codeMap, navigationModes, "navigation", "heavy-read", "Combine entrypoints, project structure, exported symbols, and import relationships into one bounded overview."),
  entry(toolNames.projectMap, navigationModes, "navigation", "shared-read", "Render a bounded directory tree while skipping generated and dependency folders."),
  entry(toolNames.symbols, navigationModes, "navigation", "heavy-read", "List TypeScript and JavaScript declarations under a workspace path."),
  entry(toolNames.imports, navigationModes, "navigation", "heavy-read", "List TypeScript and JavaScript import and export relationships under a workspace path."),
  entry(toolNames.references, navigationModes, "navigation", "heavy-read", "Find TypeScript and JavaScript identifier references under a workspace path."),
  entry(toolNames.grep, navigationModes, "navigation", "shared-read", "Search workspace file contents within bounded paths and ignore rules."),
  entry(toolNames.glob, navigationModes, "navigation", "shared-read", "Find workspace files by glob pattern within bounded paths and ignore rules."),
  entry(toolNames.ls, navigationModes, "navigation", "shared-read", "List one workspace directory."),

  entry(toolNames.write, legacyModes, "mutation", "workspace-write", "Create or completely overwrite one workspace file."),
  entry(toolNames.edit, legacyModes, "mutation", "workspace-write", "Apply exact, targeted text replacements to one workspace file."),
  entry(toolNames.shell, legacyModes, "process", "process-start", "Run one workspace shell command with bounded execution and output."),
  entry(toolNames.validatePlan, legacyModes, "workflow", "shared-read", "Recommend validation commands from detected package scripts without running them."),
  entry(toolNames.reviewChecklist, legacyModes, "workflow", "shared-read", "Build a pre-summary or pre-commit checklist from Git state and validation scripts."),
  entry(toolNames.nextSteps, legacyModes, "workflow", "shared-read", "Recommend next workflow actions from workspace state and recent audit activity."),
  entry(toolNames.taskSummary, legacyModes, "workflow", "shared-read", "Summarize changed paths, Git state, audit activity, validation guidance, and warnings."),
  entry(toolNames.validationSummary, legacyModes, "workflow", "shared-read", "Summarize recent validation command activity and recommended checks."),
  entry(toolNames.finalReport, legacyModes, "workflow", "shared-read", "Generate a standard task-final report from workspace and validation state."),
  entry(toolNames.handoffSummary, legacyModes, "workflow", "shared-read", "Generate a Markdown handoff for continuing work in a new chat or window."),

  entry(toolNames.applyPatch, codexModes, "mutation", "workspace-write", "Apply one bounded Codex-style patch that can add, update, delete, or move workspace files."),
  entry(toolNames.execCommand, codexModes, "process", "process-start", "Run one workspace command and return output or a process session for later interaction."),
  entry(toolNames.runChecks, codexModes, "process", "process-start", "Run bounded package.json scripts as a check group with per-check results, approval, and fail-fast support."),
  entry(toolNames.writeStdin, codexModes, "process", "process-session", "Poll or interact with one running process or check-group session."),

  entry(toolNames.changes, gitModes, "git", "shared-read", "Show current Git changes as a summary, stat, or bounded patch."),
  entry(toolNames.gitStatus, gitModes, "git", "shared-read", "Show the current Git branch and short workspace status."),
  entry(toolNames.gitDiff, gitModes, "git", "shared-read", "Show staged or unstaged Git diff output using fixed arguments."),
  entry(toolNames.gitAdd, gitModes, "git", "git-write", "Stage explicit workspace-relative paths using fixed Git arguments."),
  entry(toolNames.gitCommit, gitModes, "git", "git-write", "Commit staged changes with an explicit message using fixed Git arguments."),
  entry(toolNames.gitLog, gitModes, "git", "shared-read", "Show a bounded list of recent Git commits."),

  {
    ...entry(toolNames.showChanges, allModes, "git", "git-write", "Show aggregate workspace changes since the previous review checkpoint."),
    widgetMode: "changes",
  },
] as const;

const catalogByName = new Map(toolCatalog.map((tool) => [tool.name, tool]));

export function toolCatalogEntry(name: ToolName): ToolCatalogEntry {
  const tool = catalogByName.get(name);
  if (!tool) throw new Error(`Unknown LocalSpace tool: ${name}`);
  return tool;
}

export function toolSummary(name: ToolName): string {
  return toolCatalogEntry(name).summary;
}

export function toolNamesForMode(
  mode: ToolMode,
  widgets: WidgetMode = "off",
): ToolName[] {
  return toolCatalog
    .filter((tool) => tool.modes.includes(mode))
    .filter((tool) => !tool.widgetMode || tool.widgetMode === widgets)
    .map((tool) => tool.name);
}

export function toolAvailable(
  name: ToolName,
  mode: ToolMode,
  widgets: WidgetMode = "off",
): boolean {
  return toolNamesForMode(mode, widgets).includes(name);
}

export function renderToolSurfacesMarkdown(): string {
  const lines = [
    "# LocalSpace Tool Surfaces",
    "",
    "> Generated from `src/tool-catalog.ts`. Update the catalog, then regenerate this file; do not maintain a second handwritten tool list.",
    "",
    "Tool lists below use `LOCALSPACE_WIDGETS=off`. Widget-dependent additions are listed separately.",
    "",
  ];

  for (const mode of ["hybrid", "codex", "full", "minimal"] as const) {
    const tools = toolNamesForMode(mode, "off");
    lines.push(`## \`${mode}\` (${tools.length})`, "");
    for (const name of tools) lines.push(`- \`${name}\``);
    lines.push("");
  }

  lines.push(
    "## Widget overlays",
    "",
    "- `LOCALSPACE_WIDGETS=changes` adds `show_changes` to every tool mode.",
    "- `LOCALSPACE_WIDGETS=full` changes UI attachment only and does not add tools.",
    "- `LOCALSPACE_WIDGETS=off` exposes no widget-only tools.",
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

function entry(
  name: ToolName,
  modes: readonly ToolMode[],
  category: ToolCategory,
  concurrencyClass: ToolConcurrencyClass,
  summary: string,
): ToolCatalogEntry {
  return { name, modes, category, concurrencyClass, summary };
}
