import assert from "node:assert/strict";
import { CommandApprovalManager } from "./command-approval.js";
import { analyzeCommandSafety } from "./command-safety.js";

const safety = analyzeCommandSafety("git reset --hard");
const context = {
  workspaceId: "ws_test",
  cwd: "/tmp/project",
  command: "git reset --hard",
  safety,
};

const approvals = new CommandApprovalManager({ ttlMs: 1_000 });

assert.equal(approvals.consume(undefined, context).approved, false);
assert.equal(approvals.consume(undefined, context).reason, "missing");

const request = approvals.create(context);
assert.match(request.token, /^approve-/);
assert.equal(request.workspaceId, context.workspaceId);
assert.equal(request.command, context.command);
assert.equal(request.risk, "danger");

assert.deepEqual(
  approvals.consume(request.token, { ...context, command: "git clean -fd" }),
  { approved: false, reason: "mismatch" },
);

assert.deepEqual(approvals.consume(request.token, context), { approved: true });
assert.deepEqual(approvals.consume(request.token, context), { approved: false, reason: "not_found" });

const expiring = new CommandApprovalManager({ ttlMs: -1 });
const expired = expiring.create(context);
assert.deepEqual(expiring.consume(expired.token, context), { approved: false, reason: "expired" });
