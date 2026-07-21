import { lstat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AuditEvent, AuditSummary } from "./audit-log.js";
import { workspaceContentRevision } from "./workspace-revision.js";

export type AutomationSeverity = "info" | "warning" | "required";
export type ValidationFreshness = "not-required" | "current" | "stale" | "unknown";
export type ValidationEvidenceKind = "typecheck" | "test" | "build" | "lint" | "smoke" | "package";

export interface AutomationRecommendation {
  id: string;
  severity: AutomationSeverity;
  title: string;
  detail: string;
  matchedPaths: string[];
  suggestedTool?: string;
  suggestedCommand?: string;
}

export interface DeterministicAutomationData {
  changedPaths: string[];
  sourcePaths: string[];
  packagePaths: string[];
  sensitivePaths: string[];
  validationFreshness: ValidationFreshness;
  packageValidationFreshness: ValidationFreshness;
  validationEvidence: ValidationEvidenceKind[];
  latestChangeAt?: string;
  latestValidationAt?: string;
  commitReviewRequired: boolean;
  recommendations: AutomationRecommendation[];
  text: string;
}

interface ChangeTimeResult {
  latest?: number;
  complete: boolean;
}

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".less",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

const PACKAGE_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const MUTATION_TOOLS = new Set(["write", "edit", "apply_patch"]);

export async function createDeterministicAutomation(
  workspaceRoot: string,
  changedPaths: readonly string[],
  audit?: AuditSummary,
  options: { staged?: boolean } = {},
): Promise<DeterministicAutomationData> {
  const normalizedPaths = uniqueSorted(changedPaths.map(normalizeRelativePath).filter(Boolean));
  const sourcePaths = normalizedPaths.filter(isSourcePath);
  const packagePaths = normalizedPaths.filter(isPackagePath);
  const sensitivePaths = normalizedPaths.filter(isSensitiveLikePath);
  const validationRequired = sourcePaths.length > 0 || packagePaths.length > 0;
  const contentRevision = await workspaceContentRevision(workspaceRoot);
  const changeTime = await changedPathTime(workspaceRoot, normalizedPaths);
  const latestMutation = latestEventTime(
    (audit?.recentEvents ?? []).filter((event) => MUTATION_TOOLS.has(event.tool) && event.success),
  );
  const latestChange = maxDefined(changeTime.latest, latestMutation);
  const allValidationEvents = (audit?.recentEvents ?? []).filter(isSuccessfulValidationEvent);
  const revisionMatchedEvents = contentRevision
    ? allValidationEvents.filter((event) => event.workspaceRevision === contentRevision)
    : [];
  const legacyValidationEvents = allValidationEvents.filter((event) => !event.workspaceRevision);
  const validationEvents = [...revisionMatchedEvents, ...legacyValidationEvents];
  const latestValidation = latestEventTime(validationEvents);
  const latestPackageValidation = latestEventTime(
    validationEvents.filter((event) => validationKindForEvent(event) === "package"),
  );
  const validationEvidence = uniqueSorted(
    validationEvents
      .map(validationKindForEvent)
      .filter((kind): kind is ValidationEvidenceKind => Boolean(kind)),
  );
  const validationFreshness = determineValidationFreshness({
    required: validationRequired,
    latestChange,
    latestValidation,
    completeChangeTime: changeTime.complete || latestMutation !== undefined,
    revisionMatched: revisionMatchedEvents.length > 0,
  });
  const packageRevisionMatched = revisionMatchedEvents.some(
    (event) => validationKindForEvent(event) === "package",
  );
  const packageValidationFreshness = determineValidationFreshness({
    required: packagePaths.length > 0,
    latestChange,
    latestValidation: latestPackageValidation,
    completeChangeTime: changeTime.complete || latestMutation !== undefined,
    revisionMatched: packageRevisionMatched,
  });
  const recommendations = createRecommendations({
    sourcePaths,
    packagePaths,
    sensitivePaths,
    validationFreshness,
    packageValidationFreshness,
    staged: options.staged ?? false,
  });
  const data: DeterministicAutomationData = {
    changedPaths: normalizedPaths,
    sourcePaths,
    packagePaths,
    sensitivePaths,
    validationFreshness,
    packageValidationFreshness,
    validationEvidence,
    latestChangeAt: isoTime(latestChange),
    latestValidationAt: isoTime(latestValidation),
    commitReviewRequired: recommendations.some((recommendation) => recommendation.severity === "required"),
    recommendations,
    text: "",
  };
  data.text = formatDeterministicAutomation(data);
  return data;
}

