import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AuditSummary } from "./audit-log.js";
import { createTaskSummary, createValidationSummary } from "./task-summary.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "localspace-task-summary-test-"));

try {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "task-summary-fixture",
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

  await writeFile(join(root, "src", "index.ts"), "export const answer = 43;\n");

  const audit = auditFixture();
  const task = await createTaskSummary(root, audit);
  assert.equal(task.git.dirty, true);
  assert.equal(task.git.unstaged, true);
  assert.deepEqual(task.validation.recommendedCommands, ["npm run typecheck", "npm test", "npm run build"]);
  assert.ok(task.changedPaths.includes("src/index.ts"));
  assert.equal(task.audit.blockedEvents, 1);
  assert.ok(task.warnings.some((warning) => warning.includes("blocked tool event")));
  assert.match(task.text, /Task summary/);

  const validation = await createValidationSummary(root, audit);
  assert.equal(validation.commandPreviewEnabled, true);
  assert.equal(validation.recentExecCommands, 3);
  assert.equal(validation.recentFailures, 1);
  assert.ok(validation.detectedResults.some((result) => result.kind === "typecheck" && result.passed === true));
  assert.ok(validation.detectedResults.some((result) => result.kind === "test" && result.passed === false));
  assert.ok(validation.detectedResults.some((result) => result.kind === "smoke"));
  assert.match(validation.text, /Validation summary/);

  const hidden = await createValidationSummary(root, auditWithoutCommandPreview());
  assert.equal(hidden.commandPreviewEnabled, false);
  assert.equal(hidden.detectedResults.length, 0);
  assert.ok(hidden.notes.some((note) => note.includes("Command preview logging is disabled")));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function auditFixture(): AuditSummary {
  return {
    totalEvents: 4,
    successfulEvents: 3,
    failedEvents: 1,
    blockedEvents: 1,
    approvedEvents: 0,
    tools: { exec_command: 3, apply_patch: 1 },
    paths: ["src/index.ts"],
    commands: ["npm run typecheck", "npm test", "node -e smoke"],
    risks: { none: 3 },
    recentEvents: [
      {
        id: "audit_1",
        time: "2026-01-01T00:00:00.000Z",
        tool: "exec_command",
        success: true,
        risk: "none",
        commandPreview: "npm run typecheck",
        exitCode: 0,
      },
      {
        id: "audit_2",
        time: "2026-01-01T00:00:01.000Z",
        tool: "exec_command",
        success: false,
        risk: "none",
        commandPreview: "npm test",
        exitCode: 1,
      },
      {
        id: "audit_3",
        time: "2026-01-01T00:00:02.000Z",
        tool: "exec_command",
        success: true,
        risk: "none",
        commandPreview: "node -e smoke",
        exitCode: 0,
      },
      {
        id: "audit_4",
        time: "2026-01-01T00:00:03.000Z",
        tool: "apply_patch",
        success: true,
        blocked: true,
        paths: ["src/index.ts"],
      },
    ],
    text: "",
  };
}

function auditWithoutCommandPreview(): AuditSummary {
  return {
    ...auditFixture(),
    commands: [],
    recentEvents: auditFixture().recentEvents.map((event) => ({ ...event, commandPreview: undefined })),
  };
}
