import assert from "node:assert/strict";
import { analyzeCommandSafety, commandInvokesGitCommit, formatCommandSafetyWarning } from "./command-safety.js";

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

assert.equal(analyzeCommandSafety("Get-ChildItem | Format-Table -AutoSize").level, "none");
assert.equal(analyzeCommandSafety("Get-Process | Format-List").level, "none");
assert.equal(analyzeCommandSafety("format C:").level, "danger");
assert.equal(analyzeCommandSafety("Remove-Item fixture -Recurse -Force").level, "danger");
assert.equal(analyzeCommandSafety("Remove-Item fixture -Force -Recurse").level, "danger");
assert.equal(
  analyzeCommandSafety(
    'powershell -NoProfile -Command "Remove-Item -LiteralPath \'D:\\project\\fixture\' -Recurse -Force"',
  ).level,
  "danger",
);
assert.equal(
  analyzeCommandSafety('powershell -NoProfile -Command "Get-ChildItem | Format-Table -AutoSize"').level,
  "none",
);
assert.equal(
  analyzeCommandSafety('echo ok && powershell -NoProfile -Command "Remove-Item fixture -Recurse"').level,
  "danger",
);

assert.equal(analyzeCommandSafety("git clean -nd").level, "none");
assert.equal(analyzeCommandSafety("git clean --dry-run -d").level, "none");
assert.equal(analyzeCommandSafety("git clean -nfd").level, "none");
assert.equal(analyzeCommandSafety("git clean -fd").level, "danger");
assert.equal(analyzeCommandSafety("git -C ./repo clean --force -d").level, "danger");
assert.equal(analyzeCommandSafety('cmd /c "git clean -fd"').level, "danger");
assert.equal(analyzeCommandSafety('powershell -Command "git clean -nd"').level, "none");

assert.equal(commandInvokesGitCommit("git commit -m test"), true);
assert.equal(commandInvokesGitCommit("git -C ./repo commit -m test"), true);
assert.equal(commandInvokesGitCommit("sh -c \"git --no-pager commit -m test\""), true);
assert.equal(commandInvokesGitCommit("sudo git commit -m test"), true);
assert.equal(commandInvokesGitCommit("echo ok && git commit -m test"), true);
assert.equal(commandInvokesGitCommit("git commit-tree HEAD^{tree}"), false);
assert.equal(commandInvokesGitCommit("echo git commit"), false);
