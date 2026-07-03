import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitToolOptions {
  maxOutputChars?: number;
}

export interface GitDiffOptions extends GitToolOptions {
  staged?: boolean;
  stat?: boolean;
}

export interface GitLogOptions extends GitToolOptions {
  limit?: number;
}

export interface GitCommitOptions extends GitToolOptions {
  message: string;
}

export interface GitStatusData {
  isRepository: boolean;
  branch: string;
  clean: boolean;
  statusLines: string[];
  truncated: boolean;
  text: string;
}

export interface GitDiffData {
  isRepository: boolean;
  staged: boolean;
  stat: boolean;
  empty: boolean;
  truncated: boolean;
  text: string;
}

export interface GitAddData {
  isRepository: boolean;
  paths: string[];
  stagedCount: number;
  truncated: boolean;
  text: string;
}

export interface GitCommitData {
  isRepository: boolean;
  message: string;
  committed: boolean;
  truncated: boolean;
  text: string;
}

export interface GitLogData {
  isRepository: boolean;
  limit: number;
  commits: string[];
  truncated: boolean;
  text: string;
}

export const DEFAULT_GIT_TOOL_MAX_OUTPUT_CHARS = 20_000;
export const MAX_GIT_TOOL_MAX_OUTPUT_CHARS = 100_000;

interface GitResult {
  stdout: string;
  stderr: string;
}

export async function gitStatus(cwd: string, options: GitToolOptions = {}): Promise<string> {
  return (await gitStatusData(cwd, options)).text;
}

export async function gitStatusData(cwd: string, options: GitToolOptions = {}): Promise<GitStatusData> {
  if (!(await isGitRepository(cwd))) return { isRepository: false, branch: "", clean: false, statusLines: [], truncated: false, text: "Not a git repository." };

  const branch = await runGit(cwd, ["branch", "--show-current"]);
  const status = await runGit(cwd, ["status", "--short", "--branch"]);
  const output = status.stdout.trimEnd();
  const fallbackBranch = branch.stdout.trim() ? `## ${branch.stdout.trim()}` : "## HEAD (detached)";
  const lines = output ? output.split(/\r?\n/) : [fallbackBranch];
  if (lines.length === 1 && lines[0]?.startsWith("## ")) {
    lines.push("Working tree clean.");
  }
  const limited = limitOutputData(lines.join("\n"), options.maxOutputChars);
  return {
    isRepository: true,
    branch: branch.stdout.trim(),
    clean: lines.length === 2 && lines[1] === "Working tree clean.",
    statusLines: lines,
    truncated: limited.truncated,
    text: limited.text,
  };
}

export async function gitDiff(cwd: string, options: GitDiffOptions = {}): Promise<string> {
  return (await gitDiffData(cwd, options)).text;
}

export async function gitDiffData(cwd: string, options: GitDiffOptions = {}): Promise<GitDiffData> {
  const staged = options.staged ?? false;
  const stat = options.stat ?? false;
  if (!(await isGitRepository(cwd))) return { isRepository: false, staged, stat, empty: true, truncated: false, text: "Not a git repository." };

  const args = ["diff", ...(staged ? ["--cached"] : []), ...(stat ? ["--stat"] : [])];
  const diff = await runGit(cwd, args);
  const output = diff.stdout.trimEnd();
  const empty = stat
    ? staged ? "No staged tracked file changes." : "No unstaged tracked file changes."
    : staged ? "No staged patch." : "No unstaged patch.";
  const limited = limitOutputData(output || empty, options.maxOutputChars);
  return { isRepository: true, staged, stat, empty: !output, truncated: limited.truncated, text: limited.text };
}

export async function gitAdd(cwd: string, paths: string[], options: GitToolOptions = {}): Promise<string> {
  return (await gitAddData(cwd, paths, options)).text;
}

export async function gitAddData(cwd: string, paths: string[], options: GitToolOptions = {}): Promise<GitAddData> {
  if (!(await isGitRepository(cwd))) return { isRepository: false, paths, stagedCount: 0, truncated: false, text: "Not a git repository." };
  if (paths.length === 0) return { isRepository: true, paths, stagedCount: 0, truncated: false, text: "No paths provided." };

  const result = await runGit(cwd, ["add", "--", ...paths]);
  const commandOutput = formatCommandOutput(result);
  const output = [commandOutput, `Staged ${paths.length} path(s).`].filter(Boolean).join("\n");
  const limited = limitOutputData(output, options.maxOutputChars);
  return { isRepository: true, paths, stagedCount: paths.length, truncated: limited.truncated, text: limited.text };
}

export async function gitCommit(cwd: string, options: GitCommitOptions): Promise<string> {
  return (await gitCommitData(cwd, options)).text;
}

export async function gitCommitData(cwd: string, options: GitCommitOptions): Promise<GitCommitData> {
  if (!(await isGitRepository(cwd))) return { isRepository: false, message: options.message, committed: false, truncated: false, text: "Not a git repository." };
  const message = options.message.trim();
  if (!message) return { isRepository: true, message, committed: false, truncated: false, text: "Commit message is required." };

  const result = await runGit(cwd, ["commit", "-m", message]);
  const output = formatCommandOutput(result) || "Committed staged changes.";
  const limited = limitOutputData(output, options.maxOutputChars);
  return { isRepository: true, message, committed: true, truncated: limited.truncated, text: limited.text };
}

export async function gitLog(cwd: string, options: GitLogOptions = {}): Promise<string> {
  return (await gitLogData(cwd, options)).text;
}

export async function gitLogData(cwd: string, options: GitLogOptions = {}): Promise<GitLogData> {
  if (!(await isGitRepository(cwd))) return { isRepository: false, limit: options.limit ?? 10, commits: [], truncated: false, text: "Not a git repository." };
  const limit = clampInteger(options.limit, 10, 1, 100);
  const result = await runGit(cwd, ["log", "--oneline", "--decorate", `-${limit}`]);
  const output = result.stdout.trimEnd() || "No commits.";
  const limited = limitOutputData(output, options.maxOutputChars);
  return {
    isRepository: true,
    limit,
    commits: output === "No commits." ? [] : output.split(/\r?\n/).filter(Boolean),
    truncated: limited.truncated,
    text: limited.text,
  };
}

async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    return await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const output = [execError.stdout, execError.stderr, execError.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(output || "Git command failed.");
  }
}

function formatCommandOutput(result: GitResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function limitOutput(output: string, maxOutputChars: number | undefined): string {
  return limitOutputData(output, maxOutputChars).text;
}

function limitOutputData(output: string, maxOutputChars: number | undefined): { text: string; truncated: boolean } {
  const limit = clampInteger(
    maxOutputChars,
    DEFAULT_GIT_TOOL_MAX_OUTPUT_CHARS,
    1,
    MAX_GIT_TOOL_MAX_OUTPUT_CHARS,
  );
  if (output.length <= limit) return { text: output, truncated: false };
  return { text: `${output.slice(0, limit)}\n... (truncated after ${limit} characters)`, truncated: true };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
