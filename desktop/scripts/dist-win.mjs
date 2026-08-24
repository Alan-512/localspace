// One-command Windows installer build:
//
//   core build -> resources/server assembly -> desktop build -> electron-builder (NSIS)
//
// Networks where GitHub release downloads stall (common in CN) need mirrors:
// electron-builder defaults to github for its toolsets and the Electron zip,
// and the Electron download reliably hangs there. We therefore default
// ELECTRON_BUILDER_BINARIES_MIRROR / ELECTRON_MIRROR to npmmirror (override by
// exporting your own value) and, when the locally installed Electron dist
// exists, hand it to electron-builder via -c.electronDist so the 130MB zip is
// never downloaded at all.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "..");
const localElectronDist = join(desktopRoot, "node_modules", "electron", "dist");

function run(command, args, options = {}) {
  const { name, cwd = desktopRoot } = { name: command, ...options };
  console.log(`[dist-win] ${name} ...`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`[dist-win] ${name} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

const env = { ...process.env };
env.ELECTRON_BUILDER_BINARIES_MIRROR ??= "https://registry.npmmirror.com/-/binary/electron-builder-binaries/";
env.ELECTRON_MIRROR ??= "https://registry.npmmirror.com/-/binary/electron/";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

run(npm, ["run", "build"], { cwd: repoRoot, name: "build core" });
run(process.execPath, [join(desktopRoot, "scripts", "prepare-server.mjs")], {
  name: "assemble resources/server",
});
run(npm, ["run", "build"], { name: "build desktop" });

const builderArgs = [
  join(desktopRoot, "node_modules", "electron-builder", "cli.js"),
  "--config",
  "electron-builder.yml",
  "--win",
];
if (existsSync(join(localElectronDist, "electron.exe"))) {
  builderArgs.push("-c.electronDist=" + localElectronDist);
}
run(process.execPath, builderArgs, { name: "electron-builder" });

console.log("[dist-win] done — see desktop/release/");
