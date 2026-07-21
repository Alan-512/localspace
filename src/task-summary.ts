import type { AuditEvent, AuditSummary } from "./audit-log.js";
import { createReviewChecklist, createValidatePlan } from "./workflow-tools.js";
import type { DeterministicAutomationData } from "./deterministic-automation.js";

export interface TaskSummaryData {
  changedPaths: string[];
  git: {
    dirty: boolean;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
  };
  audit: {
    totalEvents: number;
    blockedEvents: number;
    approvedEvents: number;
    tools: Record<string, number>;
  };
  validation: {
    recommendedCommands: string[];
  };
  automation: DeterministicAutomationData;
  recommendedFinalResponse: string[];
  warnings: string[];
  text: string;
}

export type ValidationResultKind = "typecheck" | "test" | "build" | "lint" | "smoke" | "other";

export interface ValidationDetectedResult {
  kind: ValidationResultKind;
  command?: string;
  exitCode?: number;
  passed?: boolean;
}

export interface ValidationSummaryData {
  commandPreviewEnabled: boolean;
  recommendedCommands: string[];
  recentExecCommands: number;
  recentFailures: number;
  recentSuccesses: number;
  detectedResults: ValidationDetectedResult[];
  automation: DeterministicAutomationData;
  notes: string[];
  text: string;
}

export async function createTaskSummary(workspaceRoot: string, audit?: AuditSummary): Promise<TaskSummaryData> {
  const [checklist, validation] = await Promise.all([
    createReviewChecklist(workspaceRoot, audit),
    createValidatePlan(workspaceRoot),
  ]);
  const recommendedCommands = validation.commands.map((command) => command.command);
  const warnings = taskWarnings(checklist, validation, audit);
  const data: TaskSummaryData = {
    changedPaths: checklist.changedPaths,
    git: {
      dirty: checklist.dirty,
      staged: checklist.staged,
      unstaged: checklist.unstaged,
      untracked: checklist.untracked,
    },
    audit: summarizeAudit(audit),
    validation: {
      recommendedCommands,
    },
    automation: checklist.automation,
    recommendedFinalResponse: recommendedFinalResponse(checklist.dirty, recommendedCommands, warnings),
    warnings,
    text: "",
  };
  data.text = formatTaskSummary(data);
  return data;
}

export async function createValidationSummary(workspaceRoot: string, audit?: AuditSummary): Promise<ValidationSummaryData> {
  const [validation, checklist] = await Promise.all([
    createValidatePlan(workspaceRoot),
    createReviewChecklist(workspaceRoot, audit),
  ]);
  const recommendedCommands = validation.commands.map((command) => command.command);
  const validationEvents = (audit?.recentEvents ?? []).filter(
    (event) => event.tool === "exec_command" || event.tool === "run_checks",
  );
  const commandEvents = validationEvents.filter((event) => event.commandPreview);
  const detectedResults = commandEvents.map((event) => detectedValidationResult(event));
  const data: ValidationSummaryData = {
    commandPreviewEnabled: commandEvents.length > 0,
    recommendedCommands,
    recentExecCommands: validationEvents.length,
    recentFailures: validationEvents.filter((event) => !event.success).length,
    recentSuccesses: validationEvents.filter((event) => event.success).length,
    detectedResults,
    automation: checklist.automation,
    notes: validationSummaryNotes(validationEvents, commandEvents, validation.notes),
    text: "",
  };
  data.text = formatValidationSummary(data);
  return data;
}

function summarizeAudit(audit: AuditSummary | undefined): TaskSummaryData["audit"] {
  return {
    totalEvents: audit?.totalEvents ?? 0,
    blockedEvents: audit?.blockedEvents ?? 0,
    approvedEvents: audit?.approvedEvents ?? 0,
    tools: audit?.tools ?? {},
  };
}

function taskWarnings(
  checklist: Awaited<ReturnType<typeof createReviewChecklist>>,
  validation: Awaited<ReturnType<typeof createValidatePlan>>,
  audit: AuditSummary | undefined,
): string[] {
  const warnings: string[] = [];
  for (const check of checklist.checks) {
    if (check.status === "warn") warnings.push(check.detail);
  }
  if (validation.commands.length === 0) warnings.push("No standard validation commands were detected.");
  if (checklist.automation.commitReviewRequired) {
    const required = checklist.automation.recommendations.filter(
      (recommendation) => recommendation.severity === "required",
    );
    warnings.push(
      `Deterministic commit review has ${required.length} required recommendation(s): ${required.map((item) => item.title).join(", ")}.`,
    );
  }
  if ((audit?.blockedEvents ?? 0) > 0) warnings.push(`${audit?.blockedEvents} blocked tool event(s) were recorded recently.`);
  const failedEvents = audit?.recentEvents.filter((event) => !event.success).length ?? 0;
  if (failedEvents > 0) warnings.push(`${failedEvents} recent audit event(s) failed; review session_summary for details.`);
  return [...new Set(warnings)];
}

function recommendedFinalResponse(dirty: boolean, recommendedCommands: string[], warnings: string[]): string[] {
  const items = [
    "Summarize the completed implementation or investigation.",
    dirty ? "List changed files and current Git state." : "State that the working tree is clean.",
  ];
  if (recommendedCommands.length > 0) items.push("Report validation commands that were run or still need to be run.");
  if (warnings.length > 0) items.push("Call out warnings or remaining risks explicitly.");
  items.push("Describe the next recommended step.");
  return items;
}

