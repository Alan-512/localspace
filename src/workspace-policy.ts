import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandSafetyAnalysis } from "./command-safety.js";
import { KeyedMutex } from "./concurrency.js";
import { MAX_READ_MANY_FILES } from "./read-many.js";

export const WORKSPACE_POLICY_PATH = ".localspace/policy.json";
const WORKSPACE_POLICY_VERSION = 1;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_POLICY_PATHS = 200;
const MAX_POLICY_COMMAND_PATTERNS = 100;
const MAX_POLICY_PACKAGE_SCRIPTS = 200;
const MAX_POLICY_PATTERN_LENGTH = 256;
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/;
const POLICY_APPROVAL_TOOLS = new Set<PolicyApprovalTool>([
  "exec_command",
  "run_checks",
]);

export type PolicyApprovalTool = "exec_command" | "run_checks";
export type WorkspacePolicyStatus = "absent" | "active" | "anchored" | "invalid";

export interface WorkspacePolicyRules {
  readOnlyPaths: string[];
  deniedCommandPatterns: string[];
  allowedPackageScripts?: string[];
  maxReadManyFiles: number;
  allowCommands: boolean;
  allowPty: boolean;
  requireApprovalTools: PolicyApprovalTool[];
}

export interface WorkspacePolicySnapshot {
  status: WorkspacePolicyStatus;
  sourcePath: string;
  present: boolean;
  valid: boolean;
  failClosed: boolean;
  fingerprint?: string;
  rules: WorkspacePolicyRules;
  diagnostics: string[];
}

export interface WorkspacePolicySummary {
  status: WorkspacePolicyStatus;
  sourcePath: string;
  present: boolean;
  valid: boolean;
  failClosed: boolean;
  fingerprint?: string;
  readOnlyPaths: number;
  deniedCommandPatterns: number;
  allowedPackageScripts?: number;
  maxReadManyFiles: number;
  allowCommands: boolean;
  allowPty: boolean;
  requireApprovalTools: PolicyApprovalTool[];
  diagnostics: string[];
}

interface WorkspacePolicyDocument {
  version: 1;
  readOnlyPaths?: string[];
  deniedCommandPatterns?: string[];
  allowedPackageScripts?: string[];
  maxReadManyFiles?: number;
  allowCommands?: boolean;
  allowPty?: boolean;
  requireApprovalTools?: PolicyApprovalTool[];
}

interface PolicyAnchorDocument {
  version: 1;
  root: string;
  rules: WorkspacePolicyRules;
  fingerprint: string;
  updatedAt: string;
}

interface RootPolicyState {
  anchorLoaded: boolean;
  anchorRules?: WorkspacePolicyRules;
  anchorFingerprint?: string;
  anchorError?: string;
}

type PolicyFileRead =
  | { kind: "missing" }
  | { kind: "invalid"; diagnostic: string }
  | { kind: "valid"; rules: WorkspacePolicyRules; fingerprint: string };

const UNRESTRICTED_RULES: WorkspacePolicyRules = {
  readOnlyPaths: [],
  deniedCommandPatterns: [],
  allowedPackageScripts: undefined,
  maxReadManyFiles: MAX_READ_MANY_FILES,
  allowCommands: true,
  allowPty: true,
  requireApprovalTools: [],
};

const FAIL_CLOSED_RULES: WorkspacePolicyRules = {
  readOnlyPaths: ["."],
  deniedCommandPatterns: ["*"],
  allowedPackageScripts: [],
  maxReadManyFiles: 1,
  allowCommands: false,
  allowPty: false,
  requireApprovalTools: ["exec_command", "run_checks"],
};

export class WorkspacePolicyError extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(`Workspace policy blocked this operation (${rule}): ${message}`);
    this.name = "WorkspacePolicyError";
  }
}

export class WorkspacePolicyManager {
  private readonly roots = new Map<string, RootPolicyState>();
  private readonly resolutions = new KeyedMutex();

  constructor(private readonly stateDir: string) {}

  async resolve(root: string): Promise<WorkspacePolicySnapshot> {
    const trustRoot = comparableRoot(await realpath(resolve(root)));
    return this.resolutions.run(
      trustRoot,
      () => this.resolveLocked(trustRoot),
      { timeoutMs: 120_000 },
    );
  }

