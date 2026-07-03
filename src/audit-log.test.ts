import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { AuditLogManager, defaultAuditLogPath } from "./audit-log.js";

const root = await mkdtemp(join(tmpdir(), "localspace-audit-log-test-"));
const audit = new AuditLogManager({ enabled: true, path: defaultAuditLogPath(root), maxMemoryEvents: 3 });

audit.record({ tool: "write", workspaceId: "ws_test", success: true, paths: ["src/a.ts"], durationMs: 5 });
audit.record({ tool: "exec_command", workspaceId: "ws_test", success: false, blocked: true, risk: "danger", commandPreview: "git reset --hard" });
audit.record({ tool: "exec_command", workspaceId: "ws_test", success: true, approved: true, risk: "danger", commandPreview: "git reset --hard" });
audit.record({ tool: "git_commit", workspaceId: "ws_other", success: true });

const summary = audit.summarize({ workspaceId: "ws_test", limit: 10 });
assert.equal(summary.totalEvents, 2);
assert.equal(summary.blockedEvents, 1);
assert.equal(summary.approvedEvents, 1);
assert.equal(summary.tools.exec_command, 2);
assert.match(summary.text, /Session summary/);
assert.match(summary.text, /git reset --hard/);

const all = audit.summarize({ limit: 10 });
assert.equal(all.totalEvents, 3);
