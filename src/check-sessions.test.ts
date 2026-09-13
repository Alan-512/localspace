import assert from "node:assert/strict";
import { CheckSessionManager } from "./check-sessions.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { analyzeCommandSafety } from "./command-safety.js";

const processes = new ProcessSessionManager({
  maxConcurrentProcesses: 4,
  maxWorkspaceProcesses: 4,
  completedSessionTtlMs: 1_000,
});
const checks = new CheckSessionManager(processes, { completedSessionTtlMs: 1_000 });
try {
  const completed = await checks.start({
    workspaceId: "ws_checks",
    root: process.cwd(),
    concurrency: 2,
    yieldTimeMs: 5_000,
    checks: [
      definition("pass", `node -e "setTimeout(() => console.log('pass-output'), 80)"`),
      definition("fail", `node -e "setTimeout(() => process.exit(2), 80)"`),
    ],
  });
  assert.equal(completed.running, false);
  assert.equal(completed.summary.passed, 1);
  assert.equal(completed.summary.failed, 1);
  assert.match(completed.checks[0]?.output ?? "", /pass-output/);

  const failFast = await checks.start({
    workspaceId: "ws_checks",
    root: process.cwd(),
    concurrency: 1,
    failFast: true,
    yieldTimeMs: 5_000,
    checks: [
      definition("first-fail", `node -e "process.exit(3)"`),
      definition("skipped", `node -e "console.log('should-not-run')"`),
    ],
  });
  assert.equal(failFast.summary.failed, 1);
  assert.equal(failFast.summary.skipped, 1);
  assert.doesNotMatch(failFast.result, /should-not-run/);

  const running = await checks.start({
    workspaceId: "ws_checks",
    root: process.cwd(),
    yieldTimeMs: 0,
    checks: [
      definition("long", `node -e "setTimeout(() => console.log('long-done'), 180)"`),
    ],
  });
  assert.equal(running.running, true);
  assert.ok(running.sessionId && running.sessionId < 0);
  assert.equal(checks.has("ws_checks", running.sessionId), true);
  const runningRecovery = checks.listRecoverable("ws_checks")
    .find((session) => session.sessionId === running.sessionId);
  assert.ok(runningRecovery);
  assert.equal(runningRecovery.running, true);
  assert.deepEqual(runningRecovery.checkNames, ["long"]);

  let completedRecovery = checks.listRecoverable("ws_checks")
    .find((session) => session.sessionId === running.sessionId);
  const recoveryDeadline = Date.now() + 3_000;
  while (completedRecovery?.running && Date.now() < recoveryDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    completedRecovery = checks.listRecoverable("ws_checks")
      .find((session) => session.sessionId === running.sessionId);
  }
  assert.ok(completedRecovery);
  assert.equal(completedRecovery.running, false);
  assert.equal(completedRecovery.summary.passed, 1);
  assert.equal(completedRecovery.hasPendingOutput, true);
  assert.equal(completedRecovery.hasRecoveryOutput, true);
  assert.match(completedRecovery.outputPreview, /long-done/);
  assert.equal(typeof completedRecovery.completedAt, "string");
  assert.equal(checks.activeProcessSessionIds("ws_checks").size, 0);

  const polled = await checks.write({
    workspaceId: "ws_checks",
    sessionId: running.sessionId,
    yieldTimeMs: 5_000,
  });
  assert.equal(polled.running, false);
  assert.equal(polled.summary.passed, 1);
  assert.match(polled.result, /long-done/);
  const retainedCompleted = checks.listRecoverable("ws_checks")
    .find((session) => session.sessionId === running.sessionId);
  assert.ok(retainedCompleted);
  assert.equal(retainedCompleted.running, false);
  assert.equal(retainedCompleted.hasPendingOutput, false);
  assert.equal(retainedCompleted.hasRecoveryOutput, true);
  const replayed = await checks.write({
    workspaceId: "ws_checks",
    sessionId: running.sessionId,
    yieldTimeMs: 0,
  });
  assert.equal(replayed.running, false);
  assert.equal(replayed.summary.passed, 1);
  assert.match(replayed.result, /long-done/);
} finally {
  checks.shutdown();
  processes.shutdown();
}

function definition(name: string, command: string) {
  return {
    name,
    script: command,
    scriptNames: [name],
    scripts: [{ name, script: command }],
    command,
    approvalCommand: `run_checks:${name}\n${command}`,
    safety: analyzeCommandSafety(command),
  };
}
