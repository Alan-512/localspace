// Resumable parallel downloader for the Electron binary, for networks where a
// single connection to GitHub releases is throttled (common in CN networks).
//
//   node scripts/fetch-electron.mjs
//
// Reads the electron version from node_modules/electron/package.json, downloads
// the platform zip/tarball in N parallel resumable segments into
// resources/electron-cache/, verifies the total size, extracts it into
// node_modules/electron/dist/ and writes path.txt — the same end state as the
// package's own postinstall script.
//
// Env overrides:
//   LOCALSPACE_ELECTRON_MIRROR  base mirror (default github releases)
//   LOCALSPACE_ELECTRON_SEGMENTS  parallel segment count (default 4)
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const electronPackageDir = join(desktopRoot, "..", "node_modules", "electron");
const cacheDir = join(desktopRoot, "..", "resources", "electron-cache");
const distDir = join(electronPackageDir, "dist");

function fail(message) {
  console.error(`fetch-electron failed: ${message}`);
  process.exit(1);
}

const { version } = JSON.parse(
  await import("node:fs").then((fs) => fs.readFileSync(join(electronPackageDir, "package.json"), "utf8")),
);

function assetFor(versionString) {
  const plat = platform();
  const cpu = arch();
  const cpuDir = cpu === "arm64" ? "arm64" : "x64";
  if (plat === "win32") {
    const folder = `electron-v${versionString}-win32-${cpuDir}`;
    return { fileName: `${folder}.zip`, innerBinary: "electron.exe", pathTxt: "electron.exe" };
  }
  if (plat === "darwin") {
    const folder = `electron-v${versionString}-darwin-${cpuDir}`;
    return { fileName: `${folder}.zip`, innerBinary: `${folder}/Electron.app/Contents/MacOS/Electron`, pathTxt: "Electron.app/Contents/MacOS/Electron" };
  }
  if (plat === "linux") {
    const folder = `electron-v${versionString}-linux-${cpuDir}`;
    return { fileName: `${folder}.zip`, innerBinary: `${folder}/electron`, pathTxt: "electron" };
  }
  return fail(`unsupported platform: ${plat}`);
}

const asset = assetFor(version);
const mirror =
  process.env.LOCALSPACE_ELECTRON_MIRROR ?? "https://github.com/electron/electron/releases/download";
const url = `${mirror}/v${version}/${asset.fileName}`;

const segments = Number(process.env.LOCALSPACE_ELECTRON_SEGMENTS ?? 4);
if (!Number.isInteger(segments) || segments < 1 || segments > 16) fail("invalid segment count");

async function headTotalSize() {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) fail(`HEAD ${url} -> HTTP ${response.status}`);
  const length = response.headers.get("content-length");
  if (!length) fail("server did not report content-length");
  return Number(length);
}

function segmentPath(index) {
  return join(cacheDir, `${asset.fileName}.part${index}`);
}

async function downloadSegment(index, start, end) {
  const filePath = segmentPath(index);
  let offset = existsSync(filePath) ? statSync(filePath).size : 0;
  if (offset > end - start + 1) fail(`segment ${index} larger than expected; delete ${filePath}`);

  while (offset <= end - start) {
    const rangeStart = start + offset;
    const response = await fetch(url, { headers: { Range: `bytes=${rangeStart}-${end}` } });
    if (!response.ok && response.status !== 206) {
      fail(`segment ${index} HTTP ${response.status}`);
    }
    const stream = createWriteStream(filePath, { flags: "a" });
    await new Promise((resolvePromise, rejectPromise) => {
      pipeline(Readable.fromWeb(response.body), stream)
        .then(resolvePromise)
        .catch(rejectPromise);
    });
    offset = statSync(filePath).size;
    process.stdout.write(`\rsegment ${index + 1}/${segments}: ${Math.round((offset / (end - start + 1)) * 100)}%`);
  }
  process.stdout.write("\n");
}

console.log(`electron v${version} (${asset.fileName}) in ${segments} segments from ${mirror}`);
mkdirSync(cacheDir, { recursive: true });
const totalSize = await headTotalSize();
const chunkSize = Math.ceil(totalSize / segments);

const archivePath = join(cacheDir, asset.fileName);
const preDownloaded =
  existsSync(archivePath) && statSync(archivePath).size === totalSize;

if (preDownloaded) {
  console.log(`archive already present in cache (${totalSize} bytes); skipping download`);
} else {
  await Promise.all(
    Array.from({ length: segments }, (_, index) => {
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalSize - 1);
      return start > end ? Promise.resolve() : downloadSegment(index, start, end);
    }),
  );

  const downloadedBytes = Array.from({ length: segments }, (_, index) =>
    statSync(segmentPath(index)).size,
  ).reduce((sum, size) => sum + size, 0);
  if (downloadedBytes !== totalSize) {
    fail(`assembled size ${downloadedBytes} != expected ${totalSize}; rerun to resume`);
  }

  // Assemble and extract.
  const { appendFileSync, rmSync } = await import("node:fs");
  rmSync(archivePath, { force: true });
  for (let index = 0; index < segments; index += 1) {
    const data = await import("node:fs").then((fs) => fs.readFileSync(segmentPath(index)));
    appendFileSync(archivePath, data);
  }
}

const list = spawnSync("tar", ["-tf", archivePath], { encoding: "utf8" });
if (list.status !== 0) fail(`archive is corrupt (tar -tf failed): ${String(list.stderr ?? "")}`);

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
const extract = spawnSync("tar", ["-xf", archivePath, "-C", distDir], { stdio: "pipe" });
if (extract.status !== 0) fail(`extraction failed: ${String(extract.stderr ?? "")}`);
writeFileSync(join(electronPackageDir, "path.txt"), asset.pathTxt);

console.log(`installed to node_modules/electron/dist (path.txt -> ${asset.pathTxt})`);
