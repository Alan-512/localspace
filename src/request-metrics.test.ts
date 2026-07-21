import assert from "node:assert/strict";
import { McpRequestMetricsManager } from "./request-metrics.js";

const metrics = new McpRequestMetricsManager(3);

metrics.record({
  transportMode: "stateless",
  httpMethod: "POST",
  rpcMethod: "tools/list",
  status: 200,
  success: true,
  requestBytes: 100,
  responseBytes: 200,
  authMs: 2,
  serverCreateMs: 4,
  transportConnectMs: 3,
  transportHandleMs: 10,
  cleanupMs: 1,
  totalMs: 20,
});
metrics.record({
  transportMode: "stateless",
  httpMethod: "POST",
  rpcMethod: "tools/call",
  tool: "read",
  workspaceId: "ws_test",
  status: 200,
  success: true,
  requestBytes: 120,
  responseBytes: 500,
  authMs: 3,
  serverCreateMs: 5,
  transportConnectMs: 2,
  transportHandleMs: 20,
  cleanupMs: 2,
  totalMs: 32,
});
metrics.record({
  transportMode: "stateful",
  httpMethod: "POST",
  rpcMethod: "tools/call",
  tool: "grep",
  workspaceId: "ws_test",
  status: 500,
  success: false,
  authMs: 4,
  serverCreateMs: 0,
  transportConnectMs: 0,
  transportHandleMs: 30,
  cleanupMs: 0,
  totalMs: 34,
});
metrics.record({
  transportMode: "stateless",
  httpMethod: "POST",
  rpcMethod: "tools/call",
  tool: "git_status",
  workspaceId: "ws_other",
  status: 200,
  success: true,
  authMs: 1,
  serverCreateMs: 6,
  transportConnectMs: 2,
  transportHandleMs: 8,
  cleanupMs: 1,
  totalMs: 18,
});

const summary = metrics.summarize({ workspaceId: "ws_test", limit: 10 });
assert.equal(summary.totalRequests, 2);
assert.equal(summary.successfulRequests, 1);
assert.equal(summary.failedRequests, 1);
assert.equal(summary.statelessRequests, 1);
assert.equal(summary.statefulRequests, 1);
assert.equal(summary.averageTotalMs, 33);
assert.equal(summary.maxTotalMs, 34);
assert.equal(summary.phases.auth.averageMs, 3.5);
assert.equal(summary.phases.transportHandle.maxMs, 30);
assert.equal(summary.rpcMethods["tools/call"], 2);
assert.equal(summary.tools.read, 1);
assert.equal(summary.tools.grep, 1);

const all = metrics.summarize({ limit: 10 });
assert.equal(all.totalRequests, 3);
assert.equal(all.tools.git_status, 1);
