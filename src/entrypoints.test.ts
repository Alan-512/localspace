import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { findEntrypoints, findEntrypointsData } from "./entrypoints.js";

const root = await mkdtemp(join(tmpdir(), "localspace-entrypoints-test-"));

try {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "cli.ts"), "export function cli() {}\n");
  await writeFile(join(root, "src", "server.ts"), "export function server() {}\n");
  await writeFile(join(root, "src", "index.ts"), "export * from './server.js';\n");
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await writeFile(join(root, "vite.config.ts"), "export default {};\n");
  await writeFile(join(root, "AGENTS.md"), "# Instructions\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "entrypoint-fixture",
        type: "module",
        main: "dist/server.js",
        types: "dist/server.d.ts",
        bin: { fixture: "dist/cli.js" },
        exports: {
          ".": "./dist/index.js",
          "./server": { import: "./dist/server.js", types: "./dist/server.d.ts" },
        },
        scripts: {
          build: "tsc -p tsconfig.build.json",
          dev: "tsx src/cli.ts",
          test: "node --test",
          typecheck: "tsc --noEmit",
        },
      },
      null,
      2,
    ),
  );

  const result = await findEntrypoints(root);
  assert.match(result, /Package:/);
  assert.match(result, /name: entrypoint-fixture/);
  assert.match(result, /main: dist\/server\.js/);
  assert.match(result, /fixture: dist\/cli\.js/);
  assert.match(result, /Suggested verification:/);
  assert.match(result, /npm run typecheck/);
  assert.match(result, /src\/server\.ts \(package main; package types; package exports/);
  assert.match(result, /src\/cli\.ts \(package bin fixture/);
  assert.match(result, /src\/index\.ts \(package exports; common source entrypoint/);
  assert.match(result, /tsconfig\.json/);
  assert.match(result, /vite\.config\.ts/);
  assert.match(result, /AGENTS\.md/);

  const data = await findEntrypointsData(root);
  assert.equal(data.packageInfo?.name, "entrypoint-fixture");
  assert.equal(data.packageInfo?.bin[0]?.path, "dist/cli.js");
  assert.ok(data.scripts.some((script) => script.name === "typecheck"));
  assert.deepEqual(data.suggestedVerification, ["npm run typecheck", "npm run test", "npm run build"]);
  assert.ok(data.sourceEntrypoints.some((entry) => entry.path === "src/server.ts"));
  assert.ok(data.configFiles.includes("vite.config.ts"));
} finally {
  await rm(root, { recursive: true, force: true });
}