  private async resolveLocked(trustRoot: string): Promise<WorkspacePolicySnapshot> {
    const state = this.roots.get(trustRoot) ?? { anchorLoaded: false };
    this.roots.set(trustRoot, state);
    await this.loadAnchor(trustRoot, state);

    const sourcePath = join(trustRoot, WORKSPACE_POLICY_PATH);
    if (state.anchorError) {
      return invalidSnapshot(sourcePath, false, state.anchorRules, [state.anchorError]);
    }

    const current = await readPolicyFile(sourcePath);
    if (current.kind === "missing") {
      if (!state.anchorRules) return absentSnapshot(sourcePath);
      return activeSnapshot({
        status: "anchored",
        sourcePath,
        present: false,
        rules: state.anchorRules,
        fingerprint: state.anchorFingerprint ?? fingerprintRules(state.anchorRules),
        diagnostics: [
          "The project policy file is missing; previously anchored restrictions remain active.",
        ],
      });
    }

    if (current.kind === "invalid") {
      return invalidSnapshot(sourcePath, true, state.anchorRules, [current.diagnostic]);
    }

    const effectiveRules = state.anchorRules
      ? mergePolicyRules(state.anchorRules, current.rules)
      : current.rules;
    const effectiveFingerprint = fingerprintRules(effectiveRules);
    const diagnostics: string[] = [];
    const status: WorkspacePolicyStatus = rulesEqual(effectiveRules, current.rules)
      ? "active"
      : "anchored";
    if (status === "anchored") {
      diagnostics.push(
        "A policy relaxation was ignored because persisted restrictions for this workspace are stricter.",
      );
    }

    if (state.anchorFingerprint !== effectiveFingerprint) {
      try {
        await this.persistAnchor(trustRoot, effectiveRules, effectiveFingerprint);
        state.anchorRules = effectiveRules;
        state.anchorFingerprint = effectiveFingerprint;
      } catch (error) {
        return invalidSnapshot(sourcePath, true, state.anchorRules, [
          `Unable to persist the workspace policy anchor: ${errorMessage(error)}`,
        ]);
      }
    }

    return activeSnapshot({
      status,
      sourcePath,
      present: true,
      rules: effectiveRules,
      fingerprint: effectiveFingerprint,
      diagnostics,
    });
  }

  private async loadAnchor(root: string, state: RootPolicyState): Promise<void> {
    if (state.anchorLoaded) return;
    state.anchorLoaded = true;
    const path = this.anchorPath(root);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return;
      state.anchorError = `Unable to read the persisted workspace policy anchor: ${errorMessage(error)}`;
      return;
    }

