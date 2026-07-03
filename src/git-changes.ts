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

interface StatusEntry {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
}

export async function getGitChanges(
  workspaceRoot: string,
  options: GitChangesOptions = {},
): Promise<string> {
  const mode = options.mode ?? "summary";
  const staged = options.staged ?? false;
  const maxOutputChars = clampInteger(
    options.maxOutputChars,
    DEFAULT_CHANGES_MAX_OUTPUT_CHARS,
    1,
    MAX_CHANGES_MAX_OUTPUT_CHARS,
  );

  if (!(await isGitRepository(workspaceRoot))) {
    return "Not a git repository.";
  }

  const status = await git(workspaceRoot, ["status", "--porcelain=v1"]);
  if (status.stdout.trim() === "") {
    return "Working tree clean.";
  }

  const result = await formatChanges(workspaceRoot, mode, staged, status.stdout);
  return truncateOutput(result, maxOutputChars);
}

async function formatChanges(
  workspaceRoot: string,
  mode: ChangesMode,
  staged: boolean,
  statusOutput: string,
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

  const branch = await currentBranch(workspaceRoot);
  const entries = parseStatus(statusOutput).filter((entry) => includeStatusEntry(entry, staged));
  const stat = await git(workspaceRoot, ["diff", ...(staged ? ["--cached"] : []), "--stat"]);
  const lines = [`Branch: ${branch}`, ""];
  const grouped = groupStatusEntries(entries, staged);

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

  const statOutput = stat.stdout.trimEnd();
  if (statOutput) {
    lines.push("Stat:");
    lines.push(statOutput);
  }

  return lines.join("\n").trimEnd();
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

function groupStatusEntries(entries: StatusEntry[], staged: boolean): Array<{ title: string; paths: string[] }> {
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
  if (output.length <= maxOutputChars) return output;
  return `${output.slice(0, maxOutputChars)}\n... (truncated after ${maxOutputChars} characters)`;
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
