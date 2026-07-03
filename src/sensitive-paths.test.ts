import { mkdtemp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { analyzeSensitivePath, assertWritablePath, SensitivePathError } from "./sensitive-paths.js";

const root = await mkdtemp(join(tmpdir(), "localspace-sensitive-paths-test-"));
const config = {
  stateDir: join(root, ".state"),
  agentDir: join(root, ".codex"),
  worktreeRoot: join(root, ".worktrees"),
};
const context = { workspaceRoot: root, config };

assert.equal(analyzeSensitivePath(join(root, "src", "server.ts"), context).level, "none");
assert.equal(analyzeSensitivePath(join(root, ".env"), context).level, "protected");
assert.equal(analyzeSensitivePath(join(root, ".env.local"), context).level, "protected");
assert.equal(analyzeSensitivePath(join(root, ".git", "config"), context).level, "protected");
assert.equal(analyzeSensitivePath(join(root, ".git", "hooks", "pre-commit"), context).level, "protected");
assert.equal(analyzeSensitivePath(join(root, "auth.json"), context).level, "protected");
assert.equal(analyzeSensitivePath(join(root, "service-token.txt"), context).level, "protected");
assert.equal(analyzeSensitivePath(join(root, "private-key.pem"), context).level, "protected");
assert.equal(analyzeSensitivePath(join(root, ".codex", "config.toml"), context).level, "protected");

assert.doesNotThrow(() => assertWritablePath(join(root, "src", "server.ts"), context));
assert.throws(
  () => assertWritablePath(join(root, ".env"), context),
  (error) => error instanceof SensitivePathError && /Sensitive path blocked/.test(error.message),
);

assert.equal(analyzeSensitivePath(homedir(), context).level, "protected");
