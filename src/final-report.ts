import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuditSummary } from "./audit-log.js";
import { createTaskSummary, createValidationSummary, type ValidationDetectedResult } from "./task-summary.js";

const execFileAsync = promisify(execFile);

export interface FinalReportOptions {
  taskTitle?: string;
  completed?: string[];
  remaining?: string[];
}

export interface HandoffSummaryOptions extends FinalReportOptions {
  currentPhase?: string;
  completedPhases?: string[];
  remainingTasks?: string[];
  knownWarnings?: string[];
  nextPrompt?: string;
}

export interface ReportGitState {
  isRepository: boolean;
  branch?: string;
  head?: string;
  latestCommit?: string;
  dirty: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface FinalReportData {
  taskTitle?: string;
  summary: string[];
  changedFiles: string[];
  git: ReportGitState;
  validation: {
    recommendedCommands: string[];
    recentExecCommands: number;
    recentFailures: number;
    recentSuccesses: number;
    detectedResults: ValidationDetectedResult[];
    notes: string[];
  };
  commit: {
    latestCommit?: string;
    suggestion: string;
  };
  warnings: string[];
  nextRecommendedStep: string;
  text: string;
}

export interface HandoffSummaryData {
  project: {
    root: string;
    branch?: string;
    latestCommit?: string;
  };
  currentPhase: string;
  completedPhases: string[];
  changedFiles: string[];
  validation: FinalReportData["validation"];
  remainingTasks: string[];
  knownWarnings: string[];
  nextRecommendedStep: string;
  suggestedFirstPrompt: string;
  text: string;
}

export async function createFinalReport(
  workspaceRoot: string,
  audit?: AuditSummary,
  options: FinalReportOptions = {},
): Promise<FinalReportData> {
  const [task, validation, git] = await Promise.all([
    createTaskSummary(workspaceRoot, audit),
    createValidationSummary(workspaceRoot, audit),
    reportGitState(workspaceRoot),
  ]);
  const warnings = mergeUnique([...task.warnings, ...validation.notes.filter((note) => note.toLowerCase().includes("disabled"))]);
  const data: FinalReportData = {
    taskTitle: options.taskTitle,
    summary: options.completed?.length ? options.completed : defaultSummary(task.git.dirty),
    changedFiles: task.changedPaths,
    git: {
      ...git,
      dirty: task.git.dirty,
      staged: task.git.staged,
      unstaged: task.git.unstaged,
      untracked: task.git.untracked,
    },
    validation: {
      recommendedCommands: validation.recommendedCommands,
      recentExecCommands: validation.recentExecCommands,
      recentFailures: validation.recentFailures,
      recentSuccesses: validation.recentSuccesses,
      detectedResults: validation.detectedResults,
      notes: validation.notes,
    },
    commit: {
      latestCommit: git.latestCommit,
      suggestion: commitSuggestion(task.git.dirty, task.git.staged, git.latestCommit),
    },
    warnings,
    nextRecommendedStep: nextRecommendedStep(task.git.dirty, validation.recentFailures, options.remaining),
    text: "",
  };
  data.text = formatFinalReport(data, options.remaining ?? []);
  return data;
}

export async function createHandoffSummary(
  workspaceRoot: string,
  audit?: AuditSummary,
  options: HandoffSummaryOptions = {},
): Promise<HandoffSummaryData> {
  const report = await createFinalReport(workspaceRoot, audit, options);
  const remainingTasks = mergeUnique([...(options.remainingTasks ?? []), ...(options.remaining ?? [])]);
  const knownWarnings = mergeUnique([...(options.knownWarnings ?? []), ...report.warnings]);
  const currentPhase = options.currentPhase ?? "unspecified";
  const suggestedFirstPrompt = options.nextPrompt ?? suggestedPrompt(workspaceRoot, currentPhase, remainingTasks);
  const data: HandoffSummaryData = {
    project: {
      root: workspaceRoot,
      branch: report.git.branch,
      latestCommit: report.git.latestCommit,
    },
    currentPhase,
    completedPhases: options.completedPhases ?? [],
    changedFiles: report.changedFiles,
    validation: report.validation,
    remainingTasks,
    knownWarnings,
    nextRecommendedStep: report.nextRecommendedStep,
    suggestedFirstPrompt,
    text: "",
  };
  data.text = formatHandoffSummary(data);
  return data;
}

async function reportGitState(workspaceRoot: string): Promise<ReportGitState> {
  try {
    const inside = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspaceRoot });
    if (inside.stdout.trim() !== "true") return emptyGitState(false);
    const [branch, head, latestCommit] = await Promise.all([
      gitOutput(workspaceRoot, ["branch", "--show-current"]),
      gitOutput(workspaceRoot, ["rev-parse", "--short", "HEAD"]),
      gitOutput(workspaceRoot, ["log", "--oneline", "-1"]),
    ]);
    return {
      isRepository: true,
      branch: branch || undefined,
      head: head || undefined,
      latestCommit: latestCommit || undefined,
      dirty: false,
      staged: false,
      unstaged: false,
      untracked: false,
    };
  } catch {
    return emptyGitState(false);
  }
}

async function gitOutput(workspaceRoot: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd: workspaceRoot });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

function emptyGitState(isRepository: boolean): ReportGitState {
  return { isRepository, dirty: false, staged: false, unstaged: false, untracked: false };
}

function defaultSummary(dirty: boolean): string[] {
  return dirty
    ? ["Workspace has changes that should be reviewed before the final user response or commit."]
    : ["Workspace is clean; summarize the latest completed work and next step."];
}

