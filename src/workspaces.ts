import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import type { WorkspaceMode, WorkspaceStore } from "./workspace-store.js";
import { mkdir, opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree } from "./git-worktrees.js";
import { assertAllowedPath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";

const execFileAsync = promisify(execFile);

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  activatedSkillDirs: Set<string>;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
}

type DirectoryOps = {
  stat: (path: string) => Promise<Stats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(input: string | OpenWorkspaceInput): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(options.path, options.baseRef);
    }

    return this.openCheckoutWorkspace(options.path);
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session) {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
      activatedSkillDirs: new Set(),
    };
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);

    return restoredWorkspace;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) throw workspaceError;

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    }
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const rootStats = await ensureCheckoutWorkspaceRoot(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    return this.createWorkspaceContext({ root, mode: "checkout" });
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      activatedSkillDirs: new Set(),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
    });
    this.workspaces.set(workspace.id, workspace);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return { workspace, agentsFiles, availableAgentsFiles };
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }

    return assertAllowedPath(root, this.config.allowedRoots);
  }

  private async loadInitialAgentsFiles(root: string): Promise<LoadedAgentsFile[]> {
    const agentDir = resolve(this.config.agentDir);
    const resolvedRoot = (await tryRealpath(root)) ?? root;
    const resolvedAgentDir = (await tryRealpath(agentDir)) ?? agentDir;
    const loadedFiles: LoadedAgentsFile[] = [];

    for (const file of loadProjectContextFiles({ cwd: root, agentDir })) {
      const path = resolve(file.path);
      if (!isInitialAgentsFilePath(path, root, agentDir)) continue;

      const content = await readResolvedContextFile(
        path,
        file.content,
        resolvedRoot,
        resolvedAgentDir,
      );
      if (content === undefined) continue;

      loadedFiles.push({ path, content });
    }

    return loadedFiles;
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const gitPaths = await findGitContextFiles(root);

    if (gitPaths) {
      return gitPaths
        .map((path) => resolve(path))
        .filter((path) => !loadedPaths.has(path))
        .map((path) => ({ path }))
        .sort((a, b) => a.path.localeCompare(b.path));
    }

    const discovered: AvailableAgentsFile[] = [];

    await walkWorkspace(root, async (path, entry) => {
      if (!entry.isFile()) return;
      if (!CONTEXT_FILE_NAMES.has(entry.name)) return;
      if (loadedPaths.has(path)) return;

      discovered.push({ path });
    });

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }
}

export async function ensureCheckoutWorkspaceRoot(
  path: string,
  ops: DirectoryOps = { stat, mkdir },
): Promise<Stats> {
  try {
    return await ops.stat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await ops.mkdir(path, { recursive: true });
  return await ops.stat(path);
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  ".localspace",
  ".worktrees",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "coverage",
  "target",
]);
const MAX_FALLBACK_CONTEXT_SCAN_ENTRIES = 50_000;
const GIT_CONTEXT_DISCOVERY_TIMEOUT_MS = 5_000;

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

function isInitialAgentsFilePath(path: string, root: string, agentDir: string): boolean {
  if (isPathInsideRoot(path, agentDir)) return true;
  return isPathInsideRoot(path, root) && dirname(path) === root;
}

async function readResolvedContextFile(
  path: string,
  fallbackContent: string,
  root: string,
  agentDir: string,
): Promise<string | undefined> {
  try {
    const resolvedPath = await realpath(path);
    if (!isInitialAgentsFilePath(resolvedPath, root, agentDir)) return undefined;
    return await readFile(resolvedPath, "utf8");
  } catch {
    return fallbackContent;
  }
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
  state: { entries: number; truncated: boolean } = { entries: 0, truncated: false },
): Promise<void> {
  if (state.truncated) return;

  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    state.entries += 1;
    if (state.entries > MAX_FALLBACK_CONTEXT_SCAN_ENTRIES) {
      state.truncated = true;
      return;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        await walkWorkspace(path, visit, state);
      }
      continue;
    }

    await visit(path, entry);
  }
}

async function findGitContextFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout: topLevelOutput } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        timeout: GIT_CONTEXT_DISCOVERY_TIMEOUT_MS,
      },
    );
    const gitRoot = resolve(String(topLevelOutput).trim());
    const workspacePrefix = relative(gitRoot, root).split(sep).join("/");

    if (
      workspacePrefix === ".." ||
      workspacePrefix.startsWith("../") ||
      workspacePrefix.includes("/../")
    ) {
      return undefined;
    }

    const prefix = workspacePrefix ? `${workspacePrefix}/` : "";
    const pathspecs = [...CONTEXT_FILE_NAMES].flatMap((name) => [
      `${prefix}${name}`,
      `:(glob)${prefix}**/${name}`,
    ]);
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        gitRoot,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--full-name",
        "--",
        ...pathspecs,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: GIT_CONTEXT_DISCOVERY_TIMEOUT_MS,
      },
    );

    const paths = new Set<string>();
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!line) continue;
      const absolutePath = resolve(gitRoot, line);
      if (!isPathInsideRoot(absolutePath, root)) continue;
      if (!CONTEXT_FILE_NAMES.has(basename(absolutePath))) continue;
      paths.add(absolutePath);
    }

    return [...paths];
  } catch {
    return undefined;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