export function validationEvidenceAction(value: string): string | undefined {
  const kind = classifyValidationEvidence(value);
  return kind ? `validation:${kind}` : undefined;
}

export function classifyValidationEvidence(value: string): ValidationEvidenceKind | undefined {
  const lower = value.toLowerCase();
  if (
    lower.includes("pack --dry-run")
    || lower.includes("pack --json")
    || lower.includes("package:dry-run")
  ) return "package";
  if (lower.includes("typecheck") || /(^|\s)tsc(\s|$)/.test(lower)) return "typecheck";
  if (lower.includes("lint") || lower.includes("eslint")) return "lint";
  if (lower.includes("build") || lower.includes("vite build")) return "build";
  if (lower.includes("test") || lower.includes("vitest") || lower.includes("jest")) return "test";
  if (lower.includes("smoke")) return "smoke";
  return undefined;
}

function createRecommendations(input: {
  sourcePaths: string[];
  packagePaths: string[];
  sensitivePaths: string[];
  validationFreshness: ValidationFreshness;
  packageValidationFreshness: ValidationFreshness;
  staged: boolean;
}): AutomationRecommendation[] {
  const recommendations: AutomationRecommendation[] = [];
  if (input.sourcePaths.length > 0) {
    recommendations.push({
      id: "format-after-source-change",
      severity: "info",
      title: "Review formatting",
      detail: "Source files changed. Run the project's configured formatter when one exists; LocalSpace does not execute formatting automatically.",
      matchedPaths: input.sourcePaths,
      suggestedTool: "run_checks",
    });
  }
  if (input.packagePaths.length > 0) {
    if (input.packageValidationFreshness === "current") {
      recommendations.push({
        id: "package-metadata-current",
        severity: "info",
        title: "Package dry-run evidence is current",
        detail: "A successful package dry-run was recorded after the latest detected package metadata change.",
        matchedPaths: input.packagePaths,
        suggestedTool: "validation_summary",
      });
    } else {
      recommendations.push({
        id: "package-metadata-dry-run",
        severity: "required",
        title: "Validate package metadata",
        detail: "Package metadata or a lockfile changed. Inspect lockfile consistency and run the package manager's dry-run packaging command before release or commit approval.",
        matchedPaths: input.packagePaths,
        suggestedTool: "exec_command",
        suggestedCommand: "npm pack --dry-run --json",
      });
    }
  }
  if (input.sensitivePaths.length > 0) {
    recommendations.push({
      id: "sensitive-change-review",
      severity: "required",
      title: "Review sensitive-looking paths",
      detail: "Changed paths include environment, credential, token, private-key, authentication, or workspace-policy names. Inspect content and staged diff before committing.",
      matchedPaths: input.sensitivePaths,
      suggestedTool: "git_diff",
    });
  }
  if (input.validationFreshness === "stale" || input.validationFreshness === "unknown") {
    recommendations.push({
      id: "validation-after-change",
      severity: "required",
      title: "Run validation after changes",
      detail: input.validationFreshness === "stale"
        ? "The latest recorded validation predates the current source or package changes."
        : "No reliable successful validation after the current source or package changes was found.",
      matchedPaths: uniqueSorted([...input.sourcePaths, ...input.packagePaths]),
      suggestedTool: "run_checks",
    });
  } else if (input.validationFreshness === "current") {
    recommendations.push({
      id: "validation-current",
      severity: "info",
      title: "Validation evidence is current",
      detail: "At least one successful validation event was recorded after the latest detected source or package change.",
      matchedPaths: uniqueSorted([...input.sourcePaths, ...input.packagePaths]),
      suggestedTool: "validation_summary",
    });
  }
  if (input.staged) {
    recommendations.push({
      id: "inspect-staged-diff",
      severity: "warning",
      title: "Inspect staged diff",
      detail: "Staged changes exist. Review the exact staged diff before committing.",
      matchedPaths: [],
      suggestedTool: "git_diff",
    });
  }
  return recommendations;
}

