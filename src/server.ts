import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { relative } from "node:path";
import { readFileSync } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch, parsePatch } from "./apply-patch.js";
import { AuditLogManager } from "./audit-log.js";
import { CommandApprovalManager } from "./command-approval.js";
import {
  DEFAULT_TOOL_CONCURRENCY,
  loadConfig,
  type ServerConfig,
  type ToolConcurrencyConfig,
  type WidgetMode,
} from "./config.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./local-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { getGitChangesData } from "./git-changes.js";
import { gitAddData, gitCommitData, gitDiffData, gitLogData, gitStagedPaths, gitStatusData } from "./git-tools.js";
import { generateDoctorReportData, generateWorkspaceInfoData } from "./diagnostics.js";
import {
  analyzeCommandSafety,
  commandInvokesGitCommit,
  formatCommandSafetyWarning,
  type CommandSafetyAnalysis,
} from "./command-safety.js";
import { generateCodeMapData } from "./code-map.js";
import { findImportsData, findReferencesData } from "./code-navigation.js";
import { findEntrypointsData } from "./entrypoints.js";
import { generateProjectMap } from "./project-map.js";
import { findSymbolsData } from "./symbols.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { assertWritablePath, assertWritablePaths } from "./sensitive-paths.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { workspaceContentRevision, workspaceRevision } from "./workspace-revision.js";
import { formatAgentsPath, WorkspaceRegistry, type Workspace } from "./workspaces.js";
import { createFinalReport, createHandoffSummary } from "./final-report.js";
import { createTaskSummary, createValidationSummary } from "./task-summary.js";
import { createNextSteps, createReviewChecklist, createValidatePlan } from "./workflow-tools.js";
import {
  createDeterministicAutomation,
  validationEvidenceAction,
  type DeterministicAutomationData,
} from "./deterministic-automation.js";
import { McpSessionRegistry, type McpSessionRegistryEvent } from "./mcp-session-registry.js";
import { createWorkspaceAppResourceUri } from "./workspace-app-resource.js";
import {
  ToolActivityLogManager,
  type ToolActivityInput,
} from "./activity-log.js";
import { McpRequestMetricsManager } from "./request-metrics.js";
import {
  CheckSessionManager,
  type CheckSessionSnapshot,
  type CheckResult,
} from "./check-sessions.js";
import {
  MAX_PACKAGE_CHECKS,
  preparePackageChecks,
  type PreparedPackageCheck,
} from "./package-checks.js";
import {
  MAX_READ_MANY_FILES,
  MAX_READ_MANY_TOTAL_CHARACTERS,
  readManyFiles,
} from "./read-many.js";
import {
  toolCatalog,
  toolAvailable,
  toolNames,
  toolSummary,
  type ToolConcurrencyClass,
  type ToolName,
} from "./tool-catalog.js";
import { ToolConcurrencyScheduler } from "./tool-concurrency.js";
import {
  CodeIntelligenceManager,
  type CodeIntelligenceProject,
  type DiagnosticsResult,
  type LocationsResult,
  type RenamePreviewResult,
} from "./code-intelligence.js";
import {
  WorkspacePolicyError,
  WorkspacePolicyManager,
  assertPolicyCommandAllowed,
  assertPolicyGitAddPaths,
  assertPolicyMutationAllowed,
  assertPolicyPackageScriptsAllowed,
  assertPolicyReadManyAllowed,
  assertPolicyWritablePaths,
  commandSafetyWithPolicyApproval,
  policyRequiresApproval,
  workspacePolicySummary,
  type WorkspacePolicySnapshot,
} from "./workspace-policy.js";

type Transport = StreamableHTTPServerTransport;
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface WorkspaceAppBuild {
  entry: WorkspaceAppManifestEntry;
  resourceUri: string;
}

let cachedWorkspaceAppBuild: WorkspaceAppBuild | undefined;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "open_workspace"
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "open_workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: getWorkspaceAppBuild().resourceUri,
        visibility: ["model"],
      },
    },
  };
}

interface ToolLogFields extends ToolActivityInput {
  command?: string;
  commandLength?: number;
}

interface ToolInvocationContext {
  activityId: string;
  queuedMs: number;
}

const toolInvocationContext = new AsyncLocalStorage<ToolInvocationContext>();

export function buildServerInstructions(
  config: Pick<ServerConfig, "toolMode" | "toolPacks" | "widgets" | "skillsEnabled"> & {
    concurrency?: ToolConcurrencyConfig;
  },
): string {
  const has = (name: ToolName): boolean => toolAvailable(
    name,
    config.toolMode,
    config.widgets,
    config.toolPacks,
  );
  const sections = [
    `Use LocalSpace as a local coding workspace. Call ${toolLabel(toolNames.openWorkspace)} once per project folder or worktree and reuse its workspaceId until the client changes folder, worktree mode, or the ID is rejected.`,
    `Follow project instructions returned by ${toolLabel(toolNames.openWorkspace)}. Before working under a path listed in availableAgentsFiles, use ${toolLabel(toolNames.read)} to read that instruction file.`,
  ];

  if (config.skillsEnabled) {
    sections.push(`When ${toolLabel(toolNames.openWorkspace)} advertises a matching Skill, use ${toolLabel(toolNames.read)} to read its SKILL.md before following that workflow.`);
  }

  const orientation = availableNames(config, [
    toolNames.doctor,
    toolNames.workspaceInfo,
    toolNames.sessionSummary,
    toolNames.entrypoints,
  ]);
  sections.push(`Use ${formatToolList(orientation)} for environment, workspace, activity, and entrypoint orientation.`);

  const navigation = availableNames(config, [
    toolNames.codeMap,
    toolNames.projectMap,
    toolNames.symbols,
    toolNames.imports,
    toolNames.references,
    toolNames.read,
    toolNames.readMany,
    toolNames.grep,
    toolNames.glob,
    toolNames.ls,
  ]);
  sections.push(`Use ${formatToolList(navigation)} for project inspection before editing.`);

  sections.push(...concurrencyInstructionSections(config));

  const codeIntelligence = availableNames(config, [
    toolNames.diagnostics,
    toolNames.definition,
    toolNames.implementations,
    toolNames.renamePreview,
  ]);
  if (codeIntelligence.length > 0) {
    sections.push(`Use ${formatToolList(codeIntelligence)} for optional TypeScript and JavaScript language-service analysis; ${toolLabel(toolNames.renamePreview)} never modifies files.`);
  }

  if (has(toolNames.applyPatch)) {
    sections.push(`Use ${toolLabel(toolNames.applyPatch)} for all file modifications.`);
  } else {
    sections.push(`Prefer ${toolLabel(toolNames.edit)} for targeted changes and ${toolLabel(toolNames.write)} only for new files or complete rewrites.`);
  }

  if (has(toolNames.execCommand)) {
    sections.push(`Use ${toolLabel(toolNames.runChecks)} for multiple declared package scripts, ${toolLabel(toolNames.execCommand)} for one command or non-package checks, and ${toolLabel(toolNames.writeStdin)} to poll or interact with running process or check-group sessions.`);
  } else if (has(toolNames.shell)) {
    sections.push(`Use ${toolLabel(toolNames.shell)} for tests, builds, Git inspection, package scripts, and read-only shell inspection. Do not use shell redirection or generated scripts to modify project files.`);
    if (config.toolMode === "minimal") {
      sections.push(`Dedicated search tools are not exposed in minimal mode; use ${toolLabel(toolNames.shell)} with bounded command-line search and directory-listing utilities.`);
    }
  }

  const workflow = availableNames(config, [
    toolNames.nextSteps,
    toolNames.validatePlan,
    toolNames.validationSummary,
    toolNames.reviewChecklist,
    toolNames.taskSummary,
    toolNames.finalReport,
    toolNames.handoffSummary,
  ]);
  if (workflow.length > 0) sections.push(`Use ${formatToolList(workflow)} for optional workflow planning and reporting.`);

  const gitReview = availableNames(config, [
    toolNames.changes,
    toolNames.gitStatus,
    toolNames.gitDiff,
    toolNames.gitLog,
  ]);
  if (gitReview.length > 0) sections.push(`Use ${formatToolList(gitReview)} to review repository state and changes.`);
  if (has(toolNames.gitAdd)) sections.push(`Use ${toolLabel(toolNames.gitAdd)} only for explicit workspace-relative paths.`);
  if (has(toolNames.gitCommit)) sections.push(`Use ${toolLabel(toolNames.gitCommit)} only after the user explicitly asks to commit.`);

  if (has(toolNames.showChanges)) {
    sections.push(`After the final file modification in a turn, call ${toolLabel(toolNames.showChanges)} exactly once before the final response so the user can inspect the aggregate diff.`);
  }

  return sections.join(" ");
}

function concurrencyInstructionSections(
  config: Pick<ServerConfig, "toolMode" | "toolPacks" | "widgets"> & {
    concurrency?: ToolConcurrencyConfig;
  },
): string[] {
  const concurrency = config.concurrency ?? DEFAULT_TOOL_CONCURRENCY;
  const sections = [
    `When the client supports parallel tool calls, issue independent calls concurrently. LocalSpace currently permits up to ${concurrency.maxConcurrentToolCalls} tool calls globally; excess calls queue for at most ${concurrency.queueTimeoutMs} ms.`,
  ];

  const sharedReads = availableConcurrencyNames(config, ["shared-read"])
    .filter((name) => name !== toolNames.openWorkspace);
  if (sharedReads.length > 0) {
    sections.push(`Independent shared-read tools may run in parallel: ${formatToolList(sharedReads)}.`);
  }

  const heavyReads = availableConcurrencyNames(config, ["heavy-read"]);
  if (heavyReads.length > 0) {
    sections.push(`Heavy read tools may run concurrently but are capped at ${concurrency.maxConcurrentScans} scans: ${formatToolList(heavyReads)}.`);
  }

  const workspaceWrites = availableConcurrencyNames(config, ["workspace-write"]);
  const gitWrites = availableConcurrencyNames(config, ["git-write"]);
  const serializedWrites = [...workspaceWrites, ...gitWrites];
  if (serializedWrites.length > 0) {
    sections.push(`Do not intentionally parallelize workspace or Git mutations; LocalSpace serializes ${formatToolList(serializedWrites)} and read calls may wait while they run.`);
  }

  const processStarts = availableConcurrencyNames(config, ["process-start"]);
  if (processStarts.length > 0) {
    sections.push(`Process-start tools are limited to ${concurrency.maxConcurrentProcesses} globally and ${concurrency.maxWorkspaceProcesses} per workspace: ${formatToolList(processStarts)}. Run them concurrently only when their side effects are independent, including generated files, databases, caches, and ports.`);
  }

  if (toolAvailable(toolNames.readMany, config.toolMode, config.widgets, config.toolPacks)) {
    sections.push(`Prefer ${toolLabel(toolNames.readMany)} for multiple known files instead of separate read calls.`);
  }
  if (toolAvailable(toolNames.runChecks, config.toolMode, config.widgets, config.toolPacks)) {
    sections.push(`Prefer ${toolLabel(toolNames.runChecks)} for independent declared package scripts instead of manually coordinating multiple commands.`);
  }

  const processSessions = availableConcurrencyNames(config, ["process-session"]);
  if (processSessions.length > 0) {
    sections.push(`Calls targeting the same process session must be sequential; different sessions may be polled concurrently with ${formatToolList(processSessions)}.`);
  }

  if (toolAvailable(toolNames.openWorkspace, config.toolMode, config.widgets, config.toolPacks)) {
    sections.push(`Do not create multiple managed worktrees concurrently with ${toolLabel(toolNames.openWorkspace)} mode=worktree; that operation is globally exclusive and should not overlap Git writes.`);
  }

  return sections;
}

function availableConcurrencyNames(
  config: Pick<ServerConfig, "toolMode" | "toolPacks" | "widgets">,
  classes: readonly ToolConcurrencyClass[],
): ToolName[] {
  return toolCatalog
    .filter((tool) => classes.includes(tool.concurrencyClass))
    .map((tool) => tool.name)
    .filter((name) => toolAvailable(name, config.toolMode, config.widgets, config.toolPacks));
}

function serverInstructions(config: ServerConfig): string {
  return buildServerInstructions(config);
}

function availableNames(
  config: Pick<ServerConfig, "toolMode" | "toolPacks" | "widgets">,
  candidates: readonly ToolName[],
): ToolName[] {
  return candidates.filter((name) => toolAvailable(
    name,
    config.toolMode,
    config.widgets,
    config.toolPacks,
  ));
}

function formatToolList(names: readonly ToolName[]): string {
  return names.map(toolLabel).join(", ");
}

function toolLabel(name: ToolName): string {
  return `\`${name}\``;
}
function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

function structuredTextOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return resultOutputSchema({
    text: z.string().describe("Same text as result for structured consumers."),
    ...extra,
  });
}

const scanSummaryOutputSchema = z.object({
  filesScanned: z.number(),
  truncatedFiles: z.boolean(),
  truncatedResults: z.boolean(),
});

const symbolEntryOutputSchema = z.object({
  file: z.string(),
  line: z.number(),
  kind: z.enum(["class", "function", "interface", "type", "enum", "variable", "method"]),
  name: z.string(),
  exported: z.boolean(),
});

const importExportEntryOutputSchema = z.object({
  file: z.string(),
  line: z.number(),
  kind: z.enum(["import", "export", "dynamic-import"]),
  module: z.string().optional(),
  names: z.array(z.string()),
});

const referenceEntryOutputSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
  name: z.string(),
  kind: z.enum(["reference", "definition"]),
  context: z.string(),
});

const entrypointCandidateOutputSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

const entrypointPackageInfoOutputSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  main: z.string().optional(),
  module: z.string().optional(),
  browser: z.string().optional(),
  types: z.string().optional(),
  bin: z.array(z.object({ name: z.string(), path: z.string() })),
  exports: z.array(z.string()),
});

const entrypointsStructuredOutputSchema = structuredTextOutputSchema({
  packageInfo: entrypointPackageInfoOutputSchema.optional(),
  scripts: z.array(z.object({ name: z.string(), command: z.string() })),
  suggestedVerification: z.array(z.string()),
  sourceEntrypoints: z.array(entrypointCandidateOutputSchema),
  configFiles: z.array(z.string()),
});

const symbolsStructuredOutputSchema = structuredTextOutputSchema({
  summary: scanSummaryOutputSchema,
  symbols: z.array(symbolEntryOutputSchema),
});

const importsStructuredOutputSchema = structuredTextOutputSchema({
  summary: scanSummaryOutputSchema,
  entries: z.array(importExportEntryOutputSchema),
});

const referencesStructuredOutputSchema = structuredTextOutputSchema({
  summary: scanSummaryOutputSchema.extend({ query: z.string() }),
  references: z.array(referenceEntryOutputSchema),
});

const codeMapStructuredOutputSchema = structuredTextOutputSchema({
  scope: z.string(),
  options: z.object({
    depth: z.number(),
    maxEntries: z.number(),
    maxSymbols: z.number(),
    maxImports: z.number(),
  }),
  entrypoints: z.object(entrypointsStructuredOutputSchema),
  projectMap: z.string(),
  symbols: z.object(symbolsStructuredOutputSchema),
  imports: z.object(importsStructuredOutputSchema),
});

const commandCheckOutputSchema = z.object({
  name: z.string(),
  status: z.enum(["ok", "warn", "error"]),
  detail: z.string(),
});

const workspaceDataOutputSchema = z.object({
  id: z.string(),
  root: z.string(),
  mode: z.string(),
  exists: z.boolean().optional(),
  sourceRoot: z.string().optional(),
  worktree: z.unknown().optional(),
});

const gitWorkspaceOutputSchema = z.object({
  isRepository: z.boolean(),
  branch: z.string(),
  head: z.string(),
  clean: z.boolean(),
  statusLines: z.array(z.string()),
  recentCommits: z.array(z.string()),
  error: z.string().optional(),
});

const packageDataOutputSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  scripts: z.record(z.string(), z.string()),
  engines: z.record(z.string(), z.string()),
  packageManager: z.string().optional(),
});

const doctorStructuredOutputSchema = structuredTextOutputSchema({
  configuration: z.object({
    toolMode: z.string(),
    toolPacks: z.array(z.string()),
    widgets: z.string(),
    mcpTransportMode: z.string(),
    host: z.string(),
    port: z.number(),
    publicBaseUrl: z.string(),
    allowedRoots: z.array(z.string()),
    stateDir: z.string(),
    worktreeRoot: z.string(),
    agentDir: z.string(),
    skillsEnabled: z.boolean(),
    configuredShell: z.string().optional(),
    mcpSessions: z.object({
      idleTtlMs: z.number(),
      cleanupIntervalMs: z.number(),
      maxSessions: z.number(),
    }),
    concurrency: z.object({
      maxConcurrentToolCalls: z.number(),
      maxConcurrentScans: z.number(),
      maxConcurrentProcesses: z.number(),
      maxWorkspaceProcesses: z.number(),
      queueTimeoutMs: z.number(),
    }),
  }),
  runtime: z.object({
    platform: z.string(),
    arch: z.string(),
    node: z.string(),
    cwd: z.string(),
  }),
  workspace: workspaceDataOutputSchema.optional(),
  checks: z.array(commandCheckOutputSchema),
  overall: z.enum(["ok", "warning", "error"]),
});

const codeIntelligenceProjectOutputSchema = z.object({
  kind: z.enum(["configured", "inferred"]),
  configPath: z.string().optional(),
  rootFileCount: z.number().int().nonnegative(),
  projectReferences: z.array(z.string()),
});

const codeIntelligencePositionOutputSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});

