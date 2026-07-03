import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { gitAdd, gitCommit, gitDiff, gitLog, gitStatus } from "./git-tools.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "localspace-git-tools-test-"));

try {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "localspace@example.com"]);
  await git(root, ["config", "user.name", "LocalSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const cleanStatus = await gitStatus(root);
  assert.match(cleanStatus, /^## /);
  assert.match(cleanStatus, /Working tree clean\./);

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  const status = await gitStatus(root);
  assert.match(status, /M README\.md/);

  const diff = await gitDiff(root);
  assert.match(diff, /diff --git/);
  assert.match(diff, /\+world/);

  const stat = await gitDiff(root, { stat: true });
  assert.match(stat, /files? changed/);

  await writeFile(join(root, "new.txt"), "new\n");
  assert.match(await gitAdd(root, ["README.md", "new.txt"]), /Staged 2 path/);

  const stagedDiff = await gitDiff(root, { staged: true });
  assert.match(stagedDiff, /\+world/);
  assert.match(stagedDiff, /new\.txt/);

  const commit = await gitCommit(root, { message: "Update readme" });
  assert.match(commit, /Update readme/);

  const log = await gitLog(root, { limit: 2 });
  assert.match(log, /Update readme/);
  assert.match(log, /Initial commit/);

  const truncated = await gitLog(root, { limit: 2, maxOutputChars: 20 });
  assert.match(truncated, /truncated after 20 characters/);

  const nonGitRoot = await mkdtemp(join(tmpdir(), "localspace-non-git-tools-test-"));
  try {
    await mkdir(join(nonGitRoot, "sub"));
    assert.equal(await gitStatus(nonGitRoot), "Not a git repository.");
  } finally {
    await rm(nonGitRoot, { recursive: true, force: true });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
