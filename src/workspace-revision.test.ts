import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { workspaceContentRevision, workspaceRevision } from "./workspace-revision.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "localspace-workspace-revision-test-"));

try {
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "LocalSpace Test"]);
  await git(root, ["config", "user.email", "localspace@example.invalid"]);
  await writeFile(join(root, "tracked.txt"), "baseline\n", "utf8");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "-m", "baseline"]);

  const clean = await workspaceRevision(root);
  const cleanContent = await workspaceContentRevision(root);
  assert.equal(typeof clean, "string");
  assert.equal(typeof cleanContent, "string");

  await writeFile(join(root, "tracked.txt"), "dirty-one\n", "utf8");
  const dirtyOne = await workspaceRevision(root);
  assert.notEqual(dirtyOne, clean);

  await writeFile(join(root, "tracked.txt"), "dirty-two\n", "utf8");
  const dirtyTwo = await workspaceRevision(root);
  const dirtyContent = await workspaceContentRevision(root);
  assert.notEqual(dirtyTwo, dirtyOne, "content changes must be detected even when Git status remains M");
  assert.notEqual(dirtyContent, cleanContent);

  await writeFile(join(root, "untracked.txt"), "same-size-a\n", "utf8");
  const untrackedA = await workspaceRevision(root);
  await writeFile(join(root, "untracked.txt"), "same-size-b\n", "utf8");
  const untrackedB = await workspaceRevision(root);
  const untrackedContent = await workspaceContentRevision(root);
  assert.notEqual(untrackedB, untrackedA, "untracked content changes must be detected");

  await git(root, ["add", "tracked.txt"]);
  const staged = await workspaceRevision(root);
  const stagedContent = await workspaceContentRevision(root);
  assert.notEqual(staged, untrackedB, "index changes must be detected");
  assert.equal(stagedContent, untrackedContent, "content revision must remain stable after staging");
  assert.notEqual(stagedContent, dirtyContent, "untracked content is part of the content revision");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
