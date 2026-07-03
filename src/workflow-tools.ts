import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findEntrypointsData, type EntrypointSearchResult } from "./entrypoints.js";
import type { AuditSummary } from "./audit-log.js";

const execFileAsync = promisify(execFile);

export interface WorkflowCommand {
  command: string;
  reason: string;
  required: boolean;
}

export interface ValidatePlanData {
  packageName?: string;
  commands: WorkflowCommand[];
  missingScripts: string[];
  notes: string[];
  text: string;
}

export interface WorkflowCheck {
  title: string;
  status: "ok" | "warn" | "action" | "info";
  detail: string;
}

export interface ReviewChecklistData {
  dirty: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  changedPaths: string[];
  checks: WorkflowCheck[];
  recommendedActions: string[];
  text: string;
}

export interface NextStep {
  priority: "high" | "medium" | "low";
  title: string;
  detail: string;
  suggestedTool?: string;
}

export interface NextStepsData {
  steps: NextStep[];
  text: string;
}

interface GitStatusSummary {
  isRepository: boolean;
  dirty: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  changedPaths: string[];
}

const PREFERRED_VALIDATION = [
  { name: "typecheck", command: "npm run typecheck", reason: "Check TypeScript and type-level regressions.", required: true },
  { name: "test", command: "npm test", reason: "Run the project test suite.", required: true },
  { name: "build", command: "npm run build", reason: "Verify production build and emitted artifacts.", required: true },
  { name: "lint", command: "npm run lint", reason: "Check style and static lint rules when configured.", required: false },
];

export async function createValidatePlan(workspaceRoot: string): Promise<ValidatePlanData> {
  const entrypoints = await findEntrypointsData(workspaceRoot);
  const scriptNames = new Set(entrypoints.scripts.map((script) => script.name));
  const commands = PREFERRED_VALIDATION
    .filter((item) => scriptNames.has(item.name))
    .map(({ command, reason, required }) => ({ command, reason, required }));
  const missingScripts = PREFERRED_VALIDATION
    .filter((item) => item.required && !scriptNames.has(item.name))
    .map((item) => item.name);
  const notes = validationNotes(entrypoints, commands, missingScripts);
  const data: ValidatePlanData = {
    packageName: entrypoints.packageInfo?.name,
    commands,
    missingScripts,
    notes,
    text: "",
  };
  data.text = formatValidatePlan(data);
  return data;
}

export async function createReviewChecklist(workspaceRoot: string): Promise<ReviewChecklistData> {
  const [validation, git] = await Promise.all([createValidatePlan(workspaceRoot), gitStatusSummary(workspaceRoot)]);
  const checks: WorkflowCheck[] = [];

  checks.push({
    title: "Inspect changes",
    status: git.dirty ? "action" : "ok",
    detail: git.dirty ? "Review current changes with changes/git_diff before summarizing or committing." : "Working tree is clean.",
  });
  checks.push({
    title: "Run validation",
    status: validation.commands.length > 0 ? "action" : "warn",
    detail: validation.commands.length > 0
      ? `Run ${validation.commands.map((command) => command.command).join(", ")}.`
      : "No standard validation scripts were detected.",
  });
  checks.push({
    title: "Check staging",
    status: git.staged ? "info" : git.dirty ? "action" : "ok",
    detail: git.staged ? "Some changes are staged; verify staged diff before committing." : git.dirty ? "No staged changes detected yet." : "No staged changes.",
  });
  checks.push({
    title: "Sensitive files",
    status: containsSensitiveLikePath(git.changedPaths) ? "warn" : "ok",
    detail: containsSensitiveLikePath(git.changedPaths)
      ? "Changed paths include secret/token/env-like filenames; inspect carefully before staging or committing."
      : "No secret/token/env-like changed paths detected by filename.",
  });

  const recommendedActions = recommendedReviewActions(git, validation);
  const data: ReviewChecklistData = {
    dirty: git.dirty,
    staged: git.staged,
    unstaged: git.unstaged,
    untracked: git.untracked,
    changedPaths: git.changedPaths,
    checks,
    recommendedActions,
    text: "",
  };
  data.text = formatReviewChecklist(data);
  return data;
}

export async function createNextSteps(workspaceRoot: string, audit?: AuditSummary): Promise<NextStepsData> {
  const [validation, checklist] = await Promise.all([
    createValidatePlan(workspaceRoot),
    createReviewChecklist(workspaceRoot),
  ]);
  const steps: NextStep[] = [];

  if (checklist.dirty) {
    steps.push({
      priority: "high",
      title: "Review current changes",
      detail: "Use changes or git_diff to inspect the working tree before making more edits or summarizing.",
      suggestedTool: "changes",
    });
  } else {
    steps.push({
      priority: "medium",
      title: "Start with project orientation",
      detail: "Use code_map or entrypoints before editing an unfamiliar area.",
      suggestedTool: "code_map",
    });
  }

  if (validation.commands.length > 0) {
    steps.push({
      priority: "high",
      title: "Run validation commands",
      detail: validation.commands.map((command) => command.command).join(" && "),
      suggestedTool: "exec_command",
    });
  }

  if (checklist.staged) {
    steps.push({
      priority: "medium",
      title: "Verify staged diff",
      detail: "Staged changes exist. Inspect staged changes before any commit.",
      suggestedTool: "git_diff",
    });
  }

  if ((audit?.blockedEvents ?? 0) > 0) {
    steps.push({
      priority: "medium",
      title: "Review blocked events",
      detail: `${audit?.blockedEvents} blocked event(s) were recorded recently. Confirm whether any require user approval or an alternative safer path.`,
      suggestedTool: "session_summary",
    });
  }

  if (steps.length === 0) {
    steps.push({
      priority: "low",
      title: "No immediate action",
      detail: "No dirty changes or validation scripts were detected.",
    });
  }

  const data: NextStepsData = { steps, text: "" };
  data.text = formatNextSteps(data);
  return data;
}

