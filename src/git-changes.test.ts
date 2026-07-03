import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { getGitChanges } from "./git-changes.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "localspace-git-changes-test-"));

try {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "localspace@example.com"]);
  await git(root, ["config", "user.name", "LocalSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const clean = await getGitChanges(root);
  assert.equal(clean, "Working tree clean.");

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  const modified = await getGitChanges(root);
  assert.match(modified, /Branch:/);
  assert.match(modified, /Modified:/);
  assert.match(modified, /README\.md/);

  await writeFile(join(root, "new.txt"), "new\n");
  const untracked = await getGitChanges(root);
  assert.match(untracked, /Untracked:/);
  assert.match(untracked, /new\.txt/);

  const stat = await getGitChanges(root, { mode: "stat" });
  assert.match(stat, /files? changed/);

  const patch = await getGitChanges(root, { mode: "patch" });
  assert.match(patch, /diff --git/);
  assert.match(patch, /\+world/);

  await git(root, ["add", "README.md"]);
  const staged = await getGitChanges(root, { mode: "patch", staged: true });
  assert.match(staged, /diff --git/);
  assert.match(staged, /\+world/);

  const truncated = await getGitChanges(root, { mode: "patch", staged: true, maxOutputChars: 20 });
  assert.match(truncated, /truncated after 20 characters/);

  const nonGitRoot = await mkdtemp(join(tmpdir(), "localspace-non-git-test-"));
  try {
    await writeFile(join(nonGitRoot, "file.txt"), "hello\n");
    assert.equal(await getGitChanges(nonGitRoot), "Not a git repository.");
  } finally {
    await rm(nonGitRoot, { recursive: true, force: true });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
