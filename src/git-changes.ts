import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ChangesMode = "summary" | "stat" | "patch";

export interface GitChangesOptions {
  mode?: ChangesMode;
  staged?: boolean;
  maxOutputChars?: number;
}

export const DEFAULT_CHANGES_MAX_OUTPUT_CHARS = 20_000;
export const MAX_CHANGES_MAX_OUTPUT_CHARS = 100_000;

interface GitResult {
  stdout: string;
  stderr: string;
}

export interface StatusEntry {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
}

export interface ChangesGroup {
  title: string;
  paths: string[];
}

export interface GitChangesData {
  isRepository: boolean;
  clean: boolean;
  mode: ChangesMode;
  staged: boolean;
  branch?: string;
  statusEntries: StatusEntry[];
  groups: ChangesGroup[];
  stat?: string;
  truncated: boolean;
  text: string;
}

export async function getGitChanges(
  workspaceRoot: string,
  options: GitChangesOptions = {},
): Promise<string> {
  return (await getGitChangesData(workspaceRoot, options)).text;
}

export async function getGitChangesData(
  workspaceRoot: string,
  options: GitChangesOptions = {},
): Promise<GitChangesData> {
  const mode = options.mode ?? "summary";
  const staged = options.staged ?? false;
  const maxOutputChars = clampInteger(
    options.maxOutputChars,
    DEFAULT_CHANGES_MAX_OUTPUT_CHARS,
    1,
    MAX_CHANGES_MAX_OUTPUT_CHARS,
  );

  if (!(await isGitRepository(workspaceRoot))) {
    return {
      isRepository: false,
      clean: false,
      mode,
      staged,
      statusEntries: [],
      groups: [],
      truncated: false,
      text: "Not a git repository.",
    };
  }

  const status = await git(workspaceRoot, ["status", "--porcelain=v1"]);
  if (status.stdout.trim() === "") {
    return {
      isRepository: true,
      clean: true,
      mode,
      staged,
      branch: await currentBranch(workspaceRoot),
      statusEntries: [],
      groups: [],
      truncated: false,
      text: "Working tree clean.",
    };
  }

  const statusEntries = parseStatus(status.stdout);
  const included = statusEntries.filter((entry) => includeStatusEntry(entry, staged));
  const groups = groupStatusEntries(included, staged);
  const branch = await currentBranch(workspaceRoot);
  const stat = await diffStat(workspaceRoot, staged);
  const result = await formatChanges(workspaceRoot, mode, staged, branch, groups, stat);
  const truncated = truncateOutputData(result, maxOutputChars);
  return {
    isRepository: true,
    clean: false,
    mode,
    staged,
    branch,
    statusEntries,
    groups,
    stat: stat || undefined,
    truncated: truncated.truncated,
    text: truncated.text,
  };
}

async function formatChanges(
  workspaceRoot: string,
  mode: ChangesMode,
  staged: boolean,
  branch: string,
  grouped: ChangesGroup[],
  statOutput: string,
): Promise<string> {
  if (mode === "patch") {
    const diff = await git(workspaceRoot, ["diff", ...(staged ? ["--cached"] : [])]);
    const output = diff.stdout.trimEnd();
    return output || (staged ? "No staged patch." : "No unstaged patch.");
  }

  if (mode === "stat") {
    const diff = await git(workspaceRoot, ["diff", ...(staged ? ["--cached"] : []), "--stat"]);
    const output = diff.stdout.trimEnd();
    return output || (staged ? "No staged tracked file changes." : "No unstaged tracked file changes.");
  }

  const lines = [`Branch: ${branch}`, ""];

  if (grouped.length === 0) {
    lines.push(staged ? "No staged changes." : "No unstaged changes.");
  } else {
    for (const group of grouped) {
      lines.push(`${group.title}:`);
      for (const path of group.paths) {
        lines.push(`- ${path}`);
      }
      lines.push("");
    }
  }

  if (statOutput) {
    lines.push("Stat:");
    lines.push(statOutput);
  }

  return lines.join("\n").trimEnd();
}

async function diffStat(workspaceRoot: string, staged: boolean): Promise<string> {
  const stat = await git(workspaceRoot, ["diff", ...(staged ? ["--cached"] : []), "--stat"]);
  return stat.stdout.trimEnd();
}

async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function currentBranch(cwd: string): Promise<string> {
  const branch = await git(cwd, ["branch", "--show-current"]);
  const name = branch.stdout.trim();
  if (name) return name;

  const commit = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  return `HEAD (detached at ${commit.stdout.trim()})`;
}

function parseStatus(output: string): StatusEntry[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({
      indexStatus: line[0] ?? " ",
      worktreeStatus: line[1] ?? " ",
      path: line.slice(3),
    }));
}

function includeStatusEntry(entry: StatusEntry, staged: boolean): boolean {
  if (staged) return entry.indexStatus !== " " && entry.indexStatus !== "?";
  return entry.worktreeStatus !== " " || entry.indexStatus === "?";
}

function groupStatusEntries(entries: StatusEntry[], staged: boolean): ChangesGroup[] {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const status = staged ? entry.indexStatus : entry.indexStatus === "?" ? "?" : entry.worktreeStatus;
    const title = statusTitle(status);
    const paths = groups.get(title) ?? [];
    paths.push(entry.path);
    groups.set(title, paths);
  }

  const order = ["Added", "Modified", "Deleted", "Renamed", "Copied", "Unmerged", "Untracked", "Other"];
  return order
    .filter((title) => groups.has(title))
    .map((title) => ({ title, paths: groups.get(title) ?? [] }));
}

function statusTitle(status: string): string {
  switch (status) {
    case "A":
      return "Added";
    case "M":
      return "Modified";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case "U":
      return "Unmerged";
    case "?":
      return "Untracked";
    default:
      return "Other";
  }
}

function truncateOutput(output: string, maxOutputChars: number): string {
  return truncateOutputData(output, maxOutputChars).text;
}

function truncateOutputData(output: string, maxOutputChars: number): { text: string; truncated: boolean } {
  if (output.length <= maxOutputChars) return { text: output, truncated: false };
  return { text: `${output.slice(0, maxOutputChars)}\n... (truncated after ${maxOutputChars} characters)`, truncated: true };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  return execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
}
