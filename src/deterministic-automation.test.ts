import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, AuditSummary } from "./audit-log.js";
import {
  classifyValidationEvidence,
  createDeterministicAutomation,
  validationEvidenceAction,
} from "./deterministic-automation.js";
import { workspaceContentRevision } from "./workspace-revision.js";

const root = await mkdtemp(join(tmpdir(), "localspace-deterministic-automation-"));
try {
  await mkdir(join(root, "src"), { recursive: true });
  const sourcePath = join(root, "src", "index.ts");
  await writeFile(sourcePath, "export const answer = 42;\n", "utf8");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "automation@localspace.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "LocalSpace Automation Test"], { cwd: root });
  execFileSync("git", ["add", "--", "src/index.ts"], { cwd: root });
  execFileSync("git", ["commit", "-m", "automation baseline"], { cwd: root, stdio: "ignore" });
  const changeTime = new Date("2026-07-21T10:00:00.000Z");
  await utimes(sourcePath, changeTime, changeTime);

  const stale = await createDeterministicAutomation(
    root,
    ["src/index.ts"],
    auditSummary([
      event("exec_command", "2026-07-21T09:59:00.000Z", {
        action: "validation:test",
        exitCode: 0,
      }),
    ]),
    { staged: true },
  );
  assert.equal(stale.validationFreshness, "stale");
  assert.equal(stale.commitReviewRequired, true);
  assert.ok(stale.recommendations.some((item) => item.id === "validation-after-change"));
  assert.ok(stale.recommendations.some((item) => item.id === "format-after-source-change"));
  assert.ok(stale.recommendations.some((item) => item.id === "inspect-staged-diff"));

  const current = await createDeterministicAutomation(
    root,
    ["src/index.ts"],
    auditSummary([
      event("run_checks", "2026-07-21T10:01:00.000Z", {
        action: "validation:typecheck",
        exitCode: 0,
      }),
    ]),
  );
  assert.equal(current.validationFreshness, "current");
  assert.equal(current.commitReviewRequired, false);
  assert.deepEqual(current.validationEvidence, ["typecheck"]);

  const contentRevision = await workspaceContentRevision(root);
  assert.equal(typeof contentRevision, "string");
  const revisionCurrent = await createDeterministicAutomation(
    root,
    ["src/index.ts"],
    auditSummary([
      event("run_checks", "2026-07-21T09:00:00.000Z", {
        action: "validation:test",
        workspaceRevision: contentRevision,
        exitCode: 0,
      }),
    ]),
  );
  assert.equal(revisionCurrent.validationFreshness, "current");

  const revisionMismatch = await createDeterministicAutomation(
    root,
    ["src/index.ts"],
    auditSummary([
      event("run_checks", "2026-07-21T11:00:00.000Z", {
        action: "validation:test",
        workspaceRevision: "different-content",
        exitCode: 0,
      }),
    ]),
  );
  assert.equal(revisionMismatch.validationFreshness, "unknown");

  await writeFile(join(root, "package.json"), "{}\n", "utf8");
  const packageChange = await createDeterministicAutomation(root, ["package.json"]);
  assert.equal(packageChange.validationFreshness, "unknown");
  assert.equal(packageChange.packageValidationFreshness, "unknown");
  assert.equal(packageChange.commitReviewRequired, true);
  assert.ok(packageChange.recommendations.some((item) => item.id === "package-metadata-dry-run"));

  const packageInfo = await lstat(join(root, "package.json"));
  const packageCurrent = await createDeterministicAutomation(
    root,
    ["package.json"],
    auditSummary([
      event("exec_command", new Date(packageInfo.mtimeMs + 1_000).toISOString(), {
        action: "validation:package",
        exitCode: 0,
      }),
    ]),
  );
  assert.equal(packageCurrent.packageValidationFreshness, "current");
  assert.ok(packageCurrent.recommendations.some((item) => item.id === "package-metadata-current"));
  assert.ok(!packageCurrent.recommendations.some((item) => item.id === "package-metadata-dry-run"));

  const docsOnly = await createDeterministicAutomation(root, ["README.md"]);
  assert.equal(docsOnly.validationFreshness, "not-required");
  assert.equal(docsOnly.commitReviewRequired, false);

  const envTemplate = await createDeterministicAutomation(root, [".env.example"]);
  assert.equal(envTemplate.commitReviewRequired, false);
  assert.ok(!envTemplate.recommendations.some((item) => item.id === "sensitive-change-review"));

  const sensitive = await createDeterministicAutomation(root, [".env.local"]);
  assert.equal(sensitive.commitReviewRequired, true);
  assert.ok(sensitive.recommendations.some((item) => item.id === "sensitive-change-review"));

  assert.equal(classifyValidationEvidence("npm run typecheck"), "typecheck");
  assert.equal(classifyValidationEvidence("npm pack --dry-run --json"), "package");
  assert.equal(classifyValidationEvidence("node server.js"), undefined);
  assert.equal(validationEvidenceAction("npm test"), "validation:test");
} finally {
  await rm(root, { recursive: true, force: true });
}

function event(
  tool: string,
  time: string,
  fields: Partial<AuditEvent>,
): AuditEvent {
  return {
    id: `${tool}-${time}`,
    time,
    tool,
    success: true,
    ...fields,
  };
}

function auditSummary(events: AuditEvent[]): AuditSummary {
  return {
    totalEvents: events.length,
    successfulEvents: events.filter((event) => event.success).length,
    failedEvents: events.filter((event) => !event.success).length,
    blockedEvents: events.filter((event) => event.blocked).length,
    approvedEvents: events.filter((event) => event.approved).length,
    tools: {},
    paths: [],
    commands: [],
    risks: {},
    recentEvents: events,
    text: "",
  };
}
