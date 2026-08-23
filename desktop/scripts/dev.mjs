// Builds renderer + main, then launches Electron for local development.
// Requires `npm run build` to have been run once in the repo root so that
// dist/cli.js (the LocalSpace core) exists.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(desktopRoot, "..");

function fail(message) {
  console.error(`dev failed: ${message}`);
  process.exit(1);
}

if (!existsSync(join(repoRoot, "dist", "cli.js"))) {
  fail("LocalSpace core is not built; run `npm run build` in the repo root first.");
}
if (!existsSync(join(desktopRoot, "node_modules"))) {
  fail("desktop dependencies are missing; run `npm install` inside desktop/ first.");
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const build = spawnSync(npmCommand, ["run", "build"], { cwd: desktopRoot, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const electronBinary = join(
  desktopRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);
const launch = spawnSync(electronBinary, ["."], { cwd: desktopRoot, stdio: "inherit" });
process.exit(launch.status ?? 1);
