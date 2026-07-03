import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { findImports, findImportsData, findReferences, findReferencesData } from "./code-navigation.js";

const root = await mkdtemp(join(tmpdir(), "localspace-code-navigation-test-"));

try {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(
    join(root, "src", "main.ts"),
    [
      "import fs from 'node:fs';",
      "import { helper as renamedHelper } from './helper.js';",
      "import * as tools from './tools.js';",
      "export { renamedHelper };",
      "export const answer = renamedHelper();",
      "export default function run() {",
      "  return tools.wrap(answer);",
      "}",
      "async function lazy() {",
      "  return import('./lazy.js');",
      "}",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "helper.ts"),
    [
      "export function helper() {",
      "  return 42;",
      "}",
      "export type HelperResult = number;",
    ].join("\n"),
  );
  await writeFile(join(root, "node_modules", "ignored", "index.ts"), "import bad from 'bad';\n");

  const imports = await findImports(root, root);
  assert.match(imports, /src\/main\.ts:1 import from node:fs \{ default:fs \}/);
  assert.match(imports, /src\/main\.ts:2 import from \.\/helper\.js \{ helper as renamedHelper \}/);
  assert.match(imports, /src\/main\.ts:4 export \{ renamedHelper \}/);
  assert.match(imports, /src\/main\.ts:10 dynamic-import from \.\/lazy\.js/);
  assert.match(imports, /src\/helper\.ts:1 export \{ helper \}/);
  assert.doesNotMatch(imports, /bad/);

  const importsData = await findImportsData(root, root);
  assert.equal(importsData.summary.filesScanned, 2);
  assert.ok(importsData.text.includes("Files scanned: 2"));
  assert.ok(importsData.entries.some((entry) => entry.kind === "import" && entry.module === "./helper.js"));
  assert.ok(importsData.entries.some((entry) => entry.kind === "dynamic-import" && entry.module === "./lazy.js"));

  const refs = await findReferences(root, root, { query: "answer" });
  assert.match(refs, /src\/main\.ts:7:\d+ reference answer/);
  assert.doesNotMatch(refs, /definition answer/);

  const defs = await findReferences(root, root, { query: "answer", includeDefinitions: true });
  assert.match(defs, /definition answer/);
  assert.match(defs, /reference answer/);

  const refsData = await findReferencesData(root, root, { query: "answer", includeDefinitions: true });
  assert.equal(refsData.summary.query, "answer");
  assert.ok(refsData.references.some((ref) => ref.kind === "definition" && ref.name === "answer"));
  assert.ok(refsData.references.some((ref) => ref.kind === "reference" && ref.name === "answer"));

  const limited = await findReferences(root, root, { query: "renamedHelper", includeDefinitions: true, maxResults: 1 });
  assert.match(limited, /Results truncated: true/);

  await assert.rejects(
    () => findImports(root, join(root, "..")),
    /Path is outside workspace root/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
