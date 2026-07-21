import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspacePolicyError,
  WorkspacePolicyManager,
  assertPolicyCommandAllowed,
  assertPolicyGitAddPaths,
  assertPolicyPackageScriptsAllowed,
  assertPolicyReadManyAllowed,
  assertPolicyWritablePaths,
  commandSafetyWithPolicyApproval,
  policyRequiresApproval,
  workspacePolicySummary,
} from "./workspace-policy.js";

const root = await mkdtemp(join(tmpdir(), "localspace-policy-test-"));
const stateDir = join(root, ".state");
const workspace = join(root, "workspace");
const policyDir = join(workspace, ".localspace");
const policyPath = join(policyDir, "policy.json");
await mkdir(policyDir, { recursive: true });

try {
  const absentManager = new WorkspacePolicyManager(stateDir);
  const absent = await absentManager.resolve(workspace);
  assert.equal(absent.status, "absent");
  assert.equal(absent.valid, true);
  assert.equal(absent.failClosed, false);
  assert.equal(absent.rules.maxReadManyFiles, 20);

  await writePolicy({
    version: 1,
    readOnlyPaths: ["src/generated", "package-lock.json"],
    deniedCommandPatterns: ["npm publish*", "git push*--force*"],
    allowedPackageScripts: ["test", "typecheck"],
    maxReadManyFiles: 3,
    allowCommands: true,
    allowPty: false,
    requireApprovalTools: ["exec_command", "run_checks"],
  });

  const manager = new WorkspacePolicyManager(stateDir);
  const active = await manager.resolve(workspace);
  assert.equal(active.status, "active");
  assert.equal(active.present, true);
  assert.equal(active.valid, true);
  assert.equal(active.failClosed, false);
  assert.deepEqual(active.rules.readOnlyPaths, ["package-lock.json", "src/generated"]);
  assert.deepEqual(active.rules.allowedPackageScripts, ["test", "typecheck"]);
  assert.equal(active.rules.maxReadManyFiles, 3);
  assert.equal(active.rules.allowPty, false);
  assert.equal(policyRequiresApproval(active, "exec_command"), true);
  assert.equal(policyRequiresApproval(active, "run_checks"), true);

  const summary = workspacePolicySummary(active);
  assert.equal(summary.status, "active");
  assert.equal(summary.readOnlyPaths, 2);
  assert.equal(summary.allowedPackageScripts, 2);

  assert.doesNotThrow(() => assertPolicyCommandAllowed(active, "npm test", false));
  assert.throws(
    () => assertPolicyCommandAllowed(active, "npm publish --access public", false),
    (error: unknown) => policyError(error, "deniedCommandPatterns"),
  );
  assert.throws(
    () => assertPolicyCommandAllowed(active, "node repl.js", true),
    (error: unknown) => policyError(error, "allowPty"),
  );
  assert.doesNotThrow(() => assertPolicyPackageScriptsAllowed(active, ["test"]));
  assert.throws(
    () => assertPolicyPackageScriptsAllowed(active, ["build"]),
    (error: unknown) => policyError(error, "allowedPackageScripts"),
  );
  assert.doesNotThrow(() => assertPolicyReadManyAllowed(active, 3));
  assert.throws(
    () => assertPolicyReadManyAllowed(active, 4),
    (error: unknown) => policyError(error, "maxReadManyFiles"),
  );
  assert.doesNotThrow(() =>
    assertPolicyWritablePaths(active, workspace, [join(workspace, "src", "index.ts")])
  );
  assert.throws(
    () => assertPolicyWritablePaths(active, workspace, [join(workspace, "src", "generated", "api.ts")]),
    (error: unknown) => policyError(error, "readOnlyPaths"),
  );
  assert.throws(
    () => assertPolicyGitAddPaths(active, workspace, [join(workspace, "src")]),
    (error: unknown) => policyError(error, "readOnlyPaths"),
  );
  if (process.platform === "win32") {
    assert.throws(
      () => assertPolicyWritablePaths(active, workspace, [join(workspace, "SRC", "GENERATED", "api.ts")]),
      (error: unknown) => policyError(error, "readOnlyPaths"),
    );
  }

  const approvedSafety = commandSafetyWithPolicyApproval(
    { level: "none", findings: [] },
    active,
    "exec_command",
  );
  assert.equal(approvedSafety.level, "danger");
  assert.ok(approvedSafety.findings.some((finding) => finding.category === "workspace-policy"));

  await writePolicy({
    version: 1,
    readOnlyPaths: ["src/generated", "package-lock.json", "release"],
    deniedCommandPatterns: ["npm publish*", "git push*--force*"],
    allowedPackageScripts: ["test"],
    maxReadManyFiles: 2,
    allowCommands: false,
    allowPty: false,
    requireApprovalTools: ["exec_command", "run_checks"],
  });
  const tightened = await manager.resolve(workspace);
  assert.equal(tightened.status, "active");
  assert.deepEqual(tightened.rules.readOnlyPaths, ["package-lock.json", "release", "src/generated"]);
  assert.deepEqual(tightened.rules.allowedPackageScripts, ["test"]);
  assert.equal(tightened.rules.maxReadManyFiles, 2);
  assert.equal(tightened.rules.allowCommands, false);

  await writePolicy({
    version: 1,
    readOnlyPaths: [],
    deniedCommandPatterns: [],
    allowedPackageScripts: ["test", "typecheck", "build"],
    maxReadManyFiles: 20,
    allowCommands: true,
    allowPty: true,
    requireApprovalTools: [],
  });
  const anchored = await manager.resolve(workspace);
  assert.equal(anchored.status, "anchored");
  assert.deepEqual(anchored.rules.readOnlyPaths, ["package-lock.json", "release", "src/generated"]);
  assert.deepEqual(anchored.rules.allowedPackageScripts, ["test"]);
  assert.equal(anchored.rules.maxReadManyFiles, 2);
  assert.equal(anchored.rules.allowCommands, false);
  assert.equal(anchored.rules.allowPty, false);
  assert.equal(policyRequiresApproval(anchored, "exec_command"), true);

  await unlink(policyPath);
  const retained = await new WorkspacePolicyManager(stateDir).resolve(workspace);
  assert.equal(retained.status, "anchored");
  assert.equal(retained.present, false);
  assert.deepEqual(retained.rules.readOnlyPaths, ["package-lock.json", "release", "src/generated"]);
  assert.equal(retained.rules.allowCommands, false);

  const concurrentWorkspace = join(root, "concurrent-workspace");
  await mkdir(join(concurrentWorkspace, ".localspace"), { recursive: true });
  await writeFile(
    join(concurrentWorkspace, ".localspace", "policy.json"),
    JSON.stringify({ version: 1, maxReadManyFiles: 4 }),
    "utf8",
  );
  const concurrentManager = new WorkspacePolicyManager(join(root, ".concurrent-state"));
  const concurrentPolicies = await Promise.all(
    Array.from({ length: 8 }, () => concurrentManager.resolve(concurrentWorkspace)),
  );
  assert.ok(concurrentPolicies.every((policy) => policy.status === "active"));
  assert.ok(concurrentPolicies.every((policy) => policy.rules.maxReadManyFiles === 4));

  const aliasWorkspace = join(root, "alias-workspace");
  const aliasPath = join(root, "alias-workspace-link");
  const aliasPolicyPath = join(aliasWorkspace, ".localspace", "policy.json");
  await mkdir(join(aliasWorkspace, ".localspace"), { recursive: true });
  await writeFile(aliasPolicyPath, JSON.stringify({ version: 1, maxReadManyFiles: 2 }), "utf8");
  const aliasStateDir = join(root, ".alias-state");
  await new WorkspacePolicyManager(aliasStateDir).resolve(aliasWorkspace);
  await writeFile(aliasPolicyPath, JSON.stringify({ version: 1, maxReadManyFiles: 20 }), "utf8");
  let directoryAliasCreated = false;
  try {
    await symlink(aliasWorkspace, aliasPath, process.platform === "win32" ? "junction" : "dir");
    directoryAliasCreated = true;
  } catch (error) {
    if (!isSymlinkPrivilegeError(error)) throw error;
  }
  if (directoryAliasCreated) {
    const throughAlias = await new WorkspacePolicyManager(aliasStateDir).resolve(aliasPath);
    assert.equal(throughAlias.status, "anchored");
    assert.equal(throughAlias.rules.maxReadManyFiles, 2);
  }

  const invalidWorkspace = join(root, "invalid-workspace");
  await mkdir(join(invalidWorkspace, ".localspace"), { recursive: true });
  await writeFile(
    join(invalidWorkspace, ".localspace", "policy.json"),
    JSON.stringify({ version: 1, unknownPermission: true }),
    "utf8",
  );
  const invalid = await new WorkspacePolicyManager(join(root, ".invalid-state")).resolve(invalidWorkspace);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.valid, false);
  assert.equal(invalid.failClosed, true);
  assert.equal(invalid.rules.allowCommands, false);
  assert.equal(invalid.rules.maxReadManyFiles, 1);
  assert.throws(
    () => assertPolicyCommandAllowed(invalid, "npm test", false),
    (error: unknown) => policyError(error, "invalid-policy"),
  );
  assert.throws(
    () => assertPolicyWritablePaths(invalid, invalidWorkspace, [join(invalidWorkspace, "README.md")]),
    (error: unknown) => policyError(error, "invalid-policy"),
  );

  const escapingWorkspace = join(root, "escaping-workspace");
  await mkdir(join(escapingWorkspace, ".localspace"), { recursive: true });
  await writeFile(
    join(escapingWorkspace, ".localspace", "policy.json"),
    JSON.stringify({ version: 1, readOnlyPaths: ["../outside"] }),
    "utf8",
  );
  const escaping = await new WorkspacePolicyManager(join(root, ".escaping-state")).resolve(escapingWorkspace);
  assert.equal(escaping.status, "invalid");
  assert.match(escaping.diagnostics.join(" "), /may not escape the workspace/);

  const symlinkWorkspace = join(root, "symlink-workspace");
  const symlinkPolicyDir = join(symlinkWorkspace, ".localspace");
  const externalPolicy = join(root, "external-policy.json");
  await mkdir(symlinkPolicyDir, { recursive: true });
  await writeFile(externalPolicy, JSON.stringify({ version: 1 }), "utf8");
  let symlinkCreated = false;
  try {
    await symlink(externalPolicy, join(symlinkPolicyDir, "policy.json"), "file");
    symlinkCreated = true;
  } catch (error) {
    if (!isSymlinkPrivilegeError(error)) throw error;
  }
  if (symlinkCreated) {
    const linked = await new WorkspacePolicyManager(join(root, ".symlink-state")).resolve(symlinkWorkspace);
    assert.equal(linked.status, "invalid");
    assert.match(linked.diagnostics.join(" "), /may not be a symbolic link/);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function writePolicy(value: unknown): Promise<void> {
  await writeFile(policyPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function policyError(error: unknown, rule: string): boolean {
  return error instanceof WorkspacePolicyError && error.rule === rule;
}

function isSymlinkPrivilegeError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "EPERM" || error.code === "EACCES" || error.code === "UNKNOWN";
}
