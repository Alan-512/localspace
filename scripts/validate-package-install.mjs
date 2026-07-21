import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoot = await mkdtemp(join(tmpdir(), "localspace-package-install-"));

try {
  const pack = runNpm(["pack", "--pack-destination", temporaryRoot, "--json"]);
  const report = JSON.parse(pack.stdout);
  const tarballName = report[0]?.filename;
  if (!tarballName) throw new Error("npm pack did not return a tarball filename.");
  const tarball = join(temporaryRoot, tarballName);
  const installRoot = join(temporaryRoot, "install");
  await mkdir(installRoot, { recursive: true });
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
    "utf8",
  );
  runNpm(["install", tarball, "--no-audit", "--no-fund"], installRoot);

  const installedRoot = join(installRoot, "node_modules", "@alan512", "localspace");
  assertExists(join(installedRoot, "dist", "local-tools.js"));
  assertMissing(join(installedRoot, "dist", "pi-tools.js"));
  for (const dependencyPath of [
    ["@earendil-works", "pi-coding-agent"],
    ["@earendil-works", "pi-agent-core"],
    ["@earendil-works", "pi-ai"],
    ["@google", "genai"],
    ["protobufjs"],
  ]) {
    assertMissing(join(installRoot, "node_modules", ...dependencyPath));
  }

  const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  if (installedPackage.dependencies?.["@earendil-works/pi-coding-agent"]) {
    throw new Error("Packed LocalSpace still declares pi-coding-agent.");
  }
  const version = run(process.execPath, [join(installedRoot, "dist", "cli.js"), "version"], installRoot);
  if (!version.stdout.includes(installedPackage.version)) {
    throw new Error(`Installed CLI version check failed: ${version.stdout.trim()}`);
  }

  console.log(JSON.stringify({
    package: installedPackage.name,
    version: installedPackage.version,
    tarball: tarballName,
    nativeRuntime: true,
    piRuntime: false,
  }, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} exited with ${result.status ?? "signal"}.`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function runNpm(args, cwd = process.cwd()) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return run(process.execPath, [npmCli, ...args], cwd);
  if (process.platform === "win32") {
    const npmCommand = ["npm", ...args].map(quoteWindowsArgument).join(" ");
    return run(process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", npmCommand], cwd);
  }
  return run("npm", args, cwd);
}

function quoteWindowsArgument(value) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value)
    ? value
    : `"${String(value).replaceAll('"', '\\"')}"`;
}

function assertExists(path) {
  if (!existsSync(path)) throw new Error(`Expected packaged path: ${path}`);
}

function assertMissing(path) {
  if (existsSync(path)) throw new Error(`Unexpected packaged dependency or path: ${path}`);
}
