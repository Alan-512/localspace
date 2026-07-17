import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ServerConfig } from "./config.js";
import { resolveShellCommand } from "./process-platform.js";
import type { Workspace } from "./workspaces.js";

const execFileAsync = promisify(execFile);

export interface DoctorOptions {
  workspace?: Workspace;
}

export interface CommandCheck {
  name: string;
  status: "ok" | "warn" | "error";
  detail: string;
}

interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  packageManager?: string;
}

export interface DoctorReportData {
  configuration: {
    toolMode: ServerConfig["toolMode"];
    widgets: ServerConfig["widgets"];
    mcpTransportMode: ServerConfig["mcpTransportMode"];
    host: string;
    port: number;
    publicBaseUrl: string;
    allowedRoots: string[];
    stateDir: string;
    worktreeRoot: string;
    agentDir: string;
    skillsEnabled: boolean;
    configuredShell?: string;
    mcpSessions: ServerConfig["mcpSessions"];
  };
  runtime: {
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    cwd: string;
  };
  workspace?: WorkspaceData;
  checks: CommandCheck[];
  overall: "ok" | "warning" | "error";
  text: string;
}

export interface WorkspaceData {
  id: string;
  root: string;
  mode: Workspace["mode"];
  exists?: boolean;
  sourceRoot?: string;
  worktree?: Workspace["worktree"];
}

export interface GitWorkspaceData {
  isRepository: boolean;
  branch: string;
  head: string;
  clean: boolean;
  statusLines: string[];
  recentCommits: string[];
  error?: string;
}

export interface PackageJsonData {
  name?: string;
  version?: string;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  packageManager?: string;
}

export interface WorkspaceInfoData {
  workspace: WorkspaceData;
  git: GitWorkspaceData;
  package?: PackageJsonData;
  text: string;
}

export async function generateDoctorReport(
  config: ServerConfig,
  options: DoctorOptions = {},
): Promise<string> {
  return (await generateDoctorReportData(config, options)).text;
}

export async function generateDoctorReportData(
  config: ServerConfig,
  options: DoctorOptions = {},
): Promise<DoctorReportData> {
  const checks = await runDoctorChecks(config, options.workspace?.root);
  const hasError = checks.some((check) => check.status === "error");
  const hasWarn = checks.some((check) => check.status === "warn");
  const data: DoctorReportData = {
    configuration: {
      toolMode: config.toolMode,
      widgets: config.widgets,
      mcpTransportMode: config.mcpTransportMode,
      host: config.host,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      allowedRoots: config.allowedRoots,
      stateDir: config.stateDir,
      worktreeRoot: config.worktreeRoot,
      agentDir: config.agentDir,
      skillsEnabled: config.skillsEnabled,
      configuredShell: config.shell,
      mcpSessions: config.mcpSessions,
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cwd: process.cwd(),
    },
    workspace: options.workspace ? workspaceData(options.workspace) : undefined,
    checks,
    overall: hasError ? "error" : hasWarn ? "warning" : "ok",
    text: "",
  };
  data.text = formatDoctorReport(data);
  return data;
}