async function gitStatusSummary(workspaceRoot: string): Promise<GitStatusSummary> {
  try {
    const repo = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspaceRoot });
    if (repo.stdout.trim() !== "true") return emptyGitSummary(false);
    const status = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: workspaceRoot });
    const lines = status.stdout.split(/\r?\n/).filter(Boolean);
    const changedPaths = lines.map((line) => parseStatusPath(line)).filter(Boolean);
    return {
      isRepository: true,
      dirty: lines.length > 0,
      staged: lines.some((line) => line[0] !== " " && line[0] !== "?"),
      unstaged: lines.some((line) => line[1] !== " " || line.startsWith("??")),
      untracked: lines.some((line) => line.startsWith("??")),
      changedPaths,
    };
  } catch {
    return emptyGitSummary(false);
  }
}

function emptyGitSummary(isRepository: boolean): GitStatusSummary {
  return { isRepository, dirty: false, staged: false, unstaged: false, untracked: false, changedPaths: [] };
}

function parseStatusPath(line: string): string {
  const raw = line.slice(3).trim();
  const renamed = raw.split(" -> ").at(-1) ?? raw;
  return renamed.replace(/^"|"$/g, "");
}

function validationNotes(
  entrypoints: EntrypointSearchResult,
  commands: WorkflowCommand[],
  missingScripts: string[],
): string[] {
  const notes: string[] = [];
  if (!entrypoints.packageInfo) notes.push("package.json was not found; validation command discovery is limited.");
  if (commands.length === 0) notes.push("No standard validation commands detected.");
  if (missingScripts.length > 0) notes.push(`Missing common required scripts: ${missingScripts.join(", ")}.`);
  return notes;
}

function recommendedReviewActions(git: GitStatusSummary, validation: ValidatePlanData): string[] {
  const actions: string[] = [];
  if (git.dirty) actions.push("Inspect current changes with changes or git_diff.");
  if (validation.commands.length > 0) actions.push(`Run validation: ${validation.commands.map((command) => command.command).join("; ")}.`);
  if (git.staged) actions.push("Inspect staged diff before committing.");
  if (git.untracked) actions.push("Review untracked files before staging.");
  if (actions.length === 0) actions.push("No immediate review action required.");
  return actions;
}

function containsSensitiveLikePath(paths: string[]): boolean {
  return paths.some((path) => {
    const lower = path.toLowerCase();
    return lower.includes(".env") || lower.includes("secret") || lower.includes("token") || lower.includes("credential") || lower.includes("private") && lower.includes("key");
  });
}

function formatValidatePlan(data: ValidatePlanData): string {
  const lines = ["Validation plan", ""];
  if (data.packageName) lines.push(`Package: ${data.packageName}`, "");
  lines.push("Commands:");
  if (data.commands.length === 0) lines.push("- none detected");
  for (const command of data.commands) lines.push(`- ${command.command} (${command.required ? "required" : "optional"}): ${command.reason}`);
  lines.push("");
  lines.push("Notes:");
  if (data.notes.length === 0) lines.push("- none");
  for (const note of data.notes) lines.push(`- ${note}`);
  return lines.join("\n");
}

function formatReviewChecklist(data: ReviewChecklistData): string {
  const lines = ["Review checklist", ""];
  lines.push(`Dirty: ${data.dirty ? "yes" : "no"}`);
  lines.push(`Staged: ${data.staged ? "yes" : "no"}`);
  lines.push(`Unstaged: ${data.unstaged ? "yes" : "no"}`);
  lines.push(`Untracked: ${data.untracked ? "yes" : "no"}`);
  lines.push("");
  lines.push("Checks:");
  for (const check of data.checks) lines.push(`- ${check.status.toUpperCase()} ${check.title}: ${check.detail}`);
  lines.push("");
  lines.push("Recommended actions:");
  for (const action of data.recommendedActions) lines.push(`- ${action}`);
  if (data.changedPaths.length > 0) {
    lines.push("", "Changed paths:");
    for (const path of data.changedPaths.slice(0, 40)) lines.push(`- ${path}`);
    if (data.changedPaths.length > 40) lines.push(`- ... (${data.changedPaths.length - 40} more)`);
  }
  return lines.join("\n");
}

function formatNextSteps(data: NextStepsData): string {
  const lines = ["Next steps", ""];
  for (const step of data.steps) {
    lines.push(`- ${step.priority.toUpperCase()} ${step.title}: ${step.detail}${step.suggestedTool ? ` [${step.suggestedTool}]` : ""}`);
  }
  return lines.join("\n");
}
