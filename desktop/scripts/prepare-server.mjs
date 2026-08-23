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
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url)); // desktop/scripts
const desktopDir = join(scriptDir, ".."); // desktop/
const repoRoot = join(desktopDir, ".."); // repository root
const resourcesServer = join(desktopDir, "resources", "server");
const resourcesBin = join(desktopDir, "resources", "bin");
const resourcesDir = join(desktopDir, "resources");
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

// Resolve the Node sidecar FIRST: native modules (better-sqlite3) must be built
// for the ABI of the Node that will run the server, not the one running this script.
const sidecar = await ensureNodeSidecar();

console.log("installing production dependencies into resources/server ...");
const ciArgs = ["ci", "--omit=dev", "--no-audit", "--no-fund"];
// prebuild-install reads npm_config_target from the environment and fetches
// the native build matching the sidecar's ABI, not this script's Node.
const ciEnv = sidecar.version
  ? { ...process.env, npm_config_target: sidecar.version }
  : process.env;
// Spawn npm-cli.js through Node itself: modern Node refuses to exec .cmd
// shims without a shell, which made npm.cmd fail silently here.
const ci = spawnSync(sidecar.binary, [sidecar.npmCli, ...ciArgs], {
  cwd: resourcesServer,
  env: ciEnv,
  stdio: "inherit",
});
if (ci.status !== 0) fail("npm ci --omit=dev inside resources/server returned nonzero");

console.log("resources/server ready.");

/**
 * Places the sidecar binary into resources/bin and returns its Node version,
 * or null when no sidecar is being bundled (--skip-node-download without an
 * explicit binary): dependencies then target the current process's Node.
 */
async function ensureNodeSidecar() {
  const mirror = process.env.LOCALSPACE_NODE_MIRROR ?? "https://nodejs.org/dist";
  const explicitBinary = process.env.LOCALSPACE_DESKTOP_NODE_BIN;

  rmSync(resourcesBin, { recursive: true, force: true });
  mkdirSync(resourcesBin, { recursive: true });

  if (explicitBinary || true) {
    // Resolve leniently: shells may hand us a directory, an exe, or nothing useful.
    const candidates = [explicitBinary, process.execPath].filter(Boolean);
    let resolved = null;
    for (const entry of candidates) {
      try {
        const stats = statSync(entry);
        if (stats.isFile()) {
          resolved = entry;
          break;
        }
        if (stats.isDirectory()) {
          const inner = join(entry, platform() === "win32" ? "node.exe" : "node");
          if (existsSync(inner)) {
            resolved = inner;
            break;
          }
        }
      } catch {
        // Try the next candidate.
      }
    }
    if (!resolved) fail("LOCALSPACE_DESKTOP_NODE_BIN does not point to a usable Node binary");

    const targetName = platform() === "win32" ? "node.exe" : "node";
    const sidecarBinary = join(resourcesBin, targetName);
    cpSync(resolved, sidecarBinary);
    const probe = spawnSync(sidecarBinary, ["--version"], { encoding: "utf8" });
    const detected = String(probe.stdout ?? "").trim().replace(/^v/, "");
    console.log(`copied ${resolved} -> resources/bin/${targetName} (${detected || "version unknown"})`);
    const npmCli =
      npmCliNextTo(resolved) ?? npmCliNextTo(process.execPath) ??
      fail(`npm-cli.js not found next to ${resolved} or ${process.execPath}`);
    return { version: detected || null, binary: sidecarBinary, npmCli };
  }

  if (skipNodeDownload) {
    console.log("skipping Node sidecar download (--skip-node-download)");
    const npmCli =
      npmCliNextTo(process.execPath) ??
      fail(`npm-cli.js not found next to ${process.execPath}`);
    return { version: null, binary: process.execPath, npmCli };
  }

  const version = await pickLatestV22(mirror);
  const asset = nodeAsset(version);
  const archivePath = join(resourcesDir, asset.fileName);

  console.log(`downloading Node v${version} (${asset.fileName}) ...`);
  await downloadFile(`${mirror}/v${version}/${asset.fileName}`, archivePath);

  // bsdtar (bundled with Windows 10+, macOS, most Linux) handles zip and tar.gz.
  const extract = spawnSync("tar", ["-xf", archivePath, "-C", resourcesDir], { stdio: "pipe" });
  if (extract.status !== 0) fail(`tar extraction failed: ${String(extract.stderr ?? "")}`);

  const extractedRoot = join(resourcesDir, asset.innerPath.split("/")[0] ?? "");
  cpSync(join(extractedRoot, "node.exe"), join(resourcesBin, "node.exe"));
  cpSync(join(extractedRoot, "node_modules", "npm"), join(resourcesBin, "node_modules", "npm"), {
    recursive: true,
  });
  rmSync(archivePath, { force: true });
  rmSync(extractedRoot, { recursive: true, force: true });
  console.log(`Node sidecar written to resources/bin/${platform() === "win32" ? "node.exe" : "node"}`);
  return {
    version,
    binary: join(resourcesBin, platform() === "win32" ? "node.exe" : "node"),
    npmCli: join(resourcesBin, "node_modules", "npm", "bin", "npm-cli.js"),
  };
}

function npmCliNextTo(binaryPath) {
  const candidate = join(dirname(binaryPath), "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(candidate) ? candidate : null;
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