function commitSuggestion(dirty: boolean, staged: boolean, latestCommit: string | undefined): string {
  if (!dirty) return latestCommit ? `Working tree is clean. Latest commit: ${latestCommit}.` : "Working tree is clean.";
  if (staged) return "Staged changes exist; inspect staged diff before committing.";
  return "Uncommitted changes exist; review, validate, stage, and commit when ready.";
}

function nextRecommendedStep(dirty: boolean, recentFailures: number, remaining: string[] | undefined): string {
  if (recentFailures > 0) return "Review failed validation or tool events before proceeding.";
  if (dirty) return "Review current changes, run validation if needed, then commit.";
  if (remaining?.length) return remaining[0];
  return "Proceed to the next planned task.";
}

function mergeUnique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function formatFinalReport(data: FinalReportData, remaining: string[]): string {
  const lines = ["Final report", ""];
  if (data.taskTitle) lines.push(`Task: ${data.taskTitle}`, "");
  lines.push("Summary:");
  for (const item of data.summary) lines.push(`- ${item}`);
  lines.push("");

  lines.push("Changed files:");
  if (data.changedFiles.length === 0) lines.push("- none");
  for (const path of data.changedFiles.slice(0, 40)) lines.push(`- ${path}`);
  if (data.changedFiles.length > 40) lines.push(`- ... (${data.changedFiles.length - 40} more)`);
  lines.push("");

  lines.push("Git:");
  lines.push(`- branch: ${data.git.branch ?? "unknown"}`);
  lines.push(`- head: ${data.git.head ?? "unknown"}`);
  lines.push(`- dirty: ${data.git.dirty ? "yes" : "no"}`);
  lines.push(`- staged: ${data.git.staged ? "yes" : "no"}`);
  lines.push(`- unstaged: ${data.git.unstaged ? "yes" : "no"}`);
  lines.push(`- untracked: ${data.git.untracked ? "yes" : "no"}`);
  lines.push("");

  lines.push("Validation:");
  lines.push(`- recent exec_command events: ${data.validation.recentExecCommands}`);
  lines.push(`- successes: ${data.validation.recentSuccesses}`);
  lines.push(`- failures: ${data.validation.recentFailures}`);
  lines.push("- recommended commands:");
  if (data.validation.recommendedCommands.length === 0) lines.push("  - none detected");
  for (const command of data.validation.recommendedCommands) lines.push(`  - ${command}`);
  lines.push("- detected results:");
  if (data.validation.detectedResults.length === 0) lines.push("  - none");
  for (const result of data.validation.detectedResults.slice(0, 20)) {
    const status = result.passed === undefined ? "unknown" : result.passed ? "passed" : "failed";
    lines.push(`  - ${result.kind}: ${status}${result.command ? ` — ${result.command}` : ""}`);
  }
  lines.push("");

  lines.push("Commit:");
  lines.push(`- ${data.commit.suggestion}`);
  lines.push("");

  lines.push("Warnings:");
  if (data.warnings.length === 0) lines.push("- none");
  for (const warning of data.warnings) lines.push(`- ${warning}`);
  lines.push("");

  lines.push("Remaining tasks:");
  if (remaining.length === 0) lines.push("- none provided");
  for (const item of remaining) lines.push(`- ${item}`);
  lines.push("");

  lines.push("Next recommended step:");
  lines.push(`- ${data.nextRecommendedStep}`);
  return lines.join("\n");
}

function formatHandoffSummary(data: HandoffSummaryData): string {
  const lines = ["# LocalSpace Handoff Summary", ""];
  lines.push("## Project", "");
  lines.push("```text", data.project.root, "```");
  lines.push("");
  lines.push(`Branch: ${data.project.branch ?? "unknown"}`);
  lines.push(`Latest commit: ${data.project.latestCommit ?? "unknown"}`);
  lines.push("");

  lines.push("## Current phase", "");
  lines.push(data.currentPhase);
  lines.push("");

  lines.push("## Completed phases", "");
  if (data.completedPhases.length === 0) lines.push("- none provided");
  for (const item of data.completedPhases) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## Changed files", "");
  if (data.changedFiles.length === 0) lines.push("- none");
  for (const path of data.changedFiles.slice(0, 40)) lines.push(`- ${path}`);
  if (data.changedFiles.length > 40) lines.push(`- ... (${data.changedFiles.length - 40} more)`);
  lines.push("");

  lines.push("## Validation", "");
  lines.push(`- recent exec_command events: ${data.validation.recentExecCommands}`);
  lines.push(`- successes: ${data.validation.recentSuccesses}`);
  lines.push(`- failures: ${data.validation.recentFailures}`);
  lines.push("- recommended commands:");
  if (data.validation.recommendedCommands.length === 0) lines.push("  - none detected");
  for (const command of data.validation.recommendedCommands) lines.push(`  - ${command}`);
  lines.push("");

  lines.push("## Remaining tasks", "");
  if (data.remainingTasks.length === 0) lines.push("- none provided");
  for (const item of data.remainingTasks) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## Known warnings", "");
  if (data.knownWarnings.length === 0) lines.push("- none");
  for (const warning of data.knownWarnings) lines.push(`- ${warning}`);
  lines.push("");

  lines.push("## Next recommended step", "");
  lines.push(data.nextRecommendedStep);
  lines.push("");

  lines.push("## Suggested first prompt", "");
  lines.push("```text", data.suggestedFirstPrompt, "```");
  return lines.join("\n");
}

function suggestedPrompt(workspaceRoot: string, currentPhase: string, remainingTasks: string[]): string {
  const next = remainingTasks[0] ?? "continue the next planned task";
  return `@localspace Continue LocalSpace from ${currentPhase}. Open ${workspaceRoot}, confirm git status and latest commit, then ${next}.`;
}
