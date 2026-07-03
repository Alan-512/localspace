import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createNextSteps, createReviewChecklist, createValidatePlan } from "./workflow-tools.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "localspace-workflow-tools-test-"));

try {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "workflow-fixture",
    scripts: {
      typecheck: "tsc --noEmit",
      test: "node test.js",
      build: "vite build",
    },
  }, null, 2));
  await writeFile(join(root, "src", "index.ts"), "export const answer = 42;\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "localspace@example.com"]);
  await git(root, ["config", "user.name", "LocalSpace Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const validation = await createValidatePlan(root);
  assert.equal(validation.packageName, "workflow-fixture");
  assert.deepEqual(validation.commands.map((command) => command.command), ["npm run typecheck", "npm test", "npm run build"]);
  assert.match(validation.text, /Validation plan/);

  await writeFile(join(root, "src", "index.ts"), "export const answer = 43;\n");
  const checklist = await createReviewChecklist(root);
  assert.equal(checklist.dirty, true);
  assert.equal(checklist.unstaged, true);
  assert.ok(checklist.changedPaths.includes("src/index.ts"));
  assert.ok(checklist.checks.some((check) => check.title === "Inspect changes" && check.status === "action"));

  const next = await createNextSteps(root, { blockedEvents: 1 } as never);
  assert.ok(next.steps.some((step) => step.title === "Review current changes"));
  assert.ok(next.steps.some((step) => step.title === "Review blocked events"));
  assert.match(next.text, /Next steps/);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