function formatDoctorReport(data: DoctorReportData): string {
  const lines = ["LocalSpace doctor", ""];

  lines.push("Configuration:");
  lines.push(`- tool mode: ${data.configuration.toolMode}`);
  lines.push(`- widgets: ${data.configuration.widgets}`);
  lines.push(`- MCP transport mode: ${data.configuration.mcpTransportMode}`);
  lines.push(`- host: ${data.configuration.host}`);
  lines.push(`- port: ${data.configuration.port}`);
  lines.push(`- public base URL: ${data.configuration.publicBaseUrl}`);
  lines.push(`- allowed roots: ${data.configuration.allowedRoots.length}`);
  for (const root of data.configuration.allowedRoots) lines.push(`  - ${root}`);
  lines.push(`- state dir: ${data.configuration.stateDir}`);
  lines.push(`- worktree root: ${data.configuration.worktreeRoot}`);
  lines.push(`- agent dir: ${data.configuration.agentDir}`);
  lines.push(`- skills: ${data.configuration.skillsEnabled ? "enabled" : "disabled"}`);
  lines.push(`- configured shell: ${data.configuration.configuredShell ?? "default"}`);
  lines.push(`- MCP session idle TTL: ${data.configuration.mcpSessions.idleTtlMs} ms`);
  lines.push(`- MCP session cleanup interval: ${data.configuration.mcpSessions.cleanupIntervalMs} ms`);
  lines.push(`- MCP max sessions: ${data.configuration.mcpSessions.maxSessions}`);
  lines.push("");

  lines.push("Runtime:");
  lines.push(`- platform: ${data.runtime.platform}`);
  lines.push(`- arch: ${data.runtime.arch}`);
  lines.push(`- node: ${data.runtime.node}`);
  lines.push(`- cwd: ${data.runtime.cwd}`);
  lines.push("");

  if (data.workspace) {
    lines.push("Workspace:");
    lines.push(`- id: ${data.workspace.id}`);
    lines.push(`- root: ${data.workspace.root}`);
    lines.push(`- mode: ${data.workspace.mode}`);
    if (data.workspace.sourceRoot) lines.push(`- source root: ${data.workspace.sourceRoot}`);
    if (data.workspace.worktree) {
      lines.push(`- worktree base ref: ${data.workspace.worktree.baseRef}`);
      lines.push(`- worktree base sha: ${data.workspace.worktree.baseSha}`);
      lines.push(`- worktree managed: ${data.workspace.worktree.managed}`);
    }
    lines.push("");
  }

  lines.push("Checks:");
  for (const check of data.checks) lines.push(`- ${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
  lines.push("");
  lines.push(`Overall: ${data.overall}`);

  return lines.join("\n");
}

export async function generateWorkspaceInfo(workspace: Workspace): Promise<string> {
  return (await generateWorkspaceInfoData(workspace)).text;
}

export async function generateWorkspaceInfoData(workspace: Workspace): Promise<WorkspaceInfoData> {
  const [git, packageJson, rootStat] = await Promise.all([
    gitWorkspaceInfo(workspace.root),
    readPackageJson(workspace.root),
    safeStat(workspace.root),
  ]);
  const data: WorkspaceInfoData = {
    workspace: { ...workspaceData(workspace), exists: rootStat?.isDirectory() ?? false },
    git,
    package: packageJson ? packageJsonData(packageJson) : undefined,
    text: "",
  };
  data.text = formatWorkspaceInfo(data);
  return data;
}

function formatWorkspaceInfo(data: WorkspaceInfoData): string {
  const { workspace, git, package: packageJson } = data;

  const lines = ["Workspace info", ""];
  lines.push(`- id: ${workspace.id}`);
  lines.push(`- root: ${workspace.root}`);
  lines.push(`- mode: ${workspace.mode}`);
  lines.push(`- exists: ${workspace.exists ? "yes" : "no"}`);
  if (workspace.sourceRoot) lines.push(`- source root: ${workspace.sourceRoot}`);
  if (workspace.worktree) {
    lines.push(`- worktree base ref: ${workspace.worktree.baseRef}`);
    lines.push(`- worktree base sha: ${workspace.worktree.baseSha}`);
    lines.push(`- worktree dirty source: ${workspace.worktree.dirtySource}`);
    lines.push(`- worktree detached: ${workspace.worktree.detached}`);
    lines.push(`- worktree managed: ${workspace.worktree.managed}`);
  }
  lines.push("");

  lines.push("Git:");
  lines.push(`- repository: ${git.isRepository ? "yes" : "no"}`);
  if (git.isRepository) {
    lines.push(`- branch: ${git.branch || "HEAD (detached)"}`);
    lines.push(`- head: ${git.head || "unknown"}`);
    lines.push(`- status: ${git.clean ? "clean" : "dirty"}`);
    if (git.statusLines.length > 0) {
      lines.push("- changes:");
      for (const line of git.statusLines.slice(0, 20)) lines.push(`  - ${line}`);
      if (git.statusLines.length > 20) lines.push(`  - ... (${git.statusLines.length - 20} more)`);
    }
    if (git.recentCommits.length > 0) {
      lines.push("- recent commits:");
      for (const commit of git.recentCommits) lines.push(`  - ${commit}`);
    }
  } else if (git.error) {
    lines.push(`- detail: ${git.error}`);
  }
  lines.push("");

  lines.push("Package:");
  if (!packageJson) {
    lines.push("- package.json: not found");
  } else {
    lines.push(`- name: ${packageJson.name ?? "unknown"}`);
    if (packageJson.version) lines.push(`- version: ${packageJson.version}`);
    if (packageJson.packageManager) lines.push(`- package manager: ${packageJson.packageManager}`);
    if (packageJson.engines && Object.keys(packageJson.engines).length > 0) {
      lines.push("- engines:");
      for (const [name, range] of Object.entries(packageJson.engines)) lines.push(`  - ${name}: ${range}`);
    }
    const scripts = Object.keys(packageJson.scripts ?? {}).sort();
    if (scripts.length > 0) {
      lines.push("- scripts:");
      for (const script of scripts) lines.push(`  - ${script}: ${packageJson.scripts?.[script]}`);
    } else {
      lines.push("- scripts: none");
    }
  }

  return lines.join("\n");
}

function workspaceData(workspace: Workspace): WorkspaceData {
  return {
    id: workspace.id,
    root: workspace.root,
    mode: workspace.mode,
    sourceRoot: workspace.sourceRoot,
    worktree: workspace.worktree,
  };
}

function packageJsonData(packageJson: PackageJson): PackageJsonData {
  return {
    name: packageJson.name,
    version: packageJson.version,
    scripts: packageJson.scripts ?? {},
    engines: packageJson.engines ?? {},
    packageManager: packageJson.packageManager,
  };
}

async function runDoctorChecks(config: ServerConfig, workspaceRoot: string | undefined): Promise<CommandCheck[]> {
  const cwd = workspaceRoot ?? process.cwd();
  const checks: CommandCheck[] = [];
  checks.push(await checkCommand("node", ["--version"], cwd));
  checks.push(await checkCommand("npm", ["--version"], cwd));
  checks.push(await checkCommand("git", ["--version"], cwd));
  checks.push(await checkShell(config, cwd));
  checks.push(checkDirectory("state dir", config.stateDir));
  checks.push(checkDirectory("worktree root", config.worktreeRoot));
  return checks;
}

async function checkCommand(name: string, args: string[], cwd: string): Promise<CommandCheck> {
  try {
    const result = await execFileAsync(name, args, { cwd, timeout: 5_000 });
    const detail = (result.stdout || result.stderr).trim() || "available";
    return { name, status: "ok", detail };
  } catch (error) {
    if (process.platform === "win32") {
      return checkCommandWithWindowsShellFallback(name, args, cwd, error);
    }
    return { name, status: "error", detail: errorMessage(error) };
  }
}

async function checkCommandWithWindowsShellFallback(
  name: string,
  args: string[],
  cwd: string,
  directError: unknown,
): Promise<CommandCheck> {
  const shell = resolveShellCommand(shellCommand([name, ...args]), "win32", process.env);

  try {
    const result = await execFileAsync(shell.executable, shell.args, { cwd, timeout: 5_000 });
    const detail = (result.stdout || result.stderr).trim() || "available";
    return { name, status: "ok", detail };
  } catch (shellError) {
    return {
      name,
      status: "error",
      detail: `${errorMessage(directError)}; shell fallback failed: ${errorMessage(shellError)}`,
    };
  }
}

function shellCommand(parts: string[]): string {
  return parts.map(quoteShellArg).join(" ");
}

function quoteShellArg(part: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(part)) return part;
  return `"${part.replace(/(["^%])/g, "^$1")}"`;
}

