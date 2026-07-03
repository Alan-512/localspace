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

export const DEFAULT_GIT_TOOL_MAX_OUTPUT_CHARS = 20_000;
export const MAX_GIT_TOOL_MAX_OUTPUT_CHARS = 100_000;

interface GitResult {
  stdout: string;
  stderr: string;
}

export async function gitStatus(cwd: string, options: GitToolOptions = {}): Promise<string> {
  if (!(await isGitRepository(cwd))) return "Not a git repository.";

  const branch = await runGit(cwd, ["branch", "--show-current"]);
  const status = await runGit(cwd, ["status", "--short", "--branch"]);
  const output = status.stdout.trimEnd();
  const fallbackBranch = branch.stdout.trim() ? `## ${branch.stdout.trim()}` : "## HEAD (detached)";
  const lines = output ? output.split(/\r?\n/) : [fallbackBranch];
  if (lines.length === 1 && lines[0]?.startsWith("## ")) {
    lines.push("Working tree clean.");
  }
  return limitOutput(lines.join("\n"), options.maxOutputChars);
}

export async function gitDiff(cwd: string, options: GitDiffOptions = {}): Promise<string> {
  if (!(await isGitRepository(cwd))) return "Not a git repository.";

  const args = ["diff", ...(options.staged ? ["--cached"] : []), ...(options.stat ? ["--stat"] : [])];
  const diff = await runGit(cwd, args);
  const output = diff.stdout.trimEnd();
  const empty = options.stat
    ? options.staged ? "No staged tracked file changes." : "No unstaged tracked file changes."
    : options.staged ? "No staged patch." : "No unstaged patch.";
  return limitOutput(output || empty, options.maxOutputChars);
}

export async function gitAdd(cwd: string, paths: string[], options: GitToolOptions = {}): Promise<string> {
  if (!(await isGitRepository(cwd))) return "Not a git repository.";
  if (paths.length === 0) return "No paths provided.";

  const result = await runGit(cwd, ["add", "--", ...paths]);
  const commandOutput = formatCommandOutput(result);
  const output = [commandOutput, `Staged ${paths.length} path(s).`].filter(Boolean).join("\n");
  return limitOutput(output, options.maxOutputChars);
}

export async function gitCommit(cwd: string, options: GitCommitOptions): Promise<string> {
  if (!(await isGitRepository(cwd))) return "Not a git repository.";
  const message = options.message.trim();
  if (!message) return "Commit message is required.";

  const result = await runGit(cwd, ["commit", "-m", message]);
  const output = formatCommandOutput(result) || "Committed staged changes.";
  return limitOutput(output, options.maxOutputChars);
}

export async function gitLog(cwd: string, options: GitLogOptions = {}): Promise<string> {
  if (!(await isGitRepository(cwd))) return "Not a git repository.";
  const limit = clampInteger(options.limit, 10, 1, 100);
  const result = await runGit(cwd, ["log", "--oneline", "--decorate", `-${limit}`]);
  const output = result.stdout.trimEnd() || "No commits.";
  return limitOutput(output, options.maxOutputChars);
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
  const limit = clampInteger(
    maxOutputChars,
    DEFAULT_GIT_TOOL_MAX_OUTPUT_CHARS,
    1,
    MAX_GIT_TOOL_MAX_OUTPUT_CHARS,
  );
  if (output.length <= limit) return output;
  return `${output.slice(0, limit)}\n... (truncated after ${limit} characters)`;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