    try {
      const parsed = JSON.parse(content) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1 || parsed.root !== root) {
        throw new Error("Anchor metadata does not match this workspace root.");
      }
      const rules = parsePolicyRules(parsed.rules, "anchor rules");
      const fingerprint = fingerprintRules(rules);
      if (parsed.fingerprint !== fingerprint) {
        throw new Error("Anchor fingerprint does not match its policy rules.");
      }
      state.anchorRules = rules;
      state.anchorFingerprint = fingerprint;
    } catch (error) {
      state.anchorError = `Invalid persisted workspace policy anchor: ${errorMessage(error)}`;
    }
  }

  private async persistAnchor(
    root: string,
    rules: WorkspacePolicyRules,
    fingerprint: string,
  ): Promise<void> {
    const path = this.anchorPath(root);
    const document: PolicyAnchorDocument = {
      version: 1,
      root,
      rules,
      fingerprint,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(join(this.stateDir, "policy-anchors"), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private anchorPath(root: string): string {
    const key = createHash("sha256").update(root).digest("hex");
    return join(this.stateDir, "policy-anchors", `${key}.json`);
  }
}

export function workspacePolicySummary(snapshot: WorkspacePolicySnapshot): WorkspacePolicySummary {
  return {
    status: snapshot.status,
    sourcePath: WORKSPACE_POLICY_PATH,
    present: snapshot.present,
    valid: snapshot.valid,
    failClosed: snapshot.failClosed,
    fingerprint: snapshot.fingerprint,
    readOnlyPaths: snapshot.rules.readOnlyPaths.length,
    deniedCommandPatterns: snapshot.rules.deniedCommandPatterns.length,
    allowedPackageScripts: snapshot.rules.allowedPackageScripts?.length,
    maxReadManyFiles: snapshot.rules.maxReadManyFiles,
    allowCommands: snapshot.rules.allowCommands,
    allowPty: snapshot.rules.allowPty,
    requireApprovalTools: [...snapshot.rules.requireApprovalTools],
    diagnostics: [...snapshot.diagnostics],
  };
}

export function assertPolicyMutationAllowed(snapshot: WorkspacePolicySnapshot): void {
  if (snapshot.failClosed) {
    throw new WorkspacePolicyError(
      "invalid-policy",
      snapshot.diagnostics.join(" ") || "The workspace policy is invalid.",
    );
  }
}

export function assertPolicyWritablePaths(
  snapshot: WorkspacePolicySnapshot,
  workspaceRoot: string,
  paths: readonly string[],
): void {
  assertPolicyMutationAllowed(snapshot);
  for (const path of paths) {
    const normalized = relativePolicyPath(workspaceRoot, path);
    const matched = snapshot.rules.readOnlyPaths.find((candidate) =>
      sameOrInsidePolicyPath(normalized, candidate)
    );
    if (matched) {
      throw new WorkspacePolicyError(
        "readOnlyPaths",
        `${normalized} is protected by read-only policy path ${matched}.`,
      );
    }
  }
}

export function assertPolicyGitAddPaths(
  snapshot: WorkspacePolicySnapshot,
  workspaceRoot: string,
  paths: readonly string[],
): void {
  assertPolicyMutationAllowed(snapshot);
  for (const path of paths) {
    const normalized = relativePolicyPath(workspaceRoot, path);
    const matched = snapshot.rules.readOnlyPaths.find((candidate) =>
      sameOrInsidePolicyPath(normalized, candidate)
      || sameOrInsidePolicyPath(candidate, normalized)
    );
    if (matched) {
      throw new WorkspacePolicyError(
        "readOnlyPaths",
        `${normalized} may stage protected policy path ${matched}; git_add requires explicit unprotected file paths.`,
      );
    }
  }
}

export function assertPolicyCommandAllowed(
  snapshot: WorkspacePolicySnapshot,
  command: string,
  tty: boolean | undefined,
): void {
  if (snapshot.failClosed) {
    throw new WorkspacePolicyError(
      "invalid-policy",
      snapshot.diagnostics.join(" ") || "The workspace policy is invalid.",
    );
  }
  if (!snapshot.rules.allowCommands) {
    throw new WorkspacePolicyError("allowCommands", "Arbitrary shell commands are disabled.");
  }
  if (tty && !snapshot.rules.allowPty) {
    throw new WorkspacePolicyError("allowPty", "Pseudo-terminal allocation is disabled.");
  }
  const normalized = command.trim().toLowerCase();
  const matched = snapshot.rules.deniedCommandPatterns.find((pattern) =>
    wildcardMatch(pattern.toLowerCase(), normalized)
  );
  if (matched) {
    throw new WorkspacePolicyError(
      "deniedCommandPatterns",
      `Command matches denied pattern ${JSON.stringify(matched)}.`,
    );
  }
}

export function assertPolicyPackageScriptsAllowed(
  snapshot: WorkspacePolicySnapshot,
  checks: readonly (string | { name: string; scriptNames?: readonly string[] })[],
): void {
  if (snapshot.failClosed) {
    throw new WorkspacePolicyError(
      "invalid-policy",
      snapshot.diagnostics.join(" ") || "The workspace policy is invalid.",
    );
  }
  const allowed = snapshot.rules.allowedPackageScripts;
  if (!allowed) return;
  const requested = checks.flatMap((check) =>
    typeof check === "string" ? [check] : check.scriptNames ?? [check.name]
  );
  const blocked = uniqueSorted(requested.filter((check) => !allowed.includes(check)));
  if (blocked.length > 0) {
    throw new WorkspacePolicyError(
      "allowedPackageScripts",
      `Package scripts are not allowed: ${blocked.join(", ")}.`,
    );
  }
}

export function assertPolicyReadManyAllowed(
  snapshot: WorkspacePolicySnapshot,
  requestedFiles: number,
): void {
  if (requestedFiles > snapshot.rules.maxReadManyFiles) {
    throw new WorkspacePolicyError(
      "maxReadManyFiles",
      `Requested ${requestedFiles} files; policy maximum is ${snapshot.rules.maxReadManyFiles}.`,
    );
  }
}

export function policyRequiresApproval(
  snapshot: WorkspacePolicySnapshot,
  tool: PolicyApprovalTool,
): boolean {
  return snapshot.rules.requireApprovalTools.includes(tool);
}

export function commandSafetyWithPolicyApproval(
  safety: CommandSafetyAnalysis,
  snapshot: WorkspacePolicySnapshot,
  tool: PolicyApprovalTool,
): CommandSafetyAnalysis {
  if (!policyRequiresApproval(snapshot, tool)) return safety;
  const finding = {
    level: "danger" as const,
    category: "workspace-policy",
    message: `Workspace policy requires explicit approval for ${tool}.`,
  };
  return {
    level: "danger",
    findings: safety.findings.some((candidate) =>
      candidate.category === finding.category && candidate.message === finding.message
    )
      ? safety.findings
      : [...safety.findings, finding],
  };
}

export function isWorkspacePolicyPath(workspaceRoot: string, path: string): boolean {
  return relativePolicyPath(workspaceRoot, path).toLowerCase() === WORKSPACE_POLICY_PATH.toLowerCase();
}

function absentSnapshot(sourcePath: string): WorkspacePolicySnapshot {
  return {
    status: "absent",
    sourcePath,
    present: false,
    valid: true,
    failClosed: false,
    rules: cloneRules(UNRESTRICTED_RULES),
    diagnostics: [],
  };
}

function invalidSnapshot(
  sourcePath: string,
  present: boolean,
  anchored: WorkspacePolicyRules | undefined,
  diagnostics: string[],
): WorkspacePolicySnapshot {
  const rules = mergePolicyRules(anchored ?? UNRESTRICTED_RULES, FAIL_CLOSED_RULES);
  return {
    status: "invalid",
    sourcePath,
    present,
    valid: false,
    failClosed: true,
    fingerprint: anchored ? fingerprintRules(anchored) : undefined,
    rules,
    diagnostics,
  };
}

function activeSnapshot(input: {
  status: "active" | "anchored";
  sourcePath: string;
  present: boolean;
  rules: WorkspacePolicyRules;
  fingerprint: string;
  diagnostics: string[];
}): WorkspacePolicySnapshot {
  return {
    ...input,
    valid: true,
    failClosed: false,
    rules: cloneRules(input.rules),
  };
}

async function readPolicyFile(path: string): Promise<PolicyFileRead> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return {
        kind: "invalid",
        diagnostic: `${WORKSPACE_POLICY_PATH} may not be a symbolic link.`,
      };
    }
    if (!info.isFile()) {
      return { kind: "invalid", diagnostic: `${WORKSPACE_POLICY_PATH} must be a regular file.` };
    }
    if (info.size > MAX_POLICY_BYTES) {
      return {
        kind: "invalid",
        diagnostic: `${WORKSPACE_POLICY_PATH} exceeds the ${MAX_POLICY_BYTES}-byte limit.`,
      };
    }
    const content = await readFile(path, "utf8");
    const parsed = parsePolicyDocument(JSON.parse(content) as unknown);
    return {
      kind: "valid",
      rules: parsed,
      fingerprint: fingerprintRules(parsed),
    };
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return { kind: "missing" };
    return {
      kind: "invalid",
      diagnostic: `Unable to parse ${WORKSPACE_POLICY_PATH}: ${errorMessage(error)}`,
    };
  }
}

