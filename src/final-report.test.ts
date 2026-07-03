import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AuditSummary } from "./audit-log.js";
import { createFinalReport, createHandoffSummary } from "./final-report.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "localspace-final-report-test-"));

try {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "final-report-fixture",
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

  const report = await createFinalReport(root, auditFixture(), {
    taskTitle: "Phase 7.3",
    completed: ["Added report tools."],
    remaining: ["Run release checks."],
  });
  assert.equal(report.taskTitle, "Phase 7.3");
  assert.equal(report.git.isRepository, true);
  assert.equal(report.git.dirty, true);
  assert.ok(report.changedFiles.includes("src/index.ts"));
  assert.ok(report.validation.detectedResults.some((result) => result.kind === "build"));
  assert.match(report.commit.suggestion, /Uncommitted changes/);
  assert.equal(report.nextRecommendedStep, "Review current changes, run validation if needed, then commit.");
  assert.match(report.text, /Final report/);

  const handoff = await createHandoffSummary(root, auditFixture(), {
    currentPhase: "Phase 7 complete",
    completedPhases: ["Phase 7.1", "Phase 7.2", "Phase 7.3"],
    remainingTasks: ["Phase 8 release docs"],
  });
  assert.equal(handoff.currentPhase, "Phase 7 complete");
  assert.ok(handoff.completedPhases.includes("Phase 7.3"));
  assert.ok(handoff.remainingTasks.includes("Phase 8 release docs"));
  assert.match(handoff.suggestedFirstPrompt, /@localspace Continue LocalSpace/);
  assert.match(handoff.text, /LocalSpace Handoff Summary/);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function auditFixture(): AuditSummary {
  return {
    totalEvents: 3,
    successfulEvents: 3,
    failedEvents: 0,
    blockedEvents: 0,
    approvedEvents: 0,
    tools: { exec_command: 2, apply_patch: 1 },
    paths: ["src/index.ts"],
    commands: ["npm run typecheck", "npm run build"],
    risks: { none: 2 },
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
        success: true,
        risk: "none",
        commandPreview: "npm run build",
        exitCode: 0,
      },
      {
        id: "audit_3",
        time: "2026-01-01T00:00:02.000Z",
        tool: "apply_patch",
        success: true,
        paths: ["src/index.ts"],
      },
    ],
    text: "",
  };
}