const diagnosticsStructuredOutputSchema = structuredTextOutputSchema({
  supported: z.boolean(),
  reason: z.string().optional(),
  project: codeIntelligenceProjectOutputSchema.optional(),
  summary: z.object({
    files: z.number().int().nonnegative(),
    diagnostics: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    suggestions: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  diagnostics: z.array(codeIntelligencePositionOutputSchema.extend({
    category: z.enum(["warning", "error", "suggestion", "message"]),
    code: z.number().int(),
    message: z.string(),
    source: z.string().optional(),
  })),
  projectDiagnostics: z.array(z.object({
    category: z.enum(["warning", "error", "suggestion", "message"]),
    code: z.number().int(),
    message: z.string(),
    source: z.string().optional(),
  })),
});

const locationsStructuredOutputSchema = structuredTextOutputSchema({
  supported: z.boolean(),
  reason: z.string().optional(),
  project: codeIntelligenceProjectOutputSchema.optional(),
  locations: z.array(codeIntelligencePositionOutputSchema.extend({
    kind: z.string(),
    name: z.string(),
    containerName: z.string().optional(),
  })),
  omittedExternal: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const renamePreviewStructuredOutputSchema = structuredTextOutputSchema({
  supported: z.boolean(),
  canRename: z.boolean(),
  reason: z.string().optional(),
  displayName: z.string().optional(),
  fullDisplayName: z.string().optional(),
  kind: z.string().optional(),
  project: codeIntelligenceProjectOutputSchema.optional(),
  edits: z.array(codeIntelligencePositionOutputSchema.extend({
    oldText: z.string(),
    newText: z.string(),
  })),
  files: z.number().int().nonnegative(),
  omittedExternal: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const workspaceInfoStructuredOutputSchema = structuredTextOutputSchema({
  workspace: workspaceDataOutputSchema,
  git: gitWorkspaceOutputSchema,
  package: packageDataOutputSchema.optional(),
});

const readManyFileOutputSchema = z.object({
  path: z.string(),
  success: z.boolean(),
  text: z.string().optional(),
  error: z.string().optional(),
  truncated: z.boolean(),
  lineCount: z.number(),
  characters: z.number(),
  offset: z.number(),
  limited: z.boolean(),
});

const readManyOutputSchema = resultOutputSchema({
  results: z.array(readManyFileOutputSchema),
  summary: z.object({
    requested: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    truncated: z.number(),
    characters: z.number(),
    maxTotalCharacters: z.number(),
    concurrency: z.number(),
  }),
});

const sessionSummaryOutputSchema = structuredTextOutputSchema({
  totalEvents: z.number(),
  successfulEvents: z.number(),
  failedEvents: z.number(),
  runningEvents: z.number(),
  truncatedEvents: z.number(),
  processPolls: z.number(),
  averageDurationMs: z.number(),
  maxDurationMs: z.number(),
  averageQueuedMs: z.number(),
  maxQueuedMs: z.number(),
  blockedEvents: z.number(),
  approvedEvents: z.number(),
  durableAuditEvents: z.number(),
  tools: z.record(z.string(), z.number()),
  categories: z.record(z.string(), z.number()),
  concurrencyClasses: z.record(z.string(), z.number()),
  toolStats: z.record(
    z.string(),
    z.object({
      count: z.number(),
      successful: z.number(),
      failed: z.number(),
      running: z.number(),
      truncated: z.number(),
      totalDurationMs: z.number(),
      averageDurationMs: z.number(),
      maxDurationMs: z.number(),
      totalQueuedMs: z.number(),
      maxQueuedMs: z.number(),
      totalOutputBytes: z.number(),
      averageOutputBytes: z.number(),
      maxOutputBytes: z.number(),
      totalStructuredOutputBytes: z.number(),
      averageStructuredOutputBytes: z.number(),
      maxStructuredOutputBytes: z.number(),
    }),
  ),
  paths: z.array(z.string()),
  commands: z.array(z.string()),
  risks: z.record(z.string(), z.number()),
  recentEvents: z.array(z.unknown()),
  recentAuditEvents: z.array(z.unknown()),
  requestMetrics: z.object({
    totalRequests: z.number(),
    successfulRequests: z.number(),
    failedRequests: z.number(),
    statelessRequests: z.number(),
    statefulRequests: z.number(),
    averageTotalMs: z.number(),
    maxTotalMs: z.number(),
    averageRequestBytes: z.number(),
    averageResponseBytes: z.number(),
    phases: z.object({
      auth: z.object({ averageMs: z.number(), maxMs: z.number() }),
      serverCreate: z.object({ averageMs: z.number(), maxMs: z.number() }),
      transportConnect: z.object({ averageMs: z.number(), maxMs: z.number() }),
      transportHandle: z.object({ averageMs: z.number(), maxMs: z.number() }),
      cleanup: z.object({ averageMs: z.number(), maxMs: z.number() }),
    }),
    rpcMethods: z.record(z.string(), z.number()),
    tools: z.record(z.string(), z.number()),
    recentRequests: z.array(z.unknown()),
  }),
});

const workflowCommandOutputSchema = z.object({
  command: z.string(),
  reason: z.string(),
  required: z.boolean(),
});

const validatePlanOutputSchema = structuredTextOutputSchema({
  packageName: z.string().optional(),
  commands: z.array(workflowCommandOutputSchema),
  missingScripts: z.array(z.string()),
  notes: z.array(z.string()),
});

const workflowCheckOutputSchema = z.object({
  title: z.string(),
  status: z.enum(["ok", "warn", "action", "info"]),
  detail: z.string(),
});

const automationRecommendationOutputSchema = z.object({
  id: z.string(),
  severity: z.enum(["info", "warning", "required"]),
  title: z.string(),
  detail: z.string(),
  matchedPaths: z.array(z.string()),
  suggestedTool: z.string().optional(),
  suggestedCommand: z.string().optional(),
});

const deterministicAutomationOutputSchema = z.object({
  changedPaths: z.array(z.string()),
  sourcePaths: z.array(z.string()),
  packagePaths: z.array(z.string()),
  sensitivePaths: z.array(z.string()),
  validationFreshness: z.enum(["not-required", "current", "stale", "unknown"]),
  packageValidationFreshness: z.enum(["not-required", "current", "stale", "unknown"]),
  validationEvidence: z.array(z.enum(["typecheck", "test", "build", "lint", "smoke", "package"])),
  latestChangeAt: z.string().optional(),
  latestValidationAt: z.string().optional(),
  commitReviewRequired: z.boolean(),
  recommendations: z.array(automationRecommendationOutputSchema),
  text: z.string(),
});

const reviewChecklistOutputSchema = structuredTextOutputSchema({
  dirty: z.boolean(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  changedPaths: z.array(z.string()),
  automation: deterministicAutomationOutputSchema,
  checks: z.array(workflowCheckOutputSchema),
  recommendedActions: z.array(z.string()),
});

const nextStepOutputSchema = z.object({
  priority: z.enum(["high", "medium", "low"]),
  title: z.string(),
  detail: z.string(),
  suggestedTool: z.string().optional(),
});

const nextStepsOutputSchema = structuredTextOutputSchema({
  steps: z.array(nextStepOutputSchema),
});

const taskSummaryOutputSchema = structuredTextOutputSchema({
  changedPaths: z.array(z.string()),
  git: z.object({
    dirty: z.boolean(),
    staged: z.boolean(),
    unstaged: z.boolean(),
    untracked: z.boolean(),
  }),
  audit: z.object({
    totalEvents: z.number(),
    blockedEvents: z.number(),
    approvedEvents: z.number(),
    tools: z.record(z.string(), z.number()),
  }),
  validation: z.object({
    recommendedCommands: z.array(z.string()),
  }),
  automation: deterministicAutomationOutputSchema,
  recommendedFinalResponse: z.array(z.string()),
  warnings: z.array(z.string()),
});

const validationDetectedResultOutputSchema = z.object({
  kind: z.enum(["typecheck", "test", "build", "lint", "smoke", "other"]),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  passed: z.boolean().optional(),
});

const validationSummaryOutputSchema = structuredTextOutputSchema({
  commandPreviewEnabled: z.boolean(),
  recommendedCommands: z.array(z.string()),
  recentExecCommands: z.number(),
  recentFailures: z.number(),
  recentSuccesses: z.number(),
  detectedResults: z.array(validationDetectedResultOutputSchema),
  automation: deterministicAutomationOutputSchema,
  notes: z.array(z.string()),
});

const reportGitStateOutputSchema = z.object({
  isRepository: z.boolean(),
  branch: z.string().optional(),
  head: z.string().optional(),
  latestCommit: z.string().optional(),
  dirty: z.boolean(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
});

const reportValidationOutputSchema = z.object({
  recommendedCommands: z.array(z.string()),
  recentExecCommands: z.number(),
  recentFailures: z.number(),
  recentSuccesses: z.number(),
  detectedResults: z.array(validationDetectedResultOutputSchema),
  notes: z.array(z.string()),
});

const finalReportOutputSchema = structuredTextOutputSchema({
  taskTitle: z.string().optional(),
  summary: z.array(z.string()),
  changedFiles: z.array(z.string()),
  git: reportGitStateOutputSchema,
  validation: reportValidationOutputSchema,
  commit: z.object({
    latestCommit: z.string().optional(),
    suggestion: z.string(),
  }),
  warnings: z.array(z.string()),
  nextRecommendedStep: z.string(),
});

const handoffSummaryOutputSchema = structuredTextOutputSchema({
  project: z.object({
    root: z.string(),
    branch: z.string().optional(),
    latestCommit: z.string().optional(),
  }),
  currentPhase: z.string(),
  completedPhases: z.array(z.string()),
  changedFiles: z.array(z.string()),
  validation: reportValidationOutputSchema,
  remainingTasks: z.array(z.string()),
  knownWarnings: z.array(z.string()),
  nextRecommendedStep: z.string(),
  suggestedFirstPrompt: z.string(),
});

const changesGroupOutputSchema = z.object({
  title: z.string(),
  paths: z.array(z.string()),
});

const statusEntryOutputSchema = z.object({
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  path: z.string(),
});

const changesStructuredOutputSchema = structuredTextOutputSchema({
  isRepository: z.boolean(),
  clean: z.boolean(),
  mode: z.enum(["summary", "stat", "patch"]),
  staged: z.boolean(),
  branch: z.string().optional(),
  statusEntries: z.array(statusEntryOutputSchema),
  groups: z.array(changesGroupOutputSchema),
  stat: z.string().optional(),
  truncated: z.boolean(),
});

const gitStatusStructuredOutputSchema = structuredTextOutputSchema({
  isRepository: z.boolean(),
  branch: z.string(),
  clean: z.boolean(),
  statusLines: z.array(z.string()),
  truncated: z.boolean(),
});

const gitDiffStructuredOutputSchema = structuredTextOutputSchema({
  isRepository: z.boolean(),
  staged: z.boolean(),
  stat: z.boolean(),
  empty: z.boolean(),
  truncated: z.boolean(),
});

const gitAddStructuredOutputSchema = structuredTextOutputSchema({
  isRepository: z.boolean(),
  paths: z.array(z.string()),
  stagedCount: z.number(),
  truncated: z.boolean(),
});

const gitCommitStructuredOutputSchema = structuredTextOutputSchema({
  isRepository: z.boolean(),
  message: z.string(),
  committed: z.boolean(),
  truncated: z.boolean(),
  blocked: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  approvalToken: z.string().optional(),
  approvalTokenExpiresAt: z.string().optional(),
  approvalFailureReason: z.enum(["missing", "not_found", "expired", "mismatch"]).optional(),
  commandApproved: z.boolean().optional(),
  workspaceRevision: z.string().optional(),
  commandRisk: z.enum(["none", "notice", "warning", "danger"]).optional(),
  commandSafetyFindings: z.array(z.object({
    level: z.enum(["notice", "warning", "danger"]),
    category: z.string(),
    message: z.string(),
  })).optional(),
  automation: deterministicAutomationOutputSchema,
});

const gitLogStructuredOutputSchema = structuredTextOutputSchema({
  isRepository: z.boolean(),
  limit: z.number(),
  commits: z.array(z.string()),
  truncated: z.boolean(),
});

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

interface McpRpcRequestInfo {
  rpcMethod?: string;
  tool?: string;
  workspaceId?: string;
}

function mcpRpcRequestInfo(body: unknown): McpRpcRequestInfo {
  if (Array.isArray(body)) return { rpcMethod: "batch" };
  if (!body || typeof body !== "object") return {};

  const request = body as Record<string, unknown>;
  const rpcMethod = typeof request.method === "string" ? request.method : undefined;
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return { rpcMethod };

  const paramsRecord = params as Record<string, unknown>;
  const tool = rpcMethod === "tools/call" && typeof paramsRecord.name === "string"
    ? paramsRecord.name
    : undefined;
  const args = paramsRecord.arguments;
  const workspaceId = args && typeof args === "object" && !Array.isArray(args)
    && typeof (args as Record<string, unknown>).workspaceId === "string"
    ? String((args as Record<string, unknown>).workspaceId)
    : undefined;
  return { rpcMethod, tool, workspaceId };
}

function optionalByteLength(value: string | number | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function emitToolCallLog(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function recordToolCall(
  config: ServerConfig,
  activityLog: ToolActivityLogManager,
  fields: ToolLogFields,
): void {
  activityLog.record({
    ...fields,
    activityId: toolInvocationContext.getStore()?.activityId,
    queuedMs: roundMetric(
      (fields.queuedMs ?? 0) + (toolInvocationContext.getStore()?.queuedMs ?? 0),
    ),
  });
  emitToolCallLog(config, fields);
}

function installMeasuredToolRegistration(
  server: McpServer,
  activityLog: ToolActivityLogManager,
  concurrency: ToolConcurrencyScheduler,
): void {
  const mutableServer = server as unknown as {
    registerTool: (...args: unknown[]) => unknown;
  };
  const originalRegisterTool = mutableServer.registerTool.bind(server);

  mutableServer.registerTool = (
    name: unknown,
    config: unknown,
    callback: unknown,
  ): unknown => {
    if (typeof name !== "string" || typeof callback !== "function") {
      return originalRegisterTool(name, config, callback);
    }

    const measuredCallback = async (...args: unknown[]): Promise<unknown> => {
      const activityId = `activity_${randomUUID()}`;
      const startedAt = performance.now();
      const workspaceId = toolWorkspaceId(args[0]);
      let concurrencyPermit: Awaited<ReturnType<ToolConcurrencyScheduler["acquire"]>> | undefined;
      let queuedMs = 0;
      try {
        concurrencyPermit = await concurrency.acquire(name as ToolName, args[0], {
          signal: toolAbortSignal(args[1]),
        });
        queuedMs = concurrencyPermit.queuedMs;
      } catch (error) {
        activityLog.record({
          activityId,
          tool: name,
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          queuedMs: Math.round((performance.now() - startedAt) * 100) / 100,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      try {
        return await toolInvocationContext.run({ activityId, queuedMs }, async () => {
        try {
          const result = await (callback as (...callbackArgs: unknown[]) => unknown)(...args);
          const metrics = toolResultMetrics(result);
          const updated = activityLog.updateResult(activityId, metrics);
          if (!updated) {
            activityLog.record({
              activityId,
              tool: name,
              workspaceId,
              success: true,
              durationMs: Math.round(performance.now() - startedAt - queuedMs),
              queuedMs,
              ...metrics,
            });
          }
          return result;
        } catch (error) {
          const updated = activityLog.updateResult(activityId, {});
          if (!updated) {
            activityLog.record({
              activityId,
              tool: name,
              workspaceId,
              success: false,
              durationMs: Math.round(performance.now() - startedAt - queuedMs),
              queuedMs,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
      });
      } finally {
        concurrencyPermit.release();
      }
    };

    return originalRegisterTool(name, config, measuredCallback);
  };
}

function toolAbortSignal(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return undefined;
  const signal = (extra as Record<string, unknown>).signal;
  if (!signal || typeof signal !== "object") return undefined;
  const candidate = signal as Partial<AbortSignal>;
  return typeof candidate.aborted === "boolean"
    && typeof candidate.addEventListener === "function"
    && typeof candidate.removeEventListener === "function"
    ? signal as AbortSignal
    : undefined;
}

function toolWorkspaceId(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).workspaceId;
  return typeof value === "string" ? value : undefined;
}

function toolResultMetrics(result: unknown): {
  outputBytes?: number;
  structuredOutputBytes?: number;
  truncated?: boolean;
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  const record = result as Record<string, unknown>;
  return {
    outputBytes: serializedByteLength(record.content),
    structuredOutputBytes: serializedByteLength(record.structuredContent),
    truncated: containsTruncation(record.structuredContent),
  };
}

function serializedByteLength(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function containsTruncation(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsTruncation(entry, depth + 1));
  }
  if (typeof value !== "object") return false;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/truncated/i.test(key) && entry === true) return true;
    if (containsTruncation(entry, depth + 1)) return true;
  }
  return false;
}

function recordFailedToolResponse(
  config: ServerConfig,
  activityLog: ToolActivityLogManager,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  recordToolCall(config, activityLog, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function workspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  const rel = relative(workspaceRoot, absolutePath).split("\\").join("/");
  return rel || ".";
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): {
  source: string;
  manifest: WorkspaceAppManifest;
} {
  const source = readFileSync(uiManifestUrl(), "utf8");
  return {
    source,
    manifest: JSON.parse(source) as WorkspaceAppManifest,
  };
}

function getWorkspaceAppManifestEntry(
  manifest: WorkspaceAppManifest,
): WorkspaceAppManifestEntry {
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function getWorkspaceAppBuild(): WorkspaceAppBuild {
  if (cachedWorkspaceAppBuild) return cachedWorkspaceAppBuild;

  const { source, manifest } = readWorkspaceAppManifest();
  const entry = getWorkspaceAppManifestEntry(manifest);
  cachedWorkspaceAppBuild = {
    entry,
    resourceUri: createWorkspaceAppResourceUri(source),
  };
  return cachedWorkspaceAppBuild;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(
  config: ServerConfig,
  entry: WorkspaceAppManifestEntry,
): string {
  const baseUrl = assetBaseUrl(config);
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LocalSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(
  entry: WorkspaceAppManifestEntry,
): Promise<void> {
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

const commandSafetyFindingOutputSchema = z.object({
  level: z.enum(["notice", "warning", "danger"]),
  category: z.string(),
  message: z.string(),
});

const checkResultOutputSchema = z.object({
  name: z.string(),
  command: z.string(),
  validationAction: z.string().optional(),
  status: z.enum(["queued", "running", "passed", "failed", "blocked", "skipped", "cancelled"]),
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
  wallTimeMs: z.number().nonnegative().optional(),
  queuedMs: z.number().nonnegative(),
  output: z.string(),
  outputTruncated: z.boolean(),
  commandRisk: z.enum(["none", "notice", "warning", "danger"]),
  commandSafetyFindings: z.array(commandSafetyFindingOutputSchema),
});

const checkSummaryOutputSchema = z.object({
  requested: z.number(),
  queued: z.number(),
  running: z.number(),
  passed: z.number(),
  failed: z.number(),
  blocked: z.number(),
  skipped: z.number(),
  cancelled: z.number(),
});

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    queuedMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
    blocked: z.boolean().optional(),
    approvalRequired: z.boolean().optional(),
    approvalToken: z.string().optional(),
    approvalTokenExpiresAt: z.string().optional(),
    approvalFailureReason: z.enum(["missing", "not_found", "expired", "mismatch"]).optional(),
    commandApproved: z.boolean().optional(),
    commandRisk: z.enum(["none", "notice", "warning", "danger"]).optional(),
    commandSafetyFindings: z.array(commandSafetyFindingOutputSchema).optional(),
    checks: z.array(checkResultOutputSchema).optional(),
    checkSummary: checkSummaryOutputSchema.optional(),
    workspaceRevisionAtStart: z.string().optional(),
    workspaceRevisionAtEnd: z.string().optional(),
    workspaceChangedDuringRun: z.boolean().optional(),
    failFast: z.boolean().optional(),
    concurrency: z.number().optional(),
    approvalRequests: z
      .array(z.object({
        check: z.string(),
        approvalToken: z.string(),
        approvalTokenExpiresAt: z.string(),
        commandRisk: z.literal("danger"),
        commandSafetyFindings: z.array(commandSafetyFindingOutputSchema),
      }))
      .optional(),
  });
}

function blockedCommandResult(
  workspaceId: string,
  command: string,
  workingDirectory: string,
  safety: CommandSafetyAnalysis,
  approval: ReturnType<CommandApprovalManager["create"]>,
  approvalResult: ReturnType<CommandApprovalManager["consume"]>,
) {
  const warning = formatCommandSafetyWarning(safety);
  const result = [
    "Command blocked: high-risk command requires approval.",
    "",
    warning,
    "",
    `Approval token: ${approval.token}`,
    `Expires at: ${approval.expiresAt}`,
    "",
    "Run the exact same command with this approvalToken only after the user explicitly confirms.",
  ].filter(Boolean).join("\n");
  const content = [textBlock(result)];
  return {
    content,
    _meta: {
      tool: "exec_command",
      card: {
        workspaceId,
        summary: {
          command,
          workingDirectory,
          blocked: true,
          approvalRequired: true,
          approvalFailureReason: approvalResult.reason,
          commandRisk: safety.level,
          commandSafetyFindings: safety.findings.length,
          ...textSummary(content),
        },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      running: false,
      wallTimeMs: 0,
      queuedMs: 0,
      outputTruncated: false,
      blocked: true,
      approvalRequired: true,
      approvalToken: approval.token,
      approvalTokenExpiresAt: approval.expiresAt,
      approvalFailureReason: approvalResult.reason,
      commandApproved: false,
      commandRisk: safety.level,
      commandSafetyFindings: safety.findings,
    },
  };
}

function deterministicAutomationSafety(
  automation: DeterministicAutomationData,
): CommandSafetyAnalysis {
  const required = automation.recommendations.filter(
    (recommendation) => recommendation.severity === "required",
  );
  return {
    level: required.length > 0 ? "danger" : "none",
    findings: required.map((recommendation) => ({
      level: "danger" as const,
      category: "deterministic-automation",
      message: `${recommendation.title}: ${recommendation.detail}`,
    })),
  };
}

function gitCommitApprovalCommand(input: {
  message: string;
  workspaceRevision: string | undefined;
  stagedPaths: string[];
  automation: DeterministicAutomationData;
}): string {
  return `git_commit:${JSON.stringify({
    message: input.message.trim(),
    workspaceRevision: input.workspaceRevision,
    stagedPaths: [...input.stagedPaths].sort(),
    requiredRecommendations: input.automation.recommendations
      .filter((recommendation) => recommendation.severity === "required")
      .map((recommendation) => ({
        id: recommendation.id,
        matchedPaths: [...recommendation.matchedPaths].sort(),
      })),
    validationFreshness: input.automation.validationFreshness,
    packageValidationFreshness: input.automation.packageValidationFreshness,
  })}`;
}

function blockedGitCommitResult(input: {
  workspaceId: string;
  message: string;
  workspaceRevision: string | undefined;
  automation: DeterministicAutomationData;
  safety: CommandSafetyAnalysis;
  approval: ReturnType<CommandApprovalManager["create"]>;
  approvalResult: ReturnType<CommandApprovalManager["consume"]>;
}) {
  const required = input.automation.recommendations.filter(
    (recommendation) => recommendation.severity === "required",
  );
  const result = [
    "Git commit blocked: deterministic preflight requires explicit approval.",
    "",
    ...required.map((recommendation) => `- ${recommendation.title}: ${recommendation.detail}`),
    "",
    `Approval token: ${input.approval.token}`,
    `Expires at: ${input.approval.expiresAt}`,
    "",
    "Retry the exact same commit message against the unchanged staged workspace with this approvalToken only after the user explicitly confirms.",
  ].join("\n");
  const content = [textBlock(result)];
  return {
    content,
    _meta: {
      tool: toolNames.gitCommit,
      card: {
        workspaceId: input.workspaceId,
        summary: {
          blocked: true,
          approvalRequired: true,
          recommendations: required.length,
          ...textSummary(content),
        },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      text: result,
      isRepository: true,
      message: input.message.trim(),
      committed: false,
      truncated: false,
      blocked: true,
      approvalRequired: true,
      approvalToken: input.approval.token,
      approvalTokenExpiresAt: input.approval.expiresAt,
      approvalFailureReason: input.approvalResult.reason,
      commandApproved: false,
      workspaceRevision: input.workspaceRevision,
      commandRisk: input.safety.level,
      commandSafetyFindings: input.safety.findings,
      automation: input.automation,
    },
  };
}

function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
  safety?: CommandSafetyAnalysis,
) {
  const warning = safety ? formatCommandSafetyWarning(safety) : undefined;
  const baseResult = processResult(snapshot);
  const result = warning ? `${warning}\n\n${baseResult}` : baseResult;
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: {
          ...summary,
          commandRisk: safety?.level,
          commandSafetyFindings: safety?.findings.length,
          ...outputSummary,
        },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      queuedMs: snapshot.queuedMs,
      outputTruncated: snapshot.outputTruncated,
      commandApproved: typeof summary.commandApproved === "boolean" ? summary.commandApproved : undefined,
      commandRisk: safety?.level,
      commandSafetyFindings: safety?.findings,
    },
  };
}

function checkSessionToolResponse(
  tool: "run_checks" | "write_stdin",
  workspaceId: string,
  snapshot: CheckSessionSnapshot,
  summary: Record<string, unknown> = {},
) {
  const fallback = snapshot.running
    ? `Check group running with session ID ${snapshot.sessionId}.`
    : `Check group completed: ${snapshot.summary.passed} passed, ${snapshot.summary.failed} failed.`;
  const result = snapshot.result || fallback;
  const content = [textBlock(result)];
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: {
          ...summary,
          ...snapshot.summary,
          running: snapshot.running,
          queuedMs: snapshot.queuedMs,
          ...textSummary(content),
        },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      wallTimeMs: snapshot.wallTimeMs,
      queuedMs: snapshot.queuedMs,
      outputTruncated: snapshot.outputTruncated,
      checks: snapshot.checks,
      checkSummary: snapshot.summary,
      workspaceRevisionAtStart: snapshot.workspaceRevisionAtStart,
      workspaceRevisionAtEnd: snapshot.workspaceRevisionAtEnd,
      workspaceChangedDuringRun: snapshot.workspaceChangedDuringRun,
      failFast: snapshot.failFast,
      concurrency: snapshot.concurrency,
      commandApproved: typeof summary.commandApproved === "boolean"
        ? summary.commandApproved
        : undefined,
    },
  };
}

function blockedChecksResult(
  workspaceId: string,
  checks: PreparedPackageCheck[],
  approvalRequests: Array<{
    check: string;
    approvalToken: string;
    approvalTokenExpiresAt: string;
    commandRisk: "danger";
    commandSafetyFindings: CommandSafetyAnalysis["findings"];
  }>,
) {
  const blockedChecks: CheckResult[] = checks.map((check) => ({
    name: check.name,
    command: check.command,
    status: check.safety.level === "danger" ? "blocked" : "queued",
    queuedMs: 0,
    output: check.safety.level === "danger" ? (formatCommandSafetyWarning(check.safety) ?? "") : "",
    outputTruncated: false,
    commandRisk: check.safety.level,
    commandSafetyFindings: check.safety.findings,
  }));
  const result = [
    "Check group blocked: one or more package scripts require approval.",
    "",
    ...approvalRequests.flatMap((request) => [
      `Check: ${request.check}`,
      `Approval token: ${request.approvalToken}`,
      `Expires at: ${request.approvalTokenExpiresAt}`,
      "",
    ]),
    "Retry the same checks with the matching approval tokens only after explicit user confirmation.",
  ].join("\n");
  const content = [textBlock(result)];
  return {
    content,
    _meta: {
      tool: toolNames.runChecks,
      card: {
        workspaceId,
        summary: {
          requested: checks.length,
          blocked: approvalRequests.length,
          approvalRequired: true,
          ...textSummary(content),
        },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      running: false,
      wallTimeMs: 0,
      queuedMs: 0,
      outputTruncated: false,
      blocked: true,
      approvalRequired: true,
      commandApproved: false,
      commandRisk: "danger" as const,
      checks: blockedChecks,
      checkSummary: {
        requested: checks.length,
        queued: blockedChecks.filter((check) => check.status === "queued").length,
        running: 0,
        passed: 0,
        failed: 0,
        blocked: approvalRequests.length,
        skipped: 0,
        cancelled: 0,
      },
      approvalRequests,
    },
  };
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  checkSessions: CheckSessionManager,
  auditLog: AuditLogManager,
  activityLog: ToolActivityLogManager,
  approvals: CommandApprovalManager,
  workspacePolicies: WorkspacePolicyManager,
): void {
  const logToolCall = (currentConfig: ServerConfig, fields: ToolLogFields): void => {
    recordToolCall(currentConfig, activityLog, fields);
  };
  const logFailedToolResponse = (
    currentConfig: ServerConfig,
    fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
    content: ToolContent[],
    startedAt: number,
  ): void => {
    recordFailedToolResponse(currentConfig, activityLog, fields, content, startedAt);
  };

  registerAppTool(
    server,
    toolNames.execCommand,
    {
      title: "Execute command",
      description: toolSummary(toolNames.execCommand),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
        approvalToken: z
          .string()
          .optional()
          .describe("One-time approval token returned by a previously blocked high-risk command."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens, approvalToken }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      assertDedicatedGitCommitTool(cmd, {
        config,
        auditLog,
        activityLog,
        tool: toolNames.execCommand,
        workspaceId,
        startedAt,
        workingDirectory: workingDirectory ?? ".",
      });
      const policy = await policyForTool(
        config,
        workspacePolicies,
        workspace,
        auditLog,
        activityLog,
        {
          tool: toolNames.execCommand,
          workspaceId,
          startedAt,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          enforce: (snapshot) => assertPolicyCommandAllowed(snapshot, cmd, tty),
        },
      );
      const safety = commandSafetyWithPolicyApproval(
        analyzeCommandSafety(cmd),
        policy,
        "exec_command",
      );
      const validationAction = validationEvidenceAction(cmd);
      const approvalContext = { workspaceId, cwd, command: cmd, safety };
      const approval = safety.level === "danger"
        ? approvals.consume(approvalToken, approvalContext)
        : { approved: true };

      if (safety.level === "danger" && !approval.approved) {
        const request = approvals.create(approvalContext);
        auditLog.record({
          tool: "exec_command",
          workspaceId,
          action: validationAction,
          success: false,
          blocked: true,
          risk: safety.level,
          commandPreview: config.logging.shellCommands ? commandPreview(cmd) : undefined,
          durationMs: Math.round(performance.now() - startedAt),
        });
        logToolCall(config, {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return blockedCommandResult(workspaceId, cmd, workingDirectory ?? ".", safety, request, approval);
      }

      const snapshot = await processSessions.start({
        workspaceId,
        command: cmd,
        cwd,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });
      const validationRevision = validationAction && !snapshot.running && snapshot.exitCode === 0
        ? await workspaceContentRevision(workspace.root)
        : undefined;

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        outputBytes: snapshot.output?.length ?? 0,
        truncated: snapshot.outputTruncated,
        queuedMs: snapshot.queuedMs,
      });

      auditLog.record({
        tool: "exec_command",
        workspaceId,
        action: validationAction,
        workspaceRevision: validationRevision,
        success: snapshot.exitCode === undefined ? true : snapshot.exitCode === 0,
        approved: safety.level === "danger" ? approval.approved : undefined,
        risk: safety.level,
        commandPreview: config.logging.shellCommands ? commandPreview(cmd) : undefined,
        exitCode: snapshot.exitCode,
        running: snapshot.running,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        commandApproved: safety.level === "danger" ? approval.approved : undefined,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      }, safety);
    },
  );

  registerAppTool(
    server,
    toolNames.runChecks,
    {
      title: "Run package checks",
      description: toolSummary(toolNames.runChecks),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        checks: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_PACKAGE_CHECKS)
          .describe(`package.json script names to run. Maximum ${MAX_PACKAGE_CHECKS}.`),
        concurrency: z.number().int().min(1).max(4).optional().describe("Maximum checks to run concurrently. Defaults to 2, max 4."),
        failFast: z.boolean().optional().describe("Stop starting queued checks after the first failure. Running checks are allowed to finish."),
        yieldTimeMs: z.number().int().min(0).max(30_000).optional().describe("Milliseconds to wait before returning a running group session. Defaults to 10000."),
        maxOutputTokens: z.number().int().positive().max(100_000).optional().describe("Approximate combined output token budget. Defaults to 20000."),
        approvals: z
          .array(z.object({
            check: z.string().min(1),
            approvalToken: z.string().min(1),
          }))
          .max(MAX_PACKAGE_CHECKS)
          .optional()
          .describe("Approval tokens previously returned for matching dangerous package scripts."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, checks, concurrency, failFast, yieldTimeMs, maxOutputTokens, approvals: suppliedApprovals }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const preparedBase = await preparePackageChecks(workspace.root, checks);
      for (const check of preparedBase.checks) {
        for (const script of check.scripts) {
          assertDedicatedGitCommitTool(script.script, {
            config,
            auditLog,
            activityLog,
            tool: toolNames.runChecks,
            workspaceId,
            startedAt,
          });
        }
      }
      const policy = await policyForTool(
        config,
        workspacePolicies,
        workspace,
        auditLog,
        activityLog,
        {
          tool: toolNames.runChecks,
          workspaceId,
          startedAt,
          enforce: (snapshot) => assertPolicyPackageScriptsAllowed(snapshot, preparedBase.checks),
        },
      );
      const prepared = {
        ...preparedBase,
        checks: preparedBase.checks.map((check) => ({
          ...check,
          validationAction: validationEvidenceAction(
            check.scripts.map((entry) => `${entry.name}\n${entry.script}`).join("\n"),
          ),
          safety: commandSafetyWithPolicyApproval(check.safety, policy, "run_checks"),
        })),
      };
      const dangerous = prepared.checks.filter((check) => check.safety.level === "danger");
      const supplied = new Map(
        (suppliedApprovals ?? []).map((approval) => [approval.check, approval.approvalToken]),
      );
      const approvalEntries = dangerous.map((check) => ({
        token: supplied.get(check.name),
        context: {
          workspaceId,
          cwd: workspace.root,
          command: check.approvalCommand,
          safety: check.safety,
        },
      }));
      const approval = dangerous.length > 0
        ? approvals.consumeBatch(approvalEntries)
        : { approved: true, results: [] };

      if (!approval.approved) {
        const requests = dangerous.map((check) => {
          const request = approvals.create({
            workspaceId,
            cwd: workspace.root,
            command: check.approvalCommand,
            safety: check.safety,
          });
          return {
            check: check.name,
            approvalToken: request.token,
            approvalTokenExpiresAt: request.expiresAt,
            commandRisk: "danger" as const,
            commandSafetyFindings: check.safety.findings,
          };
        });
        auditLog.record({
          tool: toolNames.runChecks,
          workspaceId,
          success: false,
          blocked: true,
          risk: "danger",
          durationMs: Math.round(performance.now() - startedAt),
        });
        logToolCall(config, {
          tool: toolNames.runChecks,
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return blockedChecksResult(workspaceId, prepared.checks, requests);
      }

      const snapshot = await checkSessions.start({
        workspaceId,
        root: workspace.root,
        checks: prepared.checks,
        concurrency,
        failFast,
        yieldTimeMs,
        maxOutputTokens,
      });
      const validationRevision = !snapshot.running
        ? await workspaceContentRevision(workspace.root)
        : undefined;
      const hasDanger = dangerous.length > 0;
      const checkResults = new Map(snapshot.checks.map((check) => [check.name, check]));
      for (const check of prepared.checks) {
        const result = checkResults.get(check.name);
        auditLog.record({
          tool: toolNames.runChecks,
          workspaceId,
          action: check.validationAction,
          workspaceRevision: result?.status === "passed" ? validationRevision : undefined,
          success: snapshot.running || result?.status === "passed",
          approved: check.safety.level === "danger" ? true : undefined,
          risk: check.safety.level,
          commandPreview: config.logging.shellCommands
            ? commandPreview(`${check.command} => ${check.script}`)
            : undefined,
          exitCode: result?.exitCode,
          running: result?.status === "running" || result?.status === "queued",
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      logToolCall(config, {
        tool: toolNames.runChecks,
        workspaceId,
        success: snapshot.running || snapshot.summary.failed === 0,
        durationMs: Math.round(performance.now() - startedAt),
        running: snapshot.running,
        outputBytes: snapshot.result.length,
        truncated: snapshot.outputTruncated,
        queuedMs: snapshot.queuedMs,
      });
      return checkSessionToolResponse(toolNames.runChecks, workspaceId, snapshot, {
        packageName: prepared.packageName,
        packageManager: prepared.packageManager,
        requestedChecks: checks,
        commandApproved: hasDanger ? true : undefined,
      });
    },
  );

  registerAppTool(
    server,
    toolNames.writeStdin,
    {
      title: "Write to process",
      description: toolSummary(toolNames.writeStdin),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Session identifier returned by exec_command or run_checks."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll. Check groups accept Ctrl-C only."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      if (checkSessions.has(workspaceId, sessionId)) {
        const snapshot = await checkSessions.write({
          workspaceId,
          sessionId,
          chars,
          columns,
          rows,
          yieldTimeMs,
          maxOutputTokens,
        });
        const validationRevision = !snapshot.running
          ? await workspaceContentRevision(workspace.root)
          : undefined;
        for (const check of snapshot.checks) {
          auditLog.record({
            tool: toolNames.runChecks,
            workspaceId,
            action: check.validationAction,
            workspaceRevision: check.status === "passed" ? validationRevision : undefined,
            success: snapshot.running || check.status === "passed",
            risk: check.commandRisk,
            commandPreview: config.logging.shellCommands
              ? commandPreview(check.command)
              : undefined,
            exitCode: check.exitCode,
            running: check.status === "running" || check.status === "queued",
            durationMs: Math.round(performance.now() - startedAt),
          });
        }
        logToolCall(config, {
          tool: toolNames.writeStdin,
          workspaceId,
          success: snapshot.running || snapshot.summary.failed === 0,
          durationMs: Math.round(performance.now() - startedAt),
          running: snapshot.running,
          outputBytes: snapshot.result.length,
          truncated: snapshot.outputTruncated,
          queuedMs: snapshot.queuedMs,
        });
        return checkSessionToolResponse(toolNames.writeStdin, workspaceId, snapshot, {
          sessionId,
          checkGroup: true,
        });
      }
      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      if (!snapshot.running) {
        const validationAction = validationEvidenceAction(snapshot.command ?? "");
        auditLog.record({
          tool: toolNames.execCommand,
          workspaceId,
          action: validationAction,
          workspaceRevision: validationAction && snapshot.exitCode === 0
            ? await workspaceContentRevision(workspace.root)
            : undefined,
          success: snapshot.exitCode === 0,
          commandPreview: config.logging.shellCommands && snapshot.command
            ? commandPreview(snapshot.command)
            : undefined,
          exitCode: snapshot.exitCode,
          running: false,
          durationMs: snapshot.wallTimeMs,
        });
      }

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        outputBytes: snapshot.output?.length ?? 0,
        truncated: snapshot.outputTruncated,
        queuedMs: snapshot.queuedMs,
      });

      return processToolResponse("write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

function registerCodeIntelligenceTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  codeIntelligence: CodeIntelligenceManager,
  activityLog: ToolActivityLogManager,
): void {
  const commonPositionInput = {
    workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
    path: z.string().describe("TypeScript or JavaScript file path relative to the workspace root."),
    line: z.number().int().positive().describe("1-indexed source line."),
    column: z.number().int().positive().describe("1-indexed source column."),
    maxResults: z.number().int().min(1).max(1_000).optional().describe("Maximum workspace-local locations to return."),
  };

  registerAppTool(
    server,
    toolNames.diagnostics,
    {
      title: "Code diagnostics",
      description: toolSummary(toolNames.diagnostics),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().optional().describe("Optional TypeScript or JavaScript file path. Omit for the configured project."),
        scope: z.enum(["all", "syntactic", "semantic", "suggestion"]).optional().describe("Diagnostic scope. Defaults to all."),
        maxResults: z.number().int().min(1).max(500).optional().describe("Maximum diagnostics to return. Defaults to 100."),
      },
      outputSchema: diagnosticsStructuredOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspaceId, path, scope, maxResults }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const absolutePath = path ? workspaces.resolvePath(workspace, path) : undefined;
      let data: DiagnosticsResult;
      try {
        data = await codeIntelligence.diagnostics({
          root: workspace.root,
          path: absolutePath,
          scope,
          maxResults,
        });
      } catch (error) {
        data = failedDiagnosticsResult(error);
      }
      recordToolCall(config, activityLog, {
        tool: toolNames.diagnostics,
        workspaceId,
        path,
        success: data.supported,
        durationMs: Math.round(performance.now() - startedAt),
        truncated: data.summary.truncated,
      });
      return codeIntelligenceResponse(
        toolNames.diagnostics,
        workspaceId,
        formatDiagnosticsResult(data),
        data,
        {
          supported: data.supported,
          diagnostics: data.summary.diagnostics,
          errors: data.summary.errors,
          truncated: data.summary.truncated,
        },
        path,
      );
    },
  );

  for (const [name, title, run] of [
    [
      toolNames.definition,
      "Find definition",
      (input: Parameters<CodeIntelligenceManager["definitions"]>[0]) =>
        codeIntelligence.definitions(input),
    ],
    [
      toolNames.implementations,
      "Find implementations",
      (input: Parameters<CodeIntelligenceManager["implementations"]>[0]) =>
        codeIntelligence.implementations(input),
    ],
  ] as const) {
    registerAppTool(
      server,
      name,
      {
        title,
        description: toolSummary(name),
        inputSchema: commonPositionInput,
        outputSchema: locationsStructuredOutputSchema,
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ workspaceId, path, line, column, maxResults }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const absolutePath = workspaces.resolvePath(workspace, path);
        let data: LocationsResult;
        try {
          data = await run({
            root: workspace.root,
            path: absolutePath,
            line,
            column,
            maxResults,
          });
        } catch (error) {
          data = failedLocationsResult(error);
        }
        recordToolCall(config, activityLog, {
          tool: name,
          workspaceId,
          path,
          success: data.supported,
          durationMs: Math.round(performance.now() - startedAt),
          truncated: data.truncated,
        });
        return codeIntelligenceResponse(
          name,
          workspaceId,
          formatLocationsResult(name, data),
          data,
          {
            supported: data.supported,
            locations: data.locations.length,
            omittedExternal: data.omittedExternal,
            truncated: data.truncated,
          },
          path,
        );
      },
    );
  }

  registerAppTool(
    server,
    toolNames.renamePreview,
    {
      title: "Preview rename",
      description: toolSummary(toolNames.renamePreview),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().describe("TypeScript or JavaScript file path relative to the workspace root."),
        line: z.number().int().positive().describe("1-indexed source line."),
        column: z.number().int().positive().describe("1-indexed source column."),
        newName: z.string().min(1).max(200).describe("Replacement symbol name. This tool only previews edits."),
        maxLocations: z.number().int().min(1).max(1_000).optional().describe("Maximum edit locations to return. Defaults to 200."),
      },
      outputSchema: renamePreviewStructuredOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspaceId, path, line, column, newName, maxLocations }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const absolutePath = workspaces.resolvePath(workspace, path);
      let data: RenamePreviewResult;
      try {
        data = await codeIntelligence.renamePreview({
          root: workspace.root,
          path: absolutePath,
          line,
          column,
          newName,
          maxLocations,
        });
      } catch (error) {
        data = failedRenamePreviewResult(error);
      }
      recordToolCall(config, activityLog, {
        tool: toolNames.renamePreview,
        workspaceId,
        path,
        success: data.supported && data.canRename,
        durationMs: Math.round(performance.now() - startedAt),
        truncated: data.truncated,
      });
      return codeIntelligenceResponse(
        toolNames.renamePreview,
        workspaceId,
        formatRenamePreviewResult(data, newName),
        data,
        {
          supported: data.supported,
          canRename: data.canRename,
          files: data.files,
          edits: data.edits.length,
          truncated: data.truncated,
        },
        path,
      );
    },
  );
}

function codeIntelligenceResponse<T extends object>(
  tool: ToolName,
  workspaceId: string,
  text: string,
  data: T,
  summary: Record<string, unknown>,
  path?: string,
) {
  const content = [textBlock(text)];
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        path,
        summary: { ...summary, ...textSummary(content) },
        payload: { content },
      },
    },
    structuredContent: {
      result: text,
      text,
      ...data,
    } as Record<string, unknown>,
  };
}

function formatDiagnosticsResult(data: DiagnosticsResult): string {
  if (!data.supported) return `Code diagnostics unavailable: ${data.reason ?? "unknown reason"}`;
  const lines = [
    "Code diagnostics",
    `Project: ${formatCodeIntelligenceProject(data.project)}`,
    `Files: ${data.summary.files}; diagnostics: ${data.summary.diagnostics}; errors: ${data.summary.errors}; warnings: ${data.summary.warnings}; truncated: ${data.summary.truncated ? "yes" : "no"}`,
  ];
  if (data.diagnostics.length === 0 && data.projectDiagnostics.length === 0) {
    lines.push("No diagnostics.");
  }
  for (const item of data.projectDiagnostics) {
    lines.push(`- PROJECT ${item.category.toUpperCase()} TS${item.code}: ${item.message}`);
  }
  for (const item of data.diagnostics) {
    lines.push(
      `- ${item.path}:${item.line}:${item.column} ${item.category.toUpperCase()} TS${item.code}: ${item.message}`,
    );
  }
  return lines.join("\n");
}

function formatLocationsResult(tool: ToolName, data: LocationsResult): string {
  const label = tool === toolNames.definition ? "Definitions" : "Implementations";
  if (!data.supported) return `${label} unavailable: ${data.reason ?? "unknown reason"}`;
  const lines = [
    label,
    `Project: ${formatCodeIntelligenceProject(data.project)}`,
    `Locations: ${data.locations.length}; omitted external: ${data.omittedExternal}; truncated: ${data.truncated ? "yes" : "no"}`,
  ];
  if (data.locations.length === 0) lines.push("No workspace-local locations found.");
  for (const item of data.locations) {
    lines.push(`- ${item.path}:${item.line}:${item.column} ${item.kind} ${item.name}`);
  }
  return lines.join("\n");
}

function formatRenamePreviewResult(data: RenamePreviewResult, newName: string): string {
  if (!data.supported) return `Rename preview unavailable: ${data.reason ?? "unknown reason"}`;
  if (!data.canRename) return `Rename is not available: ${data.reason ?? "unknown reason"}`;
  const lines = [
    `Rename preview: ${data.displayName ?? "symbol"} -> ${newName}`,
    `Project: ${formatCodeIntelligenceProject(data.project)}`,
    `Files: ${data.files}; edits: ${data.edits.length}; omitted external: ${data.omittedExternal}; truncated: ${data.truncated ? "yes" : "no"}`,
    "No files were modified.",
  ];
  for (const edit of data.edits) {
    lines.push(`- ${edit.path}:${edit.line}:${edit.column} ${JSON.stringify(edit.oldText)} -> ${JSON.stringify(edit.newText)}`);
  }
  return lines.join("\n");
}

function formatCodeIntelligenceProject(project: CodeIntelligenceProject | undefined): string {
  if (!project) return "unknown";
  return project.kind === "configured"
    ? `configured (${project.configPath ?? "config"}; ${project.rootFileCount} root files)`
    : `inferred (${project.rootFileCount} root files)`;
}

function failedDiagnosticsResult(error: unknown): DiagnosticsResult {
  return {
    supported: false,
    reason: errorMessage(error),
    summary: {
      files: 0,
      diagnostics: 0,
      errors: 0,
      warnings: 0,
      suggestions: 0,
      messages: 0,
      truncated: false,
    },
    diagnostics: [],
    projectDiagnostics: [],
  };
}

function failedLocationsResult(error: unknown): LocationsResult {
  return {
    supported: false,
    reason: errorMessage(error),
    locations: [],
    omittedExternal: 0,
    truncated: false,
  };
}

function failedRenamePreviewResult(error: unknown): RenamePreviewResult {
  return {
    supported: false,
    canRename: false,
    reason: errorMessage(error),
    edits: [],
    files: 0,
    omittedExternal: 0,
    truncated: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertDedicatedGitCommitTool(
  command: string,
  context?: {
    config: ServerConfig;
    auditLog: AuditLogManager;
    activityLog: ToolActivityLogManager;
    tool: string;
    workspaceId: string;
    startedAt: number;
    workingDirectory?: string;
  },
): void {
  if (!commandInvokesGitCommit(command)) return;
  const message = "Direct Git commit commands are disabled in shell tools and package checks. Use the dedicated git_commit tool so policy, staged-path validation, deterministic preflight, and one-time approval remain authoritative.";
  if (context) {
    const durationMs = Math.round(performance.now() - context.startedAt);
    recordToolCall(context.config, context.activityLog, {
      tool: context.tool,
      workspaceId: context.workspaceId,
      workingDirectory: context.workingDirectory,
      command,
      commandLength: command.length,
      success: false,
      durationMs,
      error: message,
    });
    context.auditLog.record({
      tool: context.tool,
      workspaceId: context.workspaceId,
      action: "direct_git_commit_block",
      success: false,
      blocked: true,
      commandPreview: context.config.logging.shellCommands ? commandPreview(command) : undefined,
      durationMs,
      error: message,
    });
  }
  throw new Error(message);
}

async function assertGitAddTargetsAreExplicitFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (info.isDirectory()) {
        throw new Error(
          `git_add requires explicit file paths; directory staging is not supported: ${path}`,
        );
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

function workspacePolicyRoot(workspace: Workspace): string {
  return workspace.sourceRoot ?? workspace.root;
}

async function policyForTool(
  config: ServerConfig,
  policies: WorkspacePolicyManager,
  workspace: Workspace,
  auditLog: AuditLogManager,
  activityLog: ToolActivityLogManager,
  input: {
    tool: string;
    workspaceId: string;
    startedAt: number;
    path?: string;
    workingDirectory?: string;
    command?: string;
    enforce?: (policy: WorkspacePolicySnapshot) => void | Promise<void>;
  },
): Promise<WorkspacePolicySnapshot> {
  const policy = await policies.resolve(workspacePolicyRoot(workspace));
  try {
    await input.enforce?.(policy);
    return policy;
  } catch (error) {
    if (error instanceof WorkspacePolicyError) {
      recordToolCall(config, activityLog, {
        tool: input.tool,
        workspaceId: input.workspaceId,
        path: input.path,
        workingDirectory: input.workingDirectory,
        command: input.command,
        commandLength: input.command?.length,
        success: false,
        durationMs: Math.round(performance.now() - input.startedAt),
        error: error.message,
      });
      auditLog.record({
        tool: input.tool,
        workspaceId: input.workspaceId,
        action: `policy_block:${error.rule}`,
        success: false,
        blocked: true,
        paths: input.path ? [input.path] : undefined,
        commandPreview: input.command && config.logging.shellCommands
          ? commandPreview(input.command)
          : undefined,
        durationMs: Math.round(performance.now() - input.startedAt),
        error: error.message,
      });
    }
    throw error;
  }
}

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  checkSessions: CheckSessionManager,
  codeIntelligence: CodeIntelligenceManager,
  auditLog: AuditLogManager,
  activityLog: ToolActivityLogManager,
  requestMetrics: McpRequestMetricsManager,
  concurrency: ToolConcurrencyScheduler,
  commandApprovals: CommandApprovalManager,
  workspacePolicies: WorkspacePolicyManager,
): McpServer {
  const logToolCall = (currentConfig: ServerConfig, fields: ToolLogFields): void => {
    recordToolCall(currentConfig, activityLog, fields);
  };
  const logFailedToolResponse = (
    currentConfig: ServerConfig,
    fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
    content: ToolContent[],
    startedAt: number,
  ): void => {
    recordFailedToolResponse(currentConfig, activityLog, fields, content, startedAt);
  };

  const workspaceApp = getWorkspaceAppBuild();
  const server = new McpServer(
    {
      name: "localspace",
      title: "LocalSpace",
      version: "0.1.0",
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config),
    },
  );
  installMeasuredToolRegistration(server, activityLog, concurrency);

  registerAppResource(
    server,
    "LocalSpace Diff Card",
    workspaceApp.resourceUri,
    {
      description: "Interactive card for viewing LocalSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets(workspaceApp.entry);
      return {
        contents: [
          {
            uri: workspaceApp.resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config, workspaceApp.entry),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    toolNames.openWorkspace,
    {
      title: "Open workspace",
      description: toolSummary(toolNames.openWorkspace),
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        skills: z.array(workspaceSkillOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        policy: z.object({
          status: z.enum(["absent", "active", "anchored", "invalid"]),
          sourcePath: z.string(),
          present: z.boolean(),
          valid: z.boolean(),
          failClosed: z.boolean(),
          fingerprint: z.string().optional(),
          readOnlyPaths: z.number(),
          deniedCommandPatterns: z.number(),
          allowedPackageScripts: z.number().optional(),
          maxReadManyFiles: z.number(),
          allowCommands: z.boolean(),
          allowPty: z.boolean(),
          requireApprovalTools: z.array(z.enum(["exec_command", "run_checks"])),
          diagnostics: z.array(z.string()),
        }),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "open_workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef });
      const policy = await workspacePolicies.resolve(workspacePolicyRoot(workspace));
      const policyData = workspacePolicySummary(policy);
      if (config.widgets === "changes") {
        void reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const visibleSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const baseInstruction = config.skillsEnabled
        ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const instruction = policy.status === "absent"
        ? baseInstruction
        : `${baseInstruction} Workspace policy restrictions are authoritative and may only reduce available operations.${policy.failClosed ? " The policy is invalid, so mutations and commands are fail-closed until it is fixed outside LocalSpace." : ""}`;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            `Workspace policy: ${policyData.status}${policyData.failClosed ? " (fail-closed)" : ""}`,
            ...policyData.diagnostics.map((diagnostic) => `Policy diagnostic: ${diagnostic}`),
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      auditLog.record({
        tool: "open_workspace",
        workspaceId: workspace.id,
        success: true,
        paths: [workspace.root],
        durationMs: Math.round(performance.now() - startedAt),
      });
      auditLog.record({
        tool: "workspace_policy",
        workspaceId: workspace.id,
        action: `load:${policy.status}`,
        success: policy.valid,
        blocked: policy.failClosed,
        paths: [policyData.sourcePath],
        durationMs: Math.round(performance.now() - startedAt),
        error: policyData.diagnostics.join(" ") || undefined,
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            summary: {
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
              skillDiagnostics: workspace.skillDiagnostics.length,
              policyStatus: policyData.status,
              policyFailClosed: policyData.failClosed,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentsFiles: loadedAgentsFiles,
          availableAgentsFiles: availableAgentsFileOutputs,
          skills: visibleSkills,
          skillDiagnostics: workspace.skillDiagnostics,
          policy: policyData,
          instruction,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description: toolSummary(toolNames.read),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  if (toolAvailable(toolNames.readMany, config.toolMode, config.widgets, config.toolPacks)) {
    registerAppTool(
      server,
      toolNames.readMany,
      {
        title: "Read multiple files",
        description: toolSummary(toolNames.readMany),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          files: z
            .array(
              z.object({
                path: z.string().min(1).describe("File path relative to the workspace root, or an authorized Skill path."),
                offset: z.number().int().positive().optional().describe("1-indexed line number to start reading from."),
                limit: z.number().int().positive().optional().describe("Maximum number of lines to read."),
              }),
            )
            .min(1)
            .max(MAX_READ_MANY_FILES)
            .describe(`Known text files to read in input order. Maximum ${MAX_READ_MANY_FILES}.`),
          maxTotalCharacters: z
            .number()
            .int()
            .min(1)
            .max(MAX_READ_MANY_TOTAL_CHARACTERS)
            .optional()
            .describe("Maximum combined returned text characters. Defaults to 50000, max 200000."),
        },
        outputSchema: readManyOutputSchema,
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, files, maxTotalCharacters }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        await policyForTool(
          config,
          workspacePolicies,
          workspace,
          auditLog,
          activityLog,
          {
            tool: toolNames.readMany,
            workspaceId,
            startedAt,
            path: `${files.length} files`,
            enforce: (policy) => assertPolicyReadManyAllowed(policy, files.length),
          },
        );
        const prepared = files.map((file) => {
          try {
            return { readPath: workspaces.resolveReadPath(workspace, file.path) };
          } catch (error) {
            return { error: error instanceof Error ? error : new Error(String(error)) };
          }
        });
        const data = await readManyFiles(
          files,
          async (file, index) => {
            const item = prepared[index];
            if (!item || "error" in item) throw item?.error ?? new Error("Missing prepared read path.");
            const response = await readFileTool(
              { ...file, path: item.readPath.absolutePath },
              {
                cwd: workspace.root,
                root: workspace.root,
                readRoots: item.readPath.readRoots,
              },
            );
            if (!response.isError) workspaces.markReadPathLoaded(workspace, item.readPath);
            return response;
          },
          { maxTotalCharacters },
        );
        const content = [textBlock(data.text)];
        logToolCall(config, {
          tool: toolNames.readMany,
          workspaceId,
          path: `${files.length} files`,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          truncated: data.summary.truncated > 0,
        });
        return {
          content,
          _meta: {
            tool: toolNames.readMany,
            card: {
              workspaceId,
              summary: data.summary,
              payload: { content },
            },
          },
          structuredContent: {
            result: data.text,
            results: data.results,
            summary: data.summary,
          },
        };
      },
    );
  }

  registerAppTool(
    server,
    toolNames.doctor,
    {
      title: "Doctor",
      description: toolSummary(toolNames.doctor),
      inputSchema: {
        workspaceId: z
          .string()
          .optional()
          .describe("Optional workspace identifier returned by open_workspace. When provided, workspace-specific diagnostics are included."),
      },
      outputSchema: doctorStructuredOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaceId ? workspaces.getWorkspace(workspaceId) : undefined;
      const data = await generateDoctorReportData(config, { workspace });
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.doctor,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.doctor,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.workspaceInfo,
    {
      title: "Workspace info",
      description: toolSummary(toolNames.workspaceInfo),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: workspaceInfoStructuredOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const data = await generateWorkspaceInfoData(workspace);
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.workspaceInfo,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.workspaceInfo,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.sessionSummary,
    {
      title: "Session summary",
      description: toolSummary(toolNames.sessionSummary),
      inputSchema: {
        workspaceId: z.string().optional().describe("Optional workspace identifier returned by open_workspace. Omit to summarize all recent workspaces."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum recent activity and audit events to summarize. Defaults to 50."),
      },
      outputSchema: sessionSummaryOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, limit }) => {
      const startedAt = performance.now();
      if (workspaceId) workspaces.getWorkspace(workspaceId);
      const activity = activityLog.summarize({ workspaceId, limit });
      const audit = auditLog.summarize({ workspaceId, limit });
      const requests = requestMetrics.summarize({ workspaceId, limit });
      const data = {
        ...activity,
        blockedEvents: audit.blockedEvents,
        approvedEvents: audit.approvedEvents,
        durableAuditEvents: audit.totalEvents,
        paths: [...new Set([...activity.paths, ...audit.paths])].sort(),
        commands: audit.commands,
        risks: audit.risks,
        recentAuditEvents: audit.recentEvents,
        requestMetrics: requests,
        text: [
          activity.text,
          "",
          audit.text.replace(/^Session summary/, "Durable audit summary"),
        ].join("\n"),
      };
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.sessionSummary,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.sessionSummary,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.entrypoints,
    {
      title: "Entrypoints",
      description: toolSummary(toolNames.entrypoints),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: entrypointsStructuredOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const data = await findEntrypointsData(workspace.root);
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.entrypoints,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.entrypoints,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  if (config.toolMode === "full" || config.toolMode === "hybrid") {
    registerAppTool(
      server,
      toolNames.codeMap,
      {
        title: "Code map",
        description: toolSummary(toolNames.codeMap),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          path: z.string().optional().describe("File or directory path relative to the workspace root. Defaults to '.'."),
          depth: z.number().int().min(0).max(6).optional().describe("Project tree depth. Defaults to 2, max 6."),
          maxEntries: z.number().int().min(1).max(1_000).optional().describe("Maximum project tree entries. Defaults to 120, max 1000."),
          maxSymbols: z.number().int().min(1).max(500).optional().describe("Maximum exported symbols. Defaults to 80, max 500."),
          maxImports: z.number().int().min(1).max(500).optional().describe("Maximum import/export entries. Defaults to 80, max 500."),
        },
        outputSchema: codeMapStructuredOutputSchema,
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, path, depth, maxEntries, maxSymbols, maxImports }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const relativePath = path ?? ".";
        const absolutePath = workspaces.resolvePath(workspace, relativePath);
        const data = await generateCodeMapData(workspace.root, absolutePath, {
          path: relativePath,
          depth,
          maxEntries,
          maxSymbols,
          maxImports,
        });
        const content = [textBlock(data.text)];

        logToolCall(config, {
          tool: toolNames.codeMap,
          workspaceId,
          path: relativePath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.codeMap,
            card: {
              workspaceId,
              path: relativePath,
              summary: {
                depth: depth ?? 2,
                maxEntries: maxEntries ?? 120,
                maxSymbols: maxSymbols ?? 80,
                maxImports: maxImports ?? 80,
                ...textSummary(content),
              },
              payload: { content },
            },
          },
          structuredContent: { result: data.text, ...data },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.projectMap,
      {
        title: "Project map",
        description: toolSummary(toolNames.projectMap),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .optional()
            .describe("Directory path relative to the workspace root. Defaults to '.'."),
          depth: z
            .number()
            .int()
            .min(0)
            .max(8)
            .optional()
            .describe("Directory depth to render. Defaults to 3, max 8."),
          maxEntries: z
            .number()
            .int()
            .min(1)
            .max(2_000)
            .optional()
            .describe("Maximum entries to render. Defaults to 300, max 2000."),
          includeFiles: z.boolean().optional().describe("Whether to include files. Defaults to true."),
          showHidden: z
            .boolean()
            .optional()
            .describe("Whether to show hidden files and directories. Defaults to false."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, path, depth, maxEntries, includeFiles, showHidden }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const relativePath = path ?? ".";
        const absolutePath = workspaces.resolvePath(workspace, relativePath);
        const result = await generateProjectMap(workspace.root, absolutePath, {
          depth,
          maxEntries,
          includeFiles,
          showHidden,
        });
        const content = [textBlock(result)];

        logToolCall(config, {
          tool: toolNames.projectMap,
          workspaceId,
          path: relativePath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.projectMap,
            card: {
              workspaceId,
              path: relativePath,
              summary: {
                depth: depth ?? 3,
                maxEntries: maxEntries ?? 300,
                includeFiles: includeFiles ?? true,
                showHidden: showHidden ?? false,
                ...textSummary(content),
              },
              payload: { content },
            },
          },
          structuredContent: {
            result,
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.symbols,
      {
        title: "Symbols",
        description: toolSummary(toolNames.symbols),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .optional()
            .describe("File or directory path relative to the workspace root. Defaults to '.'."),
          query: z.string().optional().describe("Optional case-insensitive name substring filter."),
          kind: z
            .enum(["class", "function", "interface", "type", "enum", "variable", "method"])
            .optional()
            .describe("Optional symbol kind filter."),
          includeNonExported: z.boolean().optional().describe("Whether to include non-exported symbols. Defaults to true."),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(2_000)
            .optional()
            .describe("Maximum symbols to return. Defaults to 300, max 2000."),
          maxFiles: z
            .number()
            .int()
            .min(1)
            .max(5_000)
            .optional()
            .describe("Maximum source files to scan. Defaults to 500, max 5000."),
        },
        outputSchema: symbolsStructuredOutputSchema,
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, path, query, kind, includeNonExported, maxResults, maxFiles }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const relativePath = path ?? ".";
        const absolutePath = workspaces.resolvePath(workspace, relativePath);
        const data = await findSymbolsData(workspace.root, absolutePath, {
          query,
          kind,
          includeNonExported,
          maxResults,
          maxFiles,
        });
        const content = [textBlock(data.text)];

        logToolCall(config, {
          tool: toolNames.symbols,
          workspaceId,
          path: relativePath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.symbols,
            card: {
              workspaceId,
              path: relativePath,
              summary: {
                query,
                kind,
                includeNonExported: includeNonExported ?? true,
                maxResults: maxResults ?? 300,
                maxFiles: maxFiles ?? 500,
                ...textSummary(content),
              },
              payload: { content },
            },
          },
          structuredContent: { result: data.text, ...data },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.imports,
      {
        title: "Imports",
        description: toolSummary(toolNames.imports),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .optional()
            .describe("File or directory path relative to the workspace root. Defaults to '.'."),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(5_000)
            .optional()
            .describe("Maximum import/export entries to return. Defaults to 500, max 5000."),
          maxFiles: z
            .number()
            .int()
            .min(1)
            .max(5_000)
            .optional()
            .describe("Maximum source files to scan. Defaults to 500, max 5000."),
        },
        outputSchema: importsStructuredOutputSchema,
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, path, maxResults, maxFiles }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const relativePath = path ?? ".";
        const absolutePath = workspaces.resolvePath(workspace, relativePath);
        const data = await findImportsData(workspace.root, absolutePath, { maxResults, maxFiles });
        const content = [textBlock(data.text)];

        logToolCall(config, {
          tool: toolNames.imports,
          workspaceId,
          path: relativePath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.imports,
            card: {
              workspaceId,
              path: relativePath,
              summary: {
                maxResults: maxResults ?? 500,
                maxFiles: maxFiles ?? 500,
                ...textSummary(content),
              },
              payload: { content },
            },
          },
          structuredContent: { result: data.text, ...data },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.references,
      {
        title: "References",
        description: toolSummary(toolNames.references),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          query: z.string().min(1).describe("Identifier name to search for."),
          path: z
            .string()
            .optional()
            .describe("File or directory path relative to the workspace root. Defaults to '.'."),
          includeDefinitions: z.boolean().optional().describe("Whether to include definitions. Defaults to false."),
          caseSensitive: z.boolean().optional().describe("Whether identifier matching is case-sensitive. Defaults to true."),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(5_000)
            .optional()
            .describe("Maximum references to return. Defaults to 500, max 5000."),
          maxFiles: z
            .number()
            .int()
            .min(1)
            .max(5_000)
            .optional()
            .describe("Maximum source files to scan. Defaults to 500, max 5000."),
        },
        outputSchema: referencesStructuredOutputSchema,
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, query, path, includeDefinitions, caseSensitive, maxResults, maxFiles }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const relativePath = path ?? ".";
        const absolutePath = workspaces.resolvePath(workspace, relativePath);
        const data = await findReferencesData(workspace.root, absolutePath, {
          query,
          includeDefinitions,
          caseSensitive,
          maxResults,
          maxFiles,
        });
        const content = [textBlock(data.text)];

        logToolCall(config, {
          tool: toolNames.references,
          workspaceId,
          path: relativePath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.references,
            card: {
              workspaceId,
              path: relativePath,
              summary: {
                query,
                includeDefinitions: includeDefinitions ?? false,
                caseSensitive: caseSensitive ?? true,
                maxResults: maxResults ?? 500,
                maxFiles: maxFiles ?? 500,
                ...textSummary(content),
              },
              payload: { content },
            },
          },
          structuredContent: { result: data.text, ...data },
        };
      },
    );
  }

  if (config.toolMode !== "codex" && config.toolMode !== "hybrid") {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description: toolSummary(toolNames.write),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      await policyForTool(
        config,
        workspacePolicies,
        workspace,
        auditLog,
        activityLog,
        {
          tool: toolNames.write,
          workspaceId,
          startedAt,
          path: input.path,
          enforce: (policy) => assertPolicyWritablePaths(policy, workspace.root, [targetPath]),
        },
      );
      assertWritablePath(targetPath, { workspaceRoot: workspace.root, config });
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      auditLog.record({
        tool: toolNames.write,
        workspaceId,
        success: true,
        paths: [workspaceRelativePath(workspace.root, targetPath)],
        additions: stats.additions,
        removals: stats.removals,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.validatePlan,
    {
      title: "Validation plan",
      description: toolSummary(toolNames.validatePlan),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: validatePlanOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const data = await createValidatePlan(workspace.root);
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.validatePlan,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.validatePlan,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.reviewChecklist,
    {
      title: "Review checklist",
      description: toolSummary(toolNames.reviewChecklist),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: reviewChecklistOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const data = await createReviewChecklist(workspace.root);
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.reviewChecklist,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.reviewChecklist,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.nextSteps,
    {
      title: "Next steps",
      description: toolSummary(toolNames.nextSteps),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: nextStepsOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const audit = auditLog.summarize({ workspaceId, limit: 50 });
      const data = await createNextSteps(workspace.root, audit);
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.nextSteps,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.nextSteps,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.taskSummary,
    {
      title: "Task summary",
      description: toolSummary(toolNames.taskSummary),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: taskSummaryOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const audit = auditLog.summarize({ workspaceId, limit: 100 });
      const data = await createTaskSummary(workspace.root, audit);
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.taskSummary,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.taskSummary,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.validationSummary,
    {
      title: "Validation summary",
      description: toolSummary(toolNames.validationSummary),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: validationSummaryOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const audit = auditLog.summarize({ workspaceId, limit: 100 });
      const data = await createValidationSummary(workspace.root, audit);
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.validationSummary,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.validationSummary,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.finalReport,
    {
      title: "Final report",
      description: toolSummary(toolNames.finalReport),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        taskTitle: z.string().optional().describe("Optional task or phase title to include in the report."),
        completed: z.array(z.string()).optional().describe("Optional completed-work bullets to include in the report."),
        remaining: z.array(z.string()).optional().describe("Optional remaining-task bullets to include in the report."),
      },
      outputSchema: finalReportOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, taskTitle, completed, remaining }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const audit = auditLog.summarize({ workspaceId, limit: 100 });
      const data = await createFinalReport(workspace.root, audit, { taskTitle, completed, remaining });
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.finalReport,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.finalReport,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.handoffSummary,
    {
      title: "Handoff summary",
      description: toolSummary(toolNames.handoffSummary),
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        taskTitle: z.string().optional().describe("Optional task or phase title to include indirectly through the generated report."),
        completed: z.array(z.string()).optional().describe("Optional completed-work bullets to include in the generated report context."),
        remaining: z.array(z.string()).optional().describe("Optional remaining-task bullets to include in the generated report context."),
        currentPhase: z.string().optional().describe("Current phase or status label for the handoff."),
        completedPhases: z.array(z.string()).optional().describe("Completed phase bullets for the handoff."),
        remainingTasks: z.array(z.string()).optional().describe("Remaining task bullets for the handoff."),
        knownWarnings: z.array(z.string()).optional().describe("Known warnings or caveats for the next chat."),
        nextPrompt: z.string().optional().describe("Exact suggested first prompt for the next chat."),
      },
      outputSchema: handoffSummaryOutputSchema,
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, taskTitle, completed, remaining, currentPhase, completedPhases, remainingTasks, knownWarnings, nextPrompt }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const audit = auditLog.summarize({ workspaceId, limit: 100 });
      const data = await createHandoffSummary(workspace.root, audit, {
        taskTitle,
        completed,
        remaining,
        currentPhase,
        completedPhases,
        remainingTasks,
        knownWarnings,
        nextPrompt,
      });
      const content = [textBlock(data.text)];

      logToolCall(config, {
        tool: toolNames.handoffSummary,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.handoffSummary,
          card: {
            workspaceId,
            summary: textSummary(content),
            payload: { content },
          },
        },
        structuredContent: { result: data.text, ...data },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description: toolSummary(toolNames.edit),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      await policyForTool(
        config,
        workspacePolicies,
        workspace,
        auditLog,
        activityLog,
        {
          tool: toolNames.edit,
          workspaceId,
          startedAt,
          path: input.path,
          enforce: (policy) => assertPolicyWritablePaths(policy, workspace.root, [targetPath]),
        },
      );
      assertWritablePath(targetPath, { workspaceRoot: workspace.root, config });
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      auditLog.record({
        tool: toolNames.edit,
        workspaceId,
        success: true,
        paths: [workspaceRelativePath(workspace.root, targetPath)],
        additions: stats.additions,
        removals: stats.removals,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex" || config.toolMode === "hybrid") {
    registerAppTool(
      server,
      toolNames.applyPatch,
      {
        title: "Apply patch",
        description: toolSummary(toolNames.applyPatch),
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const patchPaths = parsePatch(patch).flatMap((action) => {
          if (action.kind === "update" && action.moveTo) return [action.path, action.moveTo];
          return [action.path];
        });
        const absolutePatchPaths = patchPaths.map((path) => workspaces.resolvePath(workspace, path));
        await policyForTool(
          config,
          workspacePolicies,
          workspace,
          auditLog,
          activityLog,
          {
            tool: toolNames.applyPatch,
            workspaceId,
            startedAt,
            path: patchPaths.length === 1 ? patchPaths[0] : `${patchPaths.length} files`,
            enforce: (policy) => assertPolicyWritablePaths(policy, workspace.root, absolutePatchPaths),
          },
        );
        assertWritablePaths(
          absolutePatchPaths,
          { workspaceRoot: workspace.root, config },
        );
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        auditLog.record({
          tool: "apply_patch",
          workspaceId,
          success: true,
          paths: applied.files.map((file) => file.path),
          additions: applied.additions,
          removals: applied.removals,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              payload: { patch: applied.patch },
            },
          },
          structuredContent: {
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      toolNames.showChanges,
      {
        title: "Show changes",
        description: toolSummary(toolNames.showChanges),
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: "last_shown",
          markReviewed: true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  if (config.toolMode === "codex" || config.toolMode === "hybrid" || config.toolMode === "full") {
    registerAppTool(
      server,
      toolNames.changes,
      {
        title: "Changes",
        description: toolSummary(toolNames.changes),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          mode: z
            .enum(["summary", "stat", "patch"])
            .optional()
            .describe("Output mode. Defaults to summary."),
          staged: z.boolean().optional().describe("Show staged changes. Defaults to false."),
          maxOutputChars: z
            .number()
            .int()
            .min(1)
            .max(100_000)
            .optional()
            .describe("Maximum output characters. Defaults to 20000, max 100000."),
        },
        outputSchema: changesStructuredOutputSchema,
        _meta: {},
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, mode, staged, maxOutputChars }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const data = await getGitChangesData(workspace.root, {
          mode,
          staged,
          maxOutputChars,
        });
        const content = [textBlock(data.text)];

        logToolCall(config, {
          tool: toolNames.changes,
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.changes,
            card: {
              workspaceId,
              summary: {
                mode: mode ?? "summary",
                staged: staged ?? false,
                maxOutputChars: maxOutputChars ?? 20_000,
                ...textSummary(content),
              },
              payload: { content },
            },
          },
          structuredContent: { result: data.text, ...data },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.gitStatus,
      {
        title: "Git status",
        description: toolSummary(toolNames.gitStatus),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          maxOutputChars: z
            .number()
            .int()
            .min(1)
            .max(100_000)
            .optional()
            .describe("Maximum output characters. Defaults to 20000, max 100000."),
        },
        outputSchema: gitStatusStructuredOutputSchema,
        _meta: {},
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, maxOutputChars }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const data = await gitStatusData(workspace.root, { maxOutputChars });
        const content = [textBlock(data.text)];
        logToolCall(config, {
          tool: toolNames.gitStatus,
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.gitStatus,
            card: {
              workspaceId,
              summary: textSummary(content),
              payload: { content },
            },
          },
          structuredContent: { result: data.text, ...data },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.gitDiff,
      {
        title: "Git diff",
        description: toolSummary(toolNames.gitDiff),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          staged: z.boolean().optional().describe("Show staged diff. Defaults to false."),
          stat: z.boolean().optional().describe("Show diff stat instead of patch. Defaults to false."),
          maxOutputChars: z
            .number()
            .int()
            .min(1)
            .max(100_000)
            .optional()
            .describe("Maximum output characters. Defaults to 20000, max 100000."),
        },
        outputSchema: gitDiffStructuredOutputSchema,
        _meta: {},
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, staged, stat, maxOutputChars }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const data = await gitDiffData(workspace.root, { staged, stat, maxOutputChars });
        const content = [textBlock(data.text)];
        logToolCall(config, {
          tool: toolNames.gitDiff,
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.gitDiff,
            card: {
              workspaceId,
              summary: {
                staged: staged ?? false,
                stat: stat ?? false,
                ...textSummary(content),
              },
              payload: { content },
            },
          },
          structuredContent: { result: data.text, ...data },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.gitAdd,
      {
        title: "Git add",
        description: toolSummary(toolNames.gitAdd),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          paths: z.array(z.string()).min(1).describe("Workspace-relative paths to stage."),
          maxOutputChars: z
            .number()
            .int()
            .min(1)
            .max(100_000)
            .optional()
            .describe("Maximum output characters. Defaults to 20000, max 100000."),
        },
        outputSchema: gitAddStructuredOutputSchema,
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, paths, maxOutputChars }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const absolutePaths = paths.map((path) => workspaces.resolvePath(workspace, path));
        await assertGitAddTargetsAreExplicitFiles(absolutePaths);
        await policyForTool(
          config,
          workspacePolicies,
          workspace,
          auditLog,
          activityLog,
          {
            tool: toolNames.gitAdd,
            workspaceId,
            startedAt,
            path: paths.join(", "),
            enforce: (policy) => assertPolicyGitAddPaths(policy, workspace.root, absolutePaths),
          },
        );
        assertWritablePaths(
          absolutePaths,
          { workspaceRoot: workspace.root, config },
        );
        const data = await gitAddData(workspace.root, paths, { maxOutputChars });
        const content = [textBlock(data.text)];
        logToolCall(config, {
          tool: toolNames.gitAdd,
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        auditLog.record({
          tool: toolNames.gitAdd,
          workspaceId,
          success: true,
          paths,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.gitAdd,
            card: {
              workspaceId,
              summary: {
                paths: paths.length,
                ...textSummary(content),
              },
              payload: { content },
            },
          },
          structuredContent: { result: data.text, ...data },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.gitCommit,
      {
        title: "Git commit",
        description: toolSummary(toolNames.gitCommit),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          message: z.string().min(1).describe("Commit message."),
          maxOutputChars: z
            .number()
            .int()
            .min(1)
            .max(100_000)
            .optional()
            .describe("Maximum output characters. Defaults to 20000, max 100000."),
          approvalToken: z
            .string()
            .optional()
            .describe("One-time approval token returned by a blocked deterministic commit preflight."),
        },
        outputSchema: gitCommitStructuredOutputSchema,
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, message, maxOutputChars, approvalToken }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const stagedPaths = await gitStagedPaths(workspace.root);
        const workspaceStagedPaths = stagedPaths.map((path) => workspaces.resolvePath(workspace, path));
        const relativeStagedPaths = workspaceStagedPaths
          .map((path) => workspaceRelativePath(workspace.root, path))
          .sort();
        await policyForTool(
          config,
          workspacePolicies,
          workspace,
          auditLog,
          activityLog,
          {
            tool: toolNames.gitCommit,
            workspaceId,
            startedAt,
            path: relativeStagedPaths.length > 0
              ? relativeStagedPaths.join(", ")
              : undefined,
            enforce: (policy) => {
              assertPolicyMutationAllowed(policy);
              assertPolicyWritablePaths(
                policy,
                workspace.root,
                workspaceStagedPaths,
              );
            },
          },
        );
        assertWritablePaths(workspaceStagedPaths, { workspaceRoot: workspace.root, config });
        const revision = await workspaceRevision(workspace.root);
        const automation = await createDeterministicAutomation(
          workspace.root,
          relativeStagedPaths,
          auditLog.summarize({ workspaceId, limit: 500 }),
          { staged: relativeStagedPaths.length > 0 },
        );
        const safety = message.trim()
          ? deterministicAutomationSafety(automation)
          : { level: "none" as const, findings: [] };
        const approvalCommand = gitCommitApprovalCommand({
          message,
          workspaceRevision: revision,
          stagedPaths: relativeStagedPaths,
          automation,
        });
        const approvalContext = {
          workspaceId,
          cwd: workspace.root,
          command: approvalCommand,
          safety,
        };
        const approval = safety.level === "danger"
          ? commandApprovals.consume(approvalToken, approvalContext)
          : { approved: true };

        if (safety.level === "danger" && !approval.approved) {
          const request = commandApprovals.create(approvalContext);
          auditLog.record({
            tool: toolNames.gitCommit,
            workspaceId,
            action: "deterministic_preflight",
            success: false,
            blocked: true,
            risk: safety.level,
            paths: relativeStagedPaths,
            durationMs: Math.round(performance.now() - startedAt),
          });
          recordToolCall(config, activityLog, {
            tool: toolNames.gitCommit,
            workspaceId,
            path: relativeStagedPaths.join(", ") || undefined,
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error: "Deterministic commit preflight requires approval.",
          });
          return blockedGitCommitResult({
            workspaceId,
            message,
            workspaceRevision: revision,
            automation,
            safety,
            approval: request,
            approvalResult: approval,
          });
        }

        const data = await gitCommitData(workspace.root, { message, maxOutputChars });
        const content = [textBlock(data.text)];
        logToolCall(config, {
          tool: toolNames.gitCommit,
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        auditLog.record({
          tool: toolNames.gitCommit,
          workspaceId,
          action: "deterministic_preflight",
          success: data.committed,
          approved: safety.level === "danger" ? approval.approved : undefined,
          risk: safety.level,
          paths: relativeStagedPaths,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.gitCommit,
            card: {
              workspaceId,
              summary: textSummary(content),
              payload: { content },
            },
          },
          structuredContent: {
            result: data.text,
            ...data,
            commandApproved: safety.level === "danger" ? approval.approved : undefined,
            workspaceRevision: revision,
            commandRisk: safety.level,
            commandSafetyFindings: safety.findings,
            automation,
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.gitLog,
      {
        title: "Git log",
        description: toolSummary(toolNames.gitLog),
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          limit: z.number().int().min(1).max(100).optional().describe("Number of commits. Defaults to 10, max 100."),
          maxOutputChars: z
            .number()
            .int()
            .min(1)
            .max(100_000)
            .optional()
            .describe("Maximum output characters. Defaults to 20000, max 100000."),
        },
        outputSchema: gitLogStructuredOutputSchema,
        _meta: {},
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, limit, maxOutputChars }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const data = await gitLogData(workspace.root, { limit, maxOutputChars });
        const content = [textBlock(data.text)];
        logToolCall(config, {
          tool: toolNames.gitLog,
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.gitLog,
            card: {
              workspaceId,
              summary: {
                limit: limit ?? 10,
                ...textSummary(content),
              },
              payload: { content },
            },
          },
          structuredContent: { result: data.text, ...data },
        };
      },
    );
  }

  if (config.toolMode === "full" || config.toolMode === "hybrid") {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description: toolSummary(toolNames.grep),
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description: toolSummary(toolNames.glob),
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description: toolSummary(toolNames.ls),
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex" && config.toolMode !== "hybrid") {
  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: toolSummary(toolNames.shell),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      assertDedicatedGitCommitTool(input.command, {
        config,
        auditLog,
        activityLog,
        tool: toolNames.shell,
        workspaceId,
        startedAt,
        workingDirectory: workingDirectory ?? ".",
      });
      await policyForTool(
        config,
        workspacePolicies,
        workspace,
        auditLog,
        activityLog,
        {
          tool: toolNames.shell,
          workspaceId,
          startedAt,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          enforce: (policy) => {
            assertPolicyCommandAllowed(policy, input.command, false);
            if (policyRequiresApproval(policy, "exec_command")) {
              throw new WorkspacePolicyError(
                "requireApprovalTools",
                "The legacy shell cannot satisfy explicit command approval; use exec_command.",
              );
            }
          },
        },
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex" || config.toolMode === "hybrid") {
    registerCodexProcessTools(
      server,
      config,
      workspaces,
      processSessions,
      checkSessions,
      auditLog,
      activityLog,
      commandApprovals,
      workspacePolicies,
    );
  }

  if (config.toolPacks.includes("code-intelligence")) {
    registerCodeIntelligenceTools(
      server,
      config,
      workspaces,
      codeIntelligence,
      activityLog,
    );
  }

  return server;
}

export function createServer(config = loadConfig()): RunningServer {
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = config.mcpTransportMode === "stateful"
    ? new McpSessionRegistry<Transport>(config.mcpSessions, (event) => {
        logMcpSessionEvent(config, event);
      })
    : undefined;
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "localspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const workspacePolicies = new WorkspacePolicyManager(config.stateDir);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager({
    shell: config.shell,
    maxConcurrentProcesses: config.concurrency.maxConcurrentProcesses,
    maxWorkspaceProcesses: config.concurrency.maxWorkspaceProcesses,
    queueTimeoutMs: config.concurrency.queueTimeoutMs,
  });
  const checkSessions = new CheckSessionManager(processSessions);
  const codeIntelligence = new CodeIntelligenceManager();
  const auditLog = new AuditLogManager(config.audit);
  const activityLog = new ToolActivityLogManager(config.audit.maxMemoryEvents);
  const requestMetrics = new McpRequestMetricsManager(config.audit.maxMemoryEvents);
  const concurrency = new ToolConcurrencyScheduler(config.concurrency, {
    workspaceKey: (workspaceId) => workspaces.getWorkspace(workspaceId).root,
  });
  const commandApprovals = new CommandApprovalManager();

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "LocalSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "localspace" });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    const rpcInfo = mcpRpcRequestInfo(req.body);
    const requestStartedAt = performance.now();
    let authMs = 0;
    let serverCreateMs = 0;
    let transportConnectMs = 0;
    let transportHandleMs = 0;
    let cleanupMs = 0;

    try {
      const authStartedAt = performance.now();
      try {
        await new Promise<void>((resolve, reject) => {
          bearerAuth(req, res, (error?: unknown) => {
            if (error) reject(error);
            else resolve();
          });
        });
      } finally {
        authMs = Math.round((performance.now() - authStartedAt) * 100) / 100;
      }
      if (res.headersSent) return;

      if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
        logEvent(config.logging, "warn", "auth_denied", {
          requestId,
          method: req.method,
          path: requestPath(req),
          reason: "invalid_oauth_resource",
          ...requestLogFields(req, config),
        });
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }

      logEvent(config.logging, "debug", "mcp_request", {
        requestId,
        method: req.method,
        sessionIdPresent: Boolean(sessionId),
        sessionIdPrefix: sessionIdPrefix(sessionId),
        isInitialize: initializeRequest,
      });

      if (config.mcpTransportMode === "stateless") {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          sendJsonRpcError(res, 405, -32000, "Method not allowed in stateless mode");
          return;
        }

        const serverCreateStartedAt = performance.now();
        const statelessTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const statelessServer = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          checkSessions,
          codeIntelligence,
          auditLog,
          activityLog,
          requestMetrics,
          concurrency,
          commandApprovals,
          workspacePolicies,
        );
        serverCreateMs = Math.round((performance.now() - serverCreateStartedAt) * 100) / 100;

        const connectStartedAt = performance.now();
        await statelessServer.connect(statelessTransport);
        transportConnectMs = Math.round((performance.now() - connectStartedAt) * 100) / 100;
        try {
          const handleStartedAt = performance.now();
          try {
            await statelessTransport.handleRequest(req, res, req.body);
          } finally {
            transportHandleMs = Math.round((performance.now() - handleStartedAt) * 100) / 100;
          }
        } finally {
          const cleanupStartedAt = performance.now();
          try {
            await statelessServer.close();
          } catch (error) {
            logEvent(config.logging, "warn", "mcp_stateless_cleanup_error", {
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            cleanupMs = Math.round((performance.now() - cleanupStartedAt) * 100) / 100;
          }
        }
        return;
      }

      let transport: Transport | undefined;
      if (!transports) {
        throw new Error("Stateful MCP session registry is unavailable.");
      }
      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          logEvent(config.logging, "warn", "mcp_session_not_found", {
            requestId,
            method: req.method,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            isInitialize: initializeRequest,
            activeSessions: transports.size(),
            ...requestLogFields(req, config),
          });
          sendJsonRpcError(res, 404, -32001, "Session not found");
          return;
        }
      } else if (initializeRequest) {
        const serverCreateStartedAt = performance.now();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.add(newSessionId, transport);
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId, "client_closed", { closeTransport: false });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          checkSessions,
          codeIntelligence,
          auditLog,
          activityLog,
          requestMetrics,
          concurrency,
          commandApprovals,
          workspacePolicies,
        );
        serverCreateMs = Math.round((performance.now() - serverCreateStartedAt) * 100) / 100;
        const connectStartedAt = performance.now();
        await server.connect(transport);
        transportConnectMs = Math.round((performance.now() - connectStartedAt) * 100) / 100;
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      const handleStartedAt = performance.now();
      try {
        await transport.handleRequest(req, res, req.body);
      } finally {
        transportHandleMs = Math.round((performance.now() - handleStartedAt) * 100) / 100;
      }
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    } finally {
      const totalMs = Math.round((performance.now() - requestStartedAt) * 100) / 100;
      const metric = {
        requestId,
        transportMode: config.mcpTransportMode,
        httpMethod: req.method,
        rpcMethod: rpcInfo.rpcMethod,
        tool: rpcInfo.tool,
        workspaceId: rpcInfo.workspaceId,
        status: res.statusCode,
        success: res.statusCode < 400,
        requestBytes: optionalByteLength(req.header("content-length")),
        responseBytes: optionalByteLength(res.getHeader("content-length") as string | number | string[] | undefined),
        authMs,
        serverCreateMs,
        transportConnectMs,
        transportHandleMs,
        cleanupMs,
        totalMs,
      };
      requestMetrics.record(metric);
      if (config.logging.requests) {
        logEvent(config.logging, metric.success ? "info" : "warn", "mcp_request_metrics", metric);
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    close: () => {
      closePromise ??= (async () => {
        await transports?.closeAll("server_shutdown");
        checkSessions.shutdown();
        processSessions.shutdown();
        codeIntelligence.dispose();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

function logMcpSessionEvent(config: ServerConfig, event: McpSessionRegistryEvent): void {
  logEvent(config.logging, "info", event.action === "created" ? "mcp_session_created" : "mcp_session_closed", {
    sessionIdPrefix: sessionIdPrefix(event.sessionId),
    reason: event.reason,
    activeSessions: event.activeSessions,
    ageMs: event.ageMs,
    idleMs: event.idleMs,
  });
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `localspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`mcp transport: ${config.mcpTransportMode}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("localspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
