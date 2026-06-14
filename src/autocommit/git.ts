import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BaselineStatus } from "./types.js";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitEligibility {
  ok: boolean;
  gitRoot?: string;
  reason?: "not_git" | "no_head";
  message?: string;
}

export interface GitOperationState {
  inProgress: boolean;
  reason?: string;
}

export interface CheckpointResult {
  ref: string;
  commit: string;
}

export interface CheckpointDiff {
  patch: string;
  stat: string;
  paths: string[];
  hash: string;
}

export async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<GitCommandResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });

  return { stdout, stderr };
}

export async function getGitEligibility(cwd: string): Promise<GitEligibility> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      ok: false,
      reason: "not_git",
      message: "workspace is not inside a git repository",
    };
  }

  const gitRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  try {
    await git(gitRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    return {
      ok: false,
      gitRoot,
      reason: "no_head",
      message: "repository has no HEAD commit",
    };
  }

  return { ok: true, gitRoot };
}

export async function getGitOperationState(gitRoot: string): Promise<GitOperationState> {
  const gitDir = absoluteGitPath(gitRoot, (await git(gitRoot, ["rev-parse", "--git-dir"])).stdout.trim());
  const commonDir = absoluteGitPath(gitRoot, (await git(gitRoot, ["rev-parse", "--git-common-dir"])).stdout.trim());
  const paths = [
    [gitDir, "MERGE_HEAD"],
    [gitDir, "CHERRY_PICK_HEAD"],
    [gitDir, "BISECT_LOG"],
    [gitDir, "rebase-merge"],
    [gitDir, "rebase-apply"],
    [commonDir, "index.lock"],
  ];

  for (const [base, path] of paths) {
    try {
      await access(join(base, path));
      return { inProgress: true, reason: path };
    } catch {
      // Continue checking the next marker.
    }
  }

  return { inProgress: false };
}

export function safeWorkspaceRefSegment(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.length > 0 ? safe : createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}

export function baselineRef(prefix: string, workspaceId: string): string {
  return `${trimRefPrefix(prefix)}/${safeWorkspaceRefSegment(workspaceId)}/baseline`;
}

export function candidateRef(prefix: string, workspaceId: string): string {
  return `${trimRefPrefix(prefix)}/${safeWorkspaceRefSegment(workspaceId)}/candidate/${Date.now()}-${randomUUID()}`;
}

function trimRefPrefix(prefix: string): string {
  return prefix.replace(/\/+$/, "");
}

function absoluteGitPath(gitRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(gitRoot, path);
}

export async function captureCheckpoint(gitRoot: string, ref: string): Promise<CheckpointResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-autocommit-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);

  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    await git(gitRoot, ["add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    const commit = (
      await git(
        gitRoot,
        ["commit-tree", tree, "-m", `devspace autocommit checkpoint ref=${ref}`],
        { env },
      )
    ).stdout.trim();
    await git(gitRoot, ["update-ref", ref, commit]);
    return { ref, commit };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function checkpointEnv(indexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "DevSpace",
    GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
    GIT_COMMITTER_NAME: "DevSpace",
    GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
  };
}

export async function diffCheckpoints(
  gitRoot: string,
  baseline: string,
  candidate: string,
  maxBuffer = 10 * 1024 * 1024,
): Promise<CheckpointDiff> {
  const commonArgs = ["--no-color", "--no-ext-diff", "--no-textconv", `${baseline}^{commit}`, `${candidate}^{commit}`];
  const patch = (await git(gitRoot, ["diff", "--patch", ...commonArgs], { maxBuffer })).stdout;
  const stat = (await git(gitRoot, ["diff", "--stat", ...commonArgs], { maxBuffer })).stdout;
  const nameOnly = (await git(gitRoot, ["diff", "--name-only", ...commonArgs], { maxBuffer })).stdout;
  const paths = nameOnly.split("\n").map((path) => path.trim()).filter(Boolean);
  return {
    patch,
    stat,
    paths,
    hash: createHash("sha256").update(patch).digest("hex"),
  };
}

export async function statusPorcelain(gitRoot: string): Promise<string> {
  return (await git(gitRoot, ["status", "--porcelain=v1"])).stdout;
}

export async function statusPorcelainZ(gitRoot: string): Promise<string> {
  return (await git(gitRoot, ["status", "--porcelain=v1", "-z"], { maxBuffer: 10 * 1024 * 1024 })).stdout;
}

export function parseStatusPorcelainZ(status: string): BaselineStatus {
  const stagedPaths = new Set<string>();
  const unstagedPaths = new Set<string>();
  const untrackedPaths = new Set<string>();
  const dirtyPaths = new Set<string>();
  const entries = status.split("\0").filter(Boolean);

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;

    if (code === "??") {
      untrackedPaths.add(path);
      dirtyPaths.add(path);
      continue;
    }

    if (code[0] !== " " && code[0] !== "?") stagedPaths.add(path);
    if (code[1] !== " " && code[1] !== "?") unstagedPaths.add(path);
    if (code[0] !== " " || code[1] !== " ") dirtyPaths.add(path);

    if (code[0] === "R" || code[0] === "C") {
      index++;
    }
  }

  return { stagedPaths, unstagedPaths, untrackedPaths, dirtyPaths };
}

export async function hasStagedChanges(gitRoot: string): Promise<boolean> {
  const status = parseStatusPorcelainZ(await statusPorcelainZ(gitRoot));
  return status.stagedPaths.size > 0;
}

export async function stagePaths(gitRoot: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await git(gitRoot, ["add", "--", ...paths]);
}

export async function createCommit(gitRoot: string, subject: string, body: string): Promise<string> {
  const args = body.trim().length > 0 ? ["commit", "-m", subject, "-m", body] : ["commit", "-m", subject];
  await git(gitRoot, args, { maxBuffer: 10 * 1024 * 1024 });
  return (await git(gitRoot, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function deleteRef(gitRoot: string, ref: string): Promise<void> {
  try {
    await git(gitRoot, ["update-ref", "-d", ref]);
  } catch {
    // Best-effort cleanup only.
  }
}