async function checkShell(config: ServerConfig, cwd: string): Promise<CommandCheck> {
  const environment = config.shell ? { ...process.env, LOCALSPACE_SHELL: config.shell } : process.env;
  const shell = resolveShellCommand("echo localspace-shell-ok", process.platform, environment);
  try {
    const result = await execFileAsync(shell.executable, shell.args, { cwd, timeout: 5_000 });
    const output = (result.stdout || result.stderr).trim();
    const executable = basename(shell.executable);
    return {
      name: "shell",
      status: output.includes("localspace-shell-ok") ? "ok" : "warn",
      detail: `${executable}: ${output || "no output"}`,
    };
  } catch (error) {
    return { name: "shell", status: "error", detail: errorMessage(error) };
  }
}

function checkDirectory(name: string, path: string): CommandCheck {
  return {
    name,
    status: existsSync(path) ? "ok" : "warn",
    detail: existsSync(path) ? path : `${path} does not exist yet`,
  };
}

async function gitWorkspaceInfo(root: string): Promise<{
  isRepository: boolean;
  branch: string;
  head: string;
  clean: boolean;
  statusLines: string[];
  recentCommits: string[];
  error?: string;
}> {
  try {
    const inside = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    if (inside.stdout.trim() !== "true") {
      return { isRepository: false, branch: "", head: "", clean: false, statusLines: [], recentCommits: [] };
    }
    const [branch, head, status, log] = await Promise.all([
      execFileAsync("git", ["branch", "--show-current"], { cwd: root }),
      execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }),
      execFileAsync("git", ["status", "--short"], { cwd: root }),
      execFileAsync("git", ["log", "--oneline", "-5"], { cwd: root }),
    ]);
    const statusLines = status.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      isRepository: true,
      branch: branch.stdout.trim(),
      head: head.stdout.trim(),
      clean: statusLines.length === 0,
      statusLines,
      recentCommits: log.stdout.trim().split(/\r?\n/).filter(Boolean),
    };
  } catch (error) {
    return {
      isRepository: false,
      branch: "",
      head: "",
      clean: false,
      statusLines: [],
      recentCommits: [],
      error: errorMessage(error),
    };
  }
}

async function readPackageJson(root: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(join(root, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
