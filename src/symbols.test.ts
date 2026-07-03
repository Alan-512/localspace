import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { findSymbols, findSymbolsData } from "./symbols.js";

const root = await mkdtemp(join(tmpdir(), "localspace-symbols-test-"));

try {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(
    join(root, "src", "sample.ts"),
    [
      "export interface Person { name: string }",
      "type LocalType = string;",
      "export type PublicType = number;",
      "export enum Role { Admin }",
      "export const answer = 42;",
      "const hidden = true;",
      "export function greet(name: string) { return name; }",
      "function helper() { return 'helper'; }",
      "export class Service {",
      "  run() { return true; }",
      "  private stop() { return false; }",
      "}",
    ].join("\n"),
  );
  await writeFile(join(root, "node_modules", "ignored", "index.ts"), "export function ignored() {}\n");

  const all = await findSymbols(root, root);
  assert.match(all, /src\/sample\.ts:1 interface exported Person/);
  assert.match(all, /src\/sample\.ts:2 type LocalType/);
  assert.match(all, /src\/sample\.ts:5 variable exported answer/);
  assert.match(all, /src\/sample\.ts:7 function exported greet/);
  assert.match(all, /src\/sample\.ts:9 class exported Service/);
  assert.match(all, /src\/sample\.ts:10 method exported Service\.run/);
  assert.doesNotMatch(all, /ignored/);

  const allData = await findSymbolsData(root, root, { includeNonExported: false });
  assert.equal(allData.summary.filesScanned, 1);
  assert.equal(allData.summary.truncatedResults, false);
  assert.ok(allData.text.includes("Files scanned: 1"));
  assert.ok(allData.symbols.some((symbol) => symbol.name === "greet" && symbol.kind === "function" && symbol.exported));
  assert.ok(allData.symbols.every((symbol) => symbol.exported));

  const exportedOnly = await findSymbols(root, root, { includeNonExported: false });
  assert.match(exportedOnly, /PublicType/);
  assert.doesNotMatch(exportedOnly, /LocalType/);
  assert.doesNotMatch(exportedOnly, /hidden/);

  const query = await findSymbols(root, root, { query: "greet" });
  assert.match(query, /greet/);
  assert.doesNotMatch(query, /Service/);

  const methods = await findSymbols(root, root, { kind: "method" });
  assert.match(methods, /Service\.run/);
  assert.match(methods, /Service\.stop/);
  assert.doesNotMatch(methods, /function exported greet/);

  const limited = await findSymbols(root, root, { maxResults: 1 });
  assert.match(limited, /Results truncated: true/);

  const fileOnly = await findSymbols(root, join(root, "src", "sample.ts"), { query: "Person" });
  assert.match(fileOnly, /Files scanned: 1/);
  assert.match(fileOnly, /Person/);

  await assert.rejects(
    () => findSymbols(root, join(root, ".."), {}),
    /Path is outside workspace root/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
