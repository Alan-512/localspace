import assert from "node:assert/strict";
import { ToolActivityLogManager } from "./activity-log.js";

const activity = new ToolActivityLogManager(4);

activity.record({
  tool: "read",
  workspaceId: "ws_test",
  path: "src/a.ts",
  success: true,
  durationMs: 10,
  outputBytes: 120,
});
activity.record({
  tool: "grep",
  workspaceId: "ws_test",
  path: "src",
  success: true,
  durationMs: 30,
});
activity.record({
  tool: "write_stdin",
  workspaceId: "ws_test",
  success: true,
  durationMs: 20,
  running: true,
});
activity.record({
  tool: "apply_patch",
  workspaceId: "ws_other",
  success: false,
  durationMs: 40,
  error: "failed",
});
activity.record({
  tool: "git_status",
  workspaceId: "ws_test",
  success: true,
  durationMs: 50,
});

const summary = activity.summarize({ workspaceId: "ws_test", limit: 10 });
assert.equal(summary.totalEvents, 3);
assert.equal(summary.successfulEvents, 3);
assert.equal(summary.failedEvents, 0);
assert.equal(summary.processPolls, 1);
assert.equal(summary.averageDurationMs, 33.33);
assert.equal(summary.maxDurationMs, 50);
assert.equal(summary.tools.grep, 1);
assert.equal(summary.categories.navigation, 1);
assert.equal(summary.categories.process, 1);
assert.equal(summary.categories.git, 1);
assert.equal(summary.concurrencyClasses["shared-read"], 2);
assert.equal(summary.concurrencyClasses["process-session"], 1);
assert.equal(summary.toolStats.grep.averageDurationMs, 30);
assert.deepEqual(summary.paths, ["src"]);
assert.match(summary.text, /Session activity summary/);
assert.match(summary.text, /write_stdin/);

const all = activity.summarize({ limit: 10 });
assert.equal(all.totalEvents, 4);
assert.equal(all.failedEvents, 1);
