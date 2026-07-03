import assert from "node:assert/strict";
import { analyzeCommandSafety, formatCommandSafetyWarning } from "./command-safety.js";

assert.deepEqual(analyzeCommandSafety("npm run test"), { level: "none", findings: [] });

const rm = analyzeCommandSafety("rm -rf dist");
assert.equal(rm.level, "danger");
assert.equal(rm.findings[0]?.category, "filesystem");
assert.match(formatCommandSafetyWarning(rm) ?? "", /Command safety: DANGER/);

const reset = analyzeCommandSafety("git reset --hard HEAD~1");
assert.equal(reset.level, "danger");
assert.equal(reset.findings[0]?.category, "git");

const rebase = analyzeCommandSafety("git rebase -i main");
assert.equal(rebase.level, "warning");
assert.equal(rebase.findings[0]?.category, "git");

const publish = analyzeCommandSafety("npm publish --access public");
assert.equal(publish.level, "warning");
assert.equal(publish.findings[0]?.category, "publish/deploy");

const shellWrite = analyzeCommandSafety("echo hello > README.md");
assert.equal(shellWrite.level, "notice");
assert.equal(shellWrite.findings[0]?.category, "shell-write");

const combined = analyzeCommandSafety("echo hello > README.md && git push --force origin main");
assert.equal(combined.level, "danger");
assert.equal(combined.findings.length, 2);
