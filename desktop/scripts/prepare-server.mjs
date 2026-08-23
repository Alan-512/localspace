// Assembles desktop/resources/server — a self-contained LocalSpace runtime the
// packaged Electron app launches through a bundled Node sidecar:
//
//   resources/server/{dist,skills,node_modules,package.json}
//   resources/bin/<node binary for the current platform>
//
// Usage: node scripts/prepare-server.mjs [--skip-node-download]
// Env overrides: LOCALSPACE_NODE_MIRROR (default https://nodejs.org/dist),
//                LOCALSPACE_DESKTOP_NODE_BIN (path to a pre-downloaded binary).
import { spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(desktopRoot, "..");
const resourcesServer = join(desktopRoot, "resources", "server");
const resourcesBin = join(desktopRoot, "resources", "bin");
const resourcesDir = join(desktopRoot, "resources");
const skipNodeDownload = process.argv.includes("--skip-node-download");

function fail(message) {
  console.error(`prepare-server failed: ${message}`);
  process.exit(1);
}

function copyIfExists(from, to) {
  if (!existsSync(from)) fail(`missing ${from}; run \`npm run build\` in the repo root first`);
  cpSync(from, to, { recursive: true });
}

console.log("assembling resources/server ...");
rmSync(resourcesServer, { recursive: true, force: true });
mkdirSync(resourcesServer, { recursive: true });

copyIfExists(join(repoRoot, "dist"), join(resourcesServer, "dist"));
copyIfExists(join(repoRoot, "skills"), join(resourcesServer, "skills"));

// The CLI reads its version from ../package.json and npm ci needs lockfile+manifest.
cpSync(join(repoRoot, "package.json"), join(resourcesServer, "package.json"));
cpSync(join(repoRoot, "package-lock.json"), join(resourcesServer, "package-lock.json"));

// Strip lifecycle scripts so `npm ci` here does not rerun repo-level hooks
// (e.g. the node-pty permission fix), while dependency install scripts
// such as better-sqlite3's prebuild download still run normally.
const serverPackageJson = JSON.parse(readFileSync(join(resourcesServer, "package.json"), "utf8"));
delete serverPackageJson.scripts;
serverPackageJson.name = "@alan512/localspace-server-runtime";
writeFileSync(
  join(resourcesServer, "package.json"),
  `${JSON.stringify(serverPackageJson, null, 2)}\n`,
);

console.log("installing production dependencies into resources/server ...");
const npmCommand = platform() === "win32" ? "npm.cmd" : "npm";
const ci = spawnSync(npmCommand, ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: resourcesServer,
  stdio: "inherit",
});
if (ci.status !== 0) fail("npm ci --omit=dev inside resources/server returned nonzero");

if (!skipNodeDownload) {
  await downloadNodeSidecar();
} else {
  console.log("skipping Node sidecar download (--skip-node-download)");
}

console.log("resources/server ready.");

async function downloadNodeSidecar() {
  const mirror = process.env.LOCALSPACE_NODE_MIRROR ?? "https://nodejs.org/dist";
  const explicitBinary = process.env.LOCALSPACE_DESKTOP_NODE_BIN;

  rmSync(resourcesBin, { recursive: true, force: true });
  mkdirSync(resourcesBin, { recursive: true });

  if (explicitBinary) {
    const targetName = platform() === "win32" ? "node.exe" : "node";
    cpSync(explicitBinary, join(resourcesBin, targetName));
    console.log(`copied LOCALSPACE_DESKTOP_NODE_BIN -> resources/bin/${targetName}`);
    return;
  }

  const version = await pickLatestV22(mirror);
  const asset = nodeAsset(version);
  const archivePath = join(resourcesDir, asset.fileName);

  console.log(`downloading Node v${version} (${asset.fileName}) ...`);
  await downloadFile(`${mirror}/v${version}/${asset.fileName}`, archivePath);

  // bsdtar (bundled with Windows 10+, macOS, most Linux) handles zip and tar.gz.
  const extract = spawnSync("tar", ["-xf", archivePath, "-C", resourcesDir], { stdio: "pipe" });
  if (extract.status !== 0) fail(`tar extraction failed: ${String(extract.stderr ?? "")}`);

  cpSync(join(resourcesDir, asset.innerPath), join(resourcesBin, platform() === "win32" ? "node.exe" : "node"));
  rmSync(archivePath, { force: true });
  rmSync(join(resourcesDir, asset.innerPath.split("/")[0] ?? ""), { recursive: true, force: true });
  console.log(`Node sidecar written to resources/bin/${platform() === "win32" ? "node.exe" : "node"}`);
}

async function pickLatestV22(mirror) {
  const indexUrl = `${mirror}/index.json`;
  const response = await fetch(indexUrl);
  if (!response.ok) fail(`cannot list Node versions at ${indexUrl}: HTTP ${response.status}`);
  const versions = await response.json();
  const latestV22 = versions.find((entry) => typeof entry.version === "string" && entry.version.startsWith("v22."));
  if (!latestV22?.version) fail("no Node v22 release found; set LOCALSPACE_DESKTOP_NODE_BIN instead");
  return latestV22.version.replace(/^v/, "");
}

function nodeAsset(version) {
  const plat = platform();
  const cpu = arch();
  const cpuDir = cpu === "arm64" ? "arm64" : "x64";
  if (plat === "win32") {
    const folder = `node-v${version}-win-${cpuDir}`;
    return { fileName: `${folder}.zip`, innerPath: `${folder}/node.exe` };
  }
  if (plat === "darwin" || plat === "linux") {
    const folder = `node-v${version}-${plat}-${cpuDir}`;
    return { fileName: `${folder}.tar.gz`, innerPath: `${folder}/bin/node` };
  }
  return fail(`unsupported platform: ${plat}`);
}

function downloadFile(url, destination) {
  return new Promise((resolvePromise, rejectPromise) => {
    fetch(url)
      .then(async (response) => {
        if (!response.ok || !response.body) {
          rejectPromise(new Error(`download failed: HTTP ${response.status} for ${url}`));
          return;
        }
        try {
          await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
          resolvePromise();
        } catch (error) {
          rejectPromise(error);
        }
      })
      .catch(rejectPromise);
  });
}