function detectedValidationResult(event: AuditEvent): ValidationDetectedResult {
  const command = event.commandPreview;
  return {
    kind: classifyValidationCommand(command ?? ""),
    command,
    exitCode: event.exitCode,
    passed: event.exitCode === undefined ? undefined : event.exitCode === 0,
  };
}

function classifyValidationCommand(command: string): ValidationResultKind {
  const lower = command.toLowerCase();
  if (lower.includes("typecheck") || lower.includes("tsc")) return "typecheck";
  if (lower.includes("lint") || lower.includes("eslint")) return "lint";
  if (lower.includes("build") || lower.includes("vite build")) return "build";
  if (lower.includes("smoke") || lower.includes("node -e")) return "smoke";
  if (lower.includes("test") || lower.includes("vitest") || lower.includes("jest")) return "test";
  return "other";
}

function validationSummaryNotes(validationEvents: AuditEvent[], commandEvents: AuditEvent[], validationNotes: string[]): string[] {
  const notes = [...validationNotes];
  if (validationEvents.length === 0) {
    notes.push("No recent exec_command or run_checks events were found in the audit summary.");
  }
  if (validationEvents.length > 0 && commandEvents.length === 0) {
    notes.push("Command preview logging is disabled; exact validation commands cannot be classified from audit events.");
  }
  if (commandEvents.length > 0 && commandEvents.length < validationEvents.length) {
    notes.push("Some recent validation events did not include command previews and could not be classified.");
  }
  return [...new Set(notes)];
}

function formatTaskSummary(data: TaskSummaryData): string {
  const lines = ["Task summary", ""];
  lines.push(`Dirty: ${data.git.dirty ? "yes" : "no"}`);
  lines.push(`Staged: ${data.git.staged ? "yes" : "no"}`);
  lines.push(`Unstaged: ${data.git.unstaged ? "yes" : "no"}`);
  lines.push(`Untracked: ${data.git.untracked ? "yes" : "no"}`);
  lines.push(`Validation freshness: ${data.automation.validationFreshness}`);
  lines.push(`Package validation freshness: ${data.automation.packageValidationFreshness}`);
  lines.push(`Commit review required: ${data.automation.commitReviewRequired ? "yes" : "no"}`);
  lines.push("");

  lines.push("Changed paths:");
  if (data.changedPaths.length === 0) lines.push("- none");
  for (const path of data.changedPaths.slice(0, 40)) lines.push(`- ${path}`);
  if (data.changedPaths.length > 40) lines.push(`- ... (${data.changedPaths.length - 40} more)`);
  lines.push("");

  lines.push("Audit:");
  lines.push(`- events: ${data.audit.totalEvents}`);
  lines.push(`- blocked: ${data.audit.blockedEvents}`);
  lines.push(`- approved: ${data.audit.approvedEvents}`);
  lines.push("- tools:");
  const tools = Object.entries(data.audit.tools).sort();
  if (tools.length === 0) lines.push("  - none");
  for (const [tool, count] of tools) lines.push(`  - ${tool}: ${count}`);
  lines.push("");

  lines.push("Recommended validation:");
  if (data.validation.recommendedCommands.length === 0) lines.push("- none detected");
  for (const command of data.validation.recommendedCommands) lines.push(`- ${command}`);
  lines.push("");

  lines.push("Warnings:");
  if (data.warnings.length === 0) lines.push("- none");
  for (const warning of data.warnings) lines.push(`- ${warning}`);
  lines.push("");

  lines.push("Recommended final response:");
  for (const item of data.recommendedFinalResponse) lines.push(`- ${item}`);
  return lines.join("\n");
}

function formatValidationSummary(data: ValidationSummaryData): string {
  const lines = ["Validation summary", ""];
  lines.push(`Command previews: ${data.commandPreviewEnabled ? "enabled" : "not available"}`);
  lines.push(`Recent exec_command events: ${data.recentExecCommands}`);
  lines.push(`Recent successes: ${data.recentSuccesses}`);
  lines.push(`Recent failures: ${data.recentFailures}`);
  lines.push(`Validation freshness: ${data.automation.validationFreshness}`);
  lines.push(`Package validation freshness: ${data.automation.packageValidationFreshness}`);
  lines.push(`Commit review required: ${data.automation.commitReviewRequired ? "yes" : "no"}`);
  lines.push("");

  lines.push("Detected results:");
  if (data.detectedResults.length === 0) lines.push("- none");
  for (const result of data.detectedResults.slice(0, 30)) {
    const status = result.passed === undefined ? "unknown" : result.passed ? "passed" : "failed";
    const exitCode = result.exitCode === undefined ? "unknown" : result.exitCode;
    lines.push(`- ${result.kind}: ${status} (exit ${exitCode})${result.command ? ` — ${result.command}` : ""}`);
  }
  if (data.detectedResults.length > 30) lines.push(`- ... (${data.detectedResults.length - 30} more)`);
  lines.push("");

  lines.push("Recommended validation:");
  if (data.recommendedCommands.length === 0) lines.push("- none detected");
  for (const command of data.recommendedCommands) lines.push(`- ${command}`);
  lines.push("");

  lines.push("Notes:");
  if (data.notes.length === 0) lines.push("- none");
  for (const note of data.notes) lines.push(`- ${note}`);
  return lines.join("\n");
}