function parsePolicyDocument(value: unknown): WorkspacePolicyRules {
  if (!isRecord(value)) throw new Error("Policy must be a JSON object.");
  const allowedKeys = new Set([
    "version",
    "readOnlyPaths",
    "deniedCommandPatterns",
    "allowedPackageScripts",
    "maxReadManyFiles",
    "allowCommands",
    "allowPty",
    "requireApprovalTools",
  ]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown policy fields: ${unknownKeys.join(", ")}.`);
  }
  if (value.version !== WORKSPACE_POLICY_VERSION) {
    throw new Error(`Policy version must be ${WORKSPACE_POLICY_VERSION}.`);
  }
  return parsePolicyRules(value, "policy");
}

function parsePolicyRules(value: unknown, label: string): WorkspacePolicyRules {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  const readOnlyPaths = parseStringArray(
    value.readOnlyPaths,
    `${label}.readOnlyPaths`,
    MAX_POLICY_PATHS,
  ).map(normalizePolicyPath);
  const deniedCommandPatterns = parseStringArray(
    value.deniedCommandPatterns,
    `${label}.deniedCommandPatterns`,
    MAX_POLICY_COMMAND_PATTERNS,
  ).map((pattern) => {
    if (pattern.length > MAX_POLICY_PATTERN_LENGTH) {
      throw new Error(`${label}.deniedCommandPatterns entries may not exceed ${MAX_POLICY_PATTERN_LENGTH} characters.`);
    }
    return pattern;
  });
  const allowedPackageScripts = value.allowedPackageScripts === undefined
    ? undefined
    : parseStringArray(
        value.allowedPackageScripts,
        `${label}.allowedPackageScripts`,
        MAX_POLICY_PACKAGE_SCRIPTS,
      ).map((script) => {
        if (!SAFE_SCRIPT_NAME.test(script)) {
          throw new Error(`Invalid package script name in ${label}: ${script}`);
        }
        return script;
      });
  const maxReadManyFiles = value.maxReadManyFiles === undefined
    ? MAX_READ_MANY_FILES
    : parseBoundedInteger(value.maxReadManyFiles, `${label}.maxReadManyFiles`, 1, MAX_READ_MANY_FILES);
  const allowCommands = parseOptionalBoolean(value.allowCommands, `${label}.allowCommands`) ?? true;
  const allowPty = parseOptionalBoolean(value.allowPty, `${label}.allowPty`) ?? true;
  const requireApprovalTools = parseStringArray(
    value.requireApprovalTools,
    `${label}.requireApprovalTools`,
    POLICY_APPROVAL_TOOLS.size,
  ).map((tool) => {
    if (!POLICY_APPROVAL_TOOLS.has(tool as PolicyApprovalTool)) {
      throw new Error(`Unsupported policy approval tool: ${tool}`);
    }
    return tool as PolicyApprovalTool;
  });

  return {
    readOnlyPaths: uniqueSorted(readOnlyPaths),
    deniedCommandPatterns: uniqueSorted(deniedCommandPatterns),
    allowedPackageScripts: allowedPackageScripts === undefined
      ? undefined
      : uniqueSorted(allowedPackageScripts),
    maxReadManyFiles,
    allowCommands,
    allowPty,
    requireApprovalTools: uniqueSorted(requireApprovalTools),
  };
}

function parseStringArray(value: unknown, label: string, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > maximum) throw new Error(`${label} may contain at most ${maximum} entries.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${label}[${index}] must be a non-empty string.`);
    }
    return entry.trim();
  });
}

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function parseBoundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function normalizePolicyPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized) throw new Error("Policy paths may not be empty.");
  if (isAbsolute(path) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Policy paths must be workspace-relative: ${path}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new Error(`Policy paths may not escape the workspace: ${path}`);
  }
  return normalized === "." ? "." : segments.join("/");
}

function mergePolicyRules(
  first: WorkspacePolicyRules,
  second: WorkspacePolicyRules,
): WorkspacePolicyRules {
  return {
    readOnlyPaths: uniqueSorted([...first.readOnlyPaths, ...second.readOnlyPaths]),
    deniedCommandPatterns: uniqueSorted([
      ...first.deniedCommandPatterns,
      ...second.deniedCommandPatterns,
    ]),
    allowedPackageScripts: intersectAllowedScripts(
      first.allowedPackageScripts,
      second.allowedPackageScripts,
    ),
    maxReadManyFiles: Math.min(first.maxReadManyFiles, second.maxReadManyFiles),
    allowCommands: first.allowCommands && second.allowCommands,
    allowPty: first.allowPty && second.allowPty,
    requireApprovalTools: uniqueSorted([
      ...first.requireApprovalTools,
      ...second.requireApprovalTools,
    ]),
  };
}

function intersectAllowedScripts(
  first: string[] | undefined,
  second: string[] | undefined,
): string[] | undefined {
  if (first === undefined) return second === undefined ? undefined : [...second];
  if (second === undefined) return [...first];
  const secondSet = new Set(second);
  return first.filter((entry) => secondSet.has(entry)).sort();
}

function fingerprintRules(rules: WorkspacePolicyRules): string {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex");
}

function rulesEqual(first: WorkspacePolicyRules, second: WorkspacePolicyRules): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function cloneRules(rules: WorkspacePolicyRules): WorkspacePolicyRules {
  return {
    ...rules,
    readOnlyPaths: [...rules.readOnlyPaths],
    deniedCommandPatterns: [...rules.deniedCommandPatterns],
    allowedPackageScripts: rules.allowedPackageScripts
      ? [...rules.allowedPackageScripts]
      : undefined,
    requireApprovalTools: [...rules.requireApprovalTools],
  };
}

function relativePolicyPath(workspaceRoot: string, path: string): string {
  return relative(resolve(workspaceRoot), resolve(path)).split(sep).join("/") || ".";
}

function sameOrInsidePolicyPath(path: string, policyPath: string): boolean {
  const comparablePath = comparablePolicyPath(path);
  const comparablePolicy = comparablePolicyPath(policyPath);
  return comparablePolicy === "."
    || comparablePath === comparablePolicy
    || comparablePath.startsWith(`${comparablePolicy}/`);
}

function comparablePolicyPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function comparableRoot(path: string): string {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

function wildcardMatch(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starValueIndex = -1;
  while (valueIndex < value.length) {
    if (
      patternIndex < pattern.length
      && (pattern[patternIndex] === "?" || pattern[patternIndex] === value[valueIndex])
    ) {
      patternIndex += 1;
      valueIndex += 1;
      continue;
    }
    if (pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      starValueIndex = valueIndex;
      patternIndex += 1;
      continue;
    }
    if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
      continue;
    }
    return false;
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isErrnoCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
