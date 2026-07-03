import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { generateCodeMap, generateCodeMapData } from "./code-map.js";

const root = await mkdtemp(join(tmpdir(), "localspace-code-map-test-"));

try {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "code-map-fixture", main: "dist/server.js", scripts: { test: "node --test" } }, null, 2),
  );
  await writeFile(join(root, "src", "server.ts"), "export function createServer() { return true; }\n");
  await writeFile(join(root, "src", "cli.ts"), "import { createServer } from './server.js';\nexport function cli() { return createServer(); }\n");
  await writeFile(join(root, "README.md"), "# Fixture\n");

  const result = await generateCodeMap(root, root, { maxSymbols: 10, maxImports: 10 });
  assert.match(result, /Code map/);
  assert.match(result, /## Entrypoints/);
  assert.match(result, /name: code-map-fixture/);
  assert.match(result, /src\/server\.ts/);
  assert.match(result, /## Project structure/);
  assert.match(result, /## Exported symbols/);
  assert.match(result, /function exported createServer/);
  assert.match(result, /## Imports and exports/);
  assert.match(result, /src\/cli\.ts:1 import from \.\/server\.js/);

  const data = await generateCodeMapData(root, root, { maxSymbols: 10, maxImports: 10 });
  assert.equal(data.scope, ".");
  assert.equal(data.entrypoints.packageInfo?.name, "code-map-fixture");
  assert.ok(data.symbols.symbols.some((symbol) => symbol.name === "createServer"));
  assert.ok(data.imports.entries.some((entry) => entry.module === "./server.js"));
  assert.ok(data.text.includes("Code map"));
} finally {
  await rm(root, { recursive: true, force: true });
}
