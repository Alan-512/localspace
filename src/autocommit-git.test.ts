import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import {
  baselineRef,
  captureCheckpoint,
  diffCheckpoints,
  getGitEligibility,
  parseStatusPorcelainZ,
  statusPorcelainZ,
} from "./autocommit/git.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-autocommit-git-test-"));

try {
  assert.equal((await getGitEligibility(root)).ok, false);

  await git(root, ["init"]);
  const noHead = await getGitEligibility(root);
  assert.equal(noHead.ok, false);
  assert.equal(noHead.reason, "no_head");

  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const eligibility = await getGitEligibility(root);
  assert.equal(eligibility.ok, true);
  assert.equal(eligibility.gitRoot, root);

  await writeFile(join(root, "staged.txt"), "staged\n");
  await git(root, ["add", "staged.txt"]);
  await writeFile(join(root, "unstaged.txt"), "unstaged\n");
  const status = parseStatusPorcelainZ(await statusPorcelainZ(root));
  assert.equal(status.stagedPaths.has("staged.txt"), true);
  assert.equal(status.untrackedPaths.has("unstaged.txt"), true);

  const stagedBefore = await gitOutput(root, ["diff", "--cached", "--name-only"]);
  const baseline = baselineRef("refs/devspace/autocommit", "ws_test");
  await captureCheckpoint(root, baseline);
  const stagedAfter = await gitOutput(root, ["diff", "--cached", "--name-only"]);
  assert.equal(stagedAfter, stagedBefore);

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  const candidate = "refs/devspace/autocommit/ws_test/candidate/test";
  await captureCheckpoint(root, candidate);
  const diff = await diffCheckpoints(root, baseline, candidate);
  assert.match(diff.patch, /world/);
  assert.equal(diff.paths.includes("README.md"), true);
  assert.equal(diff.paths.includes("unstaged.txt"), false);

  const head = await gitOutput(root, ["rev-parse", "HEAD"]);
  assert.equal(head.trim().length, 40);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}