async function changedPathTime(root: string, paths: readonly string[]): Promise<ChangeTimeResult> {
  let latest: number | undefined;
  let complete = true;
  for (const path of paths) {
    const absolutePath = resolve(root, path);
    if (!isInsideRoot(root, absolutePath)) {
      complete = false;
      continue;
    }
    try {
      const info = await lstat(absolutePath);
      latest = maxDefined(latest, info.mtimeMs);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        complete = false;
        continue;
      }
      complete = false;
    }
  }
  return { latest, complete };
}

function determineValidationFreshness(input: {
  required: boolean;
  latestChange?: number;
  latestValidation?: number;
  completeChangeTime: boolean;
  revisionMatched: boolean;
}): ValidationFreshness {
  if (!input.required) return "not-required";
  if (input.revisionMatched) return "current";
  if (input.latestValidation === undefined) return "unknown";
  if (input.latestChange === undefined || !input.completeChangeTime) return "unknown";
  return input.latestValidation >= input.latestChange ? "current" : "stale";
}

function isSuccessfulValidationEvent(event: AuditEvent): boolean {
  if (!event.success || event.running === true) return false;
  if (event.exitCode !== undefined && event.exitCode !== 0) return false;
  return validationKindForEvent(event) !== undefined;
}

function validationKindForEvent(event: AuditEvent): ValidationEvidenceKind | undefined {
  if (event.action?.startsWith("validation:")) {
    const kind = event.action.slice("validation:".length);
    if (isValidationKind(kind)) return kind;
  }
  return event.commandPreview ? classifyValidationEvidence(event.commandPreview) : undefined;
}

function isValidationKind(value: string): value is ValidationEvidenceKind {
  return value === "typecheck"
    || value === "test"
    || value === "build"
    || value === "lint"
    || value === "smoke"
    || value === "package";
}

function latestEventTime(events: readonly AuditEvent[]): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    const value = Date.parse(event.time);
    if (Number.isFinite(value)) latest = maxDefined(latest, value);
  }
  return latest;
}

function isSourcePath(path: string): boolean {
  const lower = path.toLowerCase();
  if (SOURCE_EXTENSIONS.has(extname(lower))) return true;
  return /(^|\/)(vite|vitest|jest|eslint|rollup|webpack|tsup|astro|next|nuxt)\.config\.[^/]+$/.test(lower)
    || /(^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(lower);
}

function isPackagePath(path: string): boolean {
  return PACKAGE_FILES.has(basename(path).toLowerCase());
}

function isSensitiveLikePath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = basename(lower);
  return lower === ".localspace/policy.json"
    || name === ".npmrc"
    || name === ".pypirc"
    || name === "auth.json"
    || name === ".env"
    || name.startsWith(".env.")
    || lower.includes("secret")
    || lower.includes("token")
    || lower.includes("credential")
    || lower.includes("private") && lower.includes("key")
    || [".pem", ".key", ".p12", ".pfx"].includes(extname(lower));
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isInsideRoot(root: string, path: string): boolean {
  const relationship = relative(resolve(root), resolve(path));
  return relationship === ""
    || (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`));
}

function maxDefined(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.max(first, second);
}

function isoTime(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function formatDeterministicAutomation(data: DeterministicAutomationData): string {
  const lines = ["Deterministic automation", ""];
  lines.push(`Validation freshness: ${data.validationFreshness}`);
  lines.push(`Package validation freshness: ${data.packageValidationFreshness}`);
  lines.push(`Commit review required: ${data.commitReviewRequired ? "yes" : "no"}`);
  if (data.latestChangeAt) lines.push(`Latest detected change: ${data.latestChangeAt}`);
  if (data.latestValidationAt) lines.push(`Latest validation: ${data.latestValidationAt}`);
  lines.push("");
  lines.push("Recommendations:");
  if (data.recommendations.length === 0) lines.push("- none");
  for (const recommendation of data.recommendations) {
    lines.push(`- ${recommendation.severity.toUpperCase()} ${recommendation.title}: ${recommendation.detail}`);
  }
  return lines.join("\n");
}
