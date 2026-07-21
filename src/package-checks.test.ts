import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePackageChecks } from "./package-checks.js";

const root = await mkdtemp(join(tmpdir(), "localspace-package-checks-"));
try {
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fixture",
    packageManager: "pnpm@10.0.0",
    scripts: {
      typecheck: "tsc --noEmit",
      test: "node test.js",
      danger: "git reset --hard HEAD",
    },
  }), "utf8");

  const prepared = await preparePackageChecks(root, ["typecheck", "test"]);
  assert.equal(prepared.packageName, "fixture");
  assert.equal(prepared.packageManager, "pnpm");
  assert.deepEqual(prepared.checks.map((check) => check.command), [
    "pnpm run typecheck",
    "pnpm run test",
  ]);
  assert.equal(prepared.checks[0]?.safety.level, "none");

  const danger = await preparePackageChecks(root, ["danger"]);
  assert.equal(danger.checks[0]?.safety.level, "danger");
  assert.match(danger.checks[0]?.approvalCommand ?? "", /git reset --hard/);

  await assert.rejects(
    preparePackageChecks(root, ["missing"]),
    /Package scripts not found: missing/,
  );
  await assert.rejects(
    preparePackageChecks(root, ["test", "test"]),
    /duplicate/,
  );
  await assert.rejects(
    preparePackageChecks(root, ["test;rm"]),
    /Unsafe package script name/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
