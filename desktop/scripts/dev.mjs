// Builds renderer + main, then launches Electron for local development.
// Requires `npm run build` to have been run once in the repo root so that
// dist/cli.js (the LocalSpace core) exists.
//
// Every step spawns a JS entry through Node directly: newer Node versions
// refuse to execute .cmd shims without a shell, which made npm.cmd/electron.cmd
// fail silently here.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url)); // desktop/scripts
const desktopDir = join(scriptDir, ".."); // desktop/
const repoRoot = join(desktopDir, ".."); // repository root

function fail(message) {
  console.error(`dev failed: ${message}`);
  process.exit(1);
}

function runNode(relativeEntry, args, label) {
  const entry = join(desktopDir, relativeEntry);
  if (!existsSync(entry)) fail(`missing ${entry}; run \`npm install\` inside desktop/ first`);
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: desktopDir,
    stdio: "inherit",
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(join(repoRoot, "dist", "cli.js"))) {
  fail("LocalSpace core is not built; run `npm run build` in the repository root first.");
}
if (!existsSync(join(desktopDir, "node_modules"))) {
  fail("desktop dependencies are missing; run `npm install` inside desktop/ first.");
}

runNode("node_modules/vite/bin/vite.js", ["build"], "vite build");
runNode("node_modules/typescript/bin/tsc", ["-p", "tsconfig.main.json"], "tsc main build");
runNode("node_modules/electron/cli.js", ["."], "electron");
