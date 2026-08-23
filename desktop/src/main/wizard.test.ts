import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWizardInitArgs,
  runWizardInit,
  validateWizardInput,
} from "./wizard.js";
import type { RuntimePaths } from "./runtime-paths.js";

const baseInput = {
  roots: ["C:/work/a", "C:/work,b/project"],
  port: 7788,
  publicBaseUrl: "https://demo.example.com/",
  force: false,
};

// argument assembly: each root gets its own flag so commas in paths survive
{
  const args = buildWizardInitArgs(baseInput);
  assert.deepEqual(args, [
    "init",
    "--non-interactive",
    "--roots",
    "C:/work/a",
    "--roots",
    "C:/work,b/project",
    "--port",
    "7788",
    "--public-base-url",
    "https://demo.example.com/",
  ]);

  const forcedArgs = buildWizardInitArgs({ ...baseInput, force: true });
  assert.ok(forcedArgs.includes("--force"));
}

// input validation
assert.equal(validateWizardInput(baseInput).valid, true);
assert.equal(validateWizardInput({ ...baseInput, roots: [] }).valid, false);
assert.equal(validateWizardInput({ ...baseInput, roots: [""] }).valid, false);
assert.equal(validateWizardInput({ ...baseInput, port: 0 }).valid, false);
assert.equal(validateWizardInput({ ...baseInput, port: 65536 }).valid, false);
assert.equal(validateWizardInput({ ...baseInput, publicBaseUrl: "" }).valid, false);
assert.equal(validateWizardInput({ ...baseInput, publicBaseUrl: "https://x.example.com/mcp" }).valid, false);
assert.equal(validateWizardInput({ ...baseInput, publicBaseUrl: "ftp://x.example.com" }).valid, false);
assert.equal(validateWizardInput({ ...baseInput, publicBaseUrl: "not a url" }).valid, false);

async function main(): Promise<void> {
  // failure path: a script that exits nonzero with stderr surfaces the error
  {
    const failingScript = join(mkdtempSync(join(tmpdir(), "localspace-wizard-")), "fail.cjs");
    writeFileSync(failingScript, "process.stderr.write('boom from cli'); process.exit(3);\n");
    const paths: RuntimePaths = {
      nodeExecutable: process.execPath,
      serverRoot: tmpdir(),
      cliScript: failingScript,
    };

    const result = await runWizardInit(paths, baseInput, () => ({ ownerToken: null }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /boom from cli/);
  }

  // success path: exit 0 and the injected token reader supplies the password
  {
    const okScript = join(mkdtempSync(join(tmpdir(), "localspace-wizard-")), "ok.cjs");
    writeFileSync(okScript, "process.exit(0);\n");
    const paths: RuntimePaths = {
      nodeExecutable: process.execPath,
      serverRoot: tmpdir(),
      cliScript: okScript,
    };

    const result = await runWizardInit(paths, baseInput, () => ({ ownerToken: "token-from-auth" }));
    assert.deepEqual(result, { ok: true, ownerToken: "token-from-auth" });
  }

  // invalid input never spawns a process
  {
    const paths: RuntimePaths = {
      nodeExecutable: "definitely-not-a-real-binary",
      serverRoot: tmpdir(),
      cliScript: "nope.js",
    };
    const result = await runWizardInit(paths, { ...baseInput, port: 0 }, () => ({ ownerToken: null }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /端口/);
  }

  console.log("wizard tests passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
