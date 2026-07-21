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
  const polled = await checks.write({
    workspaceId: "ws_checks",
    sessionId: running.sessionId,
    yieldTimeMs: 5_000,
  });
  assert.equal(polled.running, false);
  assert.equal(polled.summary.passed, 1);
  assert.match(polled.result, /long-done/);
} finally {
  checks.shutdown();
  processes.shutdown();
}

function definition(name: string, command: string) {
  return {
    name,
    script: command,
    command,
    approvalCommand: `run_checks:${name}\n${command}`,
    safety: analyzeCommandSafety(command),
  };
}
