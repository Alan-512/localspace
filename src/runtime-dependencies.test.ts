import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};
const directNames = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
]);

for (const dependency of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@google/genai",
  "protobufjs",
]) {
  assert.equal(directNames.has(dependency), false, `${dependency} must not be a direct LocalSpace dependency`);
  assert.equal(dependency in (packageJson.overrides ?? {}), false, `${dependency} override should not remain`);
}

const lock = await readFile(join(root, "package-lock.json"), "utf8");
for (const marker of [
  "node_modules/@earendil-works/pi-coding-agent",
  "node_modules/@earendil-works/pi-agent-core",
  "node_modules/@earendil-works/pi-ai",
  "node_modules/@google/genai",
  "node_modules/protobufjs",
]) {
  assert.doesNotMatch(lock, new RegExp(escapeRegExp(marker)), `${marker} must not remain in package-lock.json`);
}

for (const sourcePath of ["src/server.ts", "src/skills.ts", "src/workspaces.ts", "src/cli.ts"]) {
  const source = await readFile(join(root, sourcePath), "utf8");
  assert.doesNotMatch(source, /@earendil-works\/pi|pi-tools\.js/);
}

await assert.rejects(access(join(root, "src", "pi-tools.ts")));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
