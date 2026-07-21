import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { CodeIntelligenceManager } from "./code-intelligence.js";

const execFileAsync = promisify(execFile);

const root = await mkdtemp(join(tmpdir(), "localspace-code-intelligence-test-"));
const src = join(root, "src");
const lib = join(src, "lib");
await mkdir(lib, { recursive: true });

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as {
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
assert.equal(packageJson.devDependencies?.typescript, undefined);
assert.equal(packageJson.optionalDependencies?.typescript, "^6.0.3");

try {
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        ignoreDeprecations: "6.0",
        baseUrl: ".",
        paths: { "@lib/*": ["src/lib/*"] },
      },
      include: ["src/**/*.ts"],
    }, null, 2),
  );
  const greeterPath = join(lib, "greeter.ts");
  const personPath = join(src, "person.ts");
  const greeterText = [
    "export interface Greeter {",
    "  greet(name: string): string;",
    "}",
    "",
    "export function greet(name: string): string {",
    "  return `Hello ${name}`;",
    "}",
    "",
  ].join("\n");
  const personText = [
    'import { greet, type Greeter } from "@lib/greeter";',
    "",
    "export class Person implements Greeter {",
    "  greet(name: string): string {",
    "    return greet(name);",
    "  }",
    "}",
    "",
    "export const broken: string = 123;",
    "",
  ].join("\n");
  await writeFile(greeterPath, greeterText);
  await writeFile(personPath, personText);
  await writeFile(join(root, "README.md"), "fixture\n");

  const manager = new CodeIntelligenceManager();
  try {
    const diagnostics = await manager.diagnostics({ root, path: personPath });
    assert.equal(diagnostics.supported, true);
    assert.equal(diagnostics.project?.configPath, "tsconfig.json");
    assert.ok(diagnostics.diagnostics.some((item) => item.code === 2322));

    const tscPath = fileURLToPath(
      new URL("../node_modules/typescript/bin/tsc", import.meta.url),
    );
    let tscOutput = "";
    try {
      await execFileAsync(process.execPath, [
        tscPath,
        "--project",
        root,
        "--noEmit",
        "--pretty",
        "false",
      ]);
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      tscOutput = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
    }
    assert.match(tscOutput, /TS2322/);
    assert.equal(
      diagnostics.diagnostics.some((item) => tscOutput.includes(`TS${item.code}`)),
      true,
      "language-service diagnostics should overlap the real tsc error set",
    );

    const boundedManager = new CodeIntelligenceManager({ maxProjectFiles: 1 });
    const bounded = await boundedManager.diagnostics({ root, path: personPath });
    assert.equal(bounded.supported, false);
    assert.match(bounded.reason ?? "", /maximum is 1/);
    boundedManager.dispose();

    const definitionPosition = lineAndColumn(personText, "greet(name);", 0);
    const definitions = await manager.definitions({
      root,
      path: personPath,
      ...definitionPosition,
    });
    assert.equal(definitions.supported, true);
    assert.ok(definitions.locations.some((location) => location.path === "src/lib/greeter.ts"));

    const implementationPosition = lineAndColumn(greeterText, "Greeter", 0);
    const implementations = await manager.implementations({
      root,
      path: greeterPath,
      ...implementationPosition,
    });
    assert.equal(implementations.supported, true);
    assert.ok(implementations.locations.some((location) => location.path === "src/person.ts"));

    const renamePosition = lineAndColumn(greeterText, "greet(name", 0);
    const beforeGreeter = await readFile(greeterPath, "utf8");
    const beforePerson = await readFile(personPath, "utf8");
    const rename = await manager.renamePreview({
      root,
      path: greeterPath,
      ...renamePosition,
      newName: "welcome",
    });
    assert.equal(rename.supported, true);
    assert.equal(rename.canRename, true);
    assert.ok(rename.edits.some((edit) => edit.path === "src/lib/greeter.ts"));
    assert.ok(rename.edits.some((edit) => edit.path === "src/person.ts"));
    assert.equal(await readFile(greeterPath, "utf8"), beforeGreeter);
    assert.equal(await readFile(personPath, "utf8"), beforePerson);

    const invalidRename = await manager.renamePreview({
      root,
      path: greeterPath,
      ...renamePosition,
      newName: "not-valid",
    });
    assert.equal(invalidRename.supported, true);
    assert.equal(invalidRename.canRename, false);
    assert.match(invalidRename.reason ?? "", /not a valid TypeScript\/JavaScript identifier/);
    assert.equal(invalidRename.edits.length, 0);

    await writeFile(
      personPath,
      personText.replace("export const broken: string = 123;", 'export const broken: string = "fixed";'),
    );
    const refreshedDiagnostics = await manager.diagnostics({ root, path: personPath });
    assert.equal(
      refreshedDiagnostics.diagnostics.some((item) => item.code === 2322),
      false,
      "language-service snapshots must invalidate after a file changes",
    );

    const unsupported = await manager.diagnostics({
      root,
      path: join(root, "README.md"),
    });
    assert.equal(unsupported.supported, false);
    assert.match(unsupported.reason ?? "", /Unsupported source file type/);

    const noConfigRoot = join(root, "no-config");
    await mkdir(noConfigRoot);
    const noConfig = await manager.diagnostics({ root: noConfigRoot });
    assert.equal(noConfig.supported, false);
    assert.match(noConfig.reason ?? "", /No tsconfig\.json or jsconfig\.json/);

    const malformedConfigRoot = join(root, "malformed-config");
    await mkdir(malformedConfigRoot);
    await writeFile(
      join(malformedConfigRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "NOT_A_TARGET" },
        include: ["index.ts"],
      }, null, 2),
    );
    await writeFile(join(malformedConfigRoot, "index.ts"), "export const value = 1;\n");
    const malformedConfig = await manager.diagnostics({ root: malformedConfigRoot });
    assert.equal(malformedConfig.supported, true);
    assert.ok(malformedConfig.projectDiagnostics.length > 0);
    assert.ok(malformedConfig.summary.errors > 0);

    const unavailableManager = new CodeIntelligenceManager({
      loadTypeScript: async () => {
        throw new Error("simulated optional dependency omission");
      },
    });
    const unavailable = await unavailableManager.diagnostics({ root, path: personPath });
    assert.equal(unavailable.supported, false);
    assert.match(unavailable.reason ?? "", /TypeScript code intelligence is unavailable/);
    assert.match(unavailable.reason ?? "", /simulated optional dependency omission/);
    unavailableManager.dispose();

    const referencesRoot = join(root, "references");
    const referencedLib = join(referencesRoot, "packages", "lib");
    const referencedApp = join(referencesRoot, "packages", "app");
    await mkdir(join(referencedLib, "src"), { recursive: true });
    await mkdir(join(referencedApp, "src"), { recursive: true });
    await writeFile(
      join(referencesRoot, "tsconfig.json"),
      JSON.stringify({
        files: [],
        references: [
          { path: "./packages/lib" },
          { path: "./packages/app" },
        ],
      }, null, 2),
    );
    await writeFile(
      join(referencedLib, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        include: ["src/**/*.ts"],
      }, null, 2),
    );
    await writeFile(
      join(referencedApp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        references: [{ path: "../lib" }],
        include: ["src/**/*.ts"],
      }, null, 2),
    );
    const referencedLibText = "export function sharedValue(): string { return 'shared'; }\n";
    const referencedAppText = [
      'import { sharedValue } from "../../lib/src/index";',
      "export const value = sharedValue();",
      "",
    ].join("\n");
    const referencedLibPath = join(referencedLib, "src", "index.ts");
    const referencedAppPath = join(referencedApp, "src", "index.ts");
    await writeFile(referencedLibPath, referencedLibText);
    await writeFile(referencedAppPath, referencedAppText);

    const solutionDiagnostics = await manager.diagnostics({ root: referencesRoot });
    assert.equal(solutionDiagnostics.supported, true);
    assert.deepEqual(solutionDiagnostics.project?.projectReferences, [
      "packages/lib/tsconfig.json",
      "packages/app/tsconfig.json",
    ]);

    const referencedDefinition = await manager.definitions({
      root: referencesRoot,
      path: referencedAppPath,
      ...lineAndColumn(referencedAppText, "sharedValue();", 0),
    });
    assert.ok(
      referencedDefinition.locations.some(
        (location) => location.path === "packages/lib/src/index.ts",
      ),
      "project-reference callers should resolve source definitions inside the workspace",
    );
  } finally {
    manager.dispose();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

function lineAndColumn(text: string, search: string, occurrence: number): {
  line: number;
  column: number;
} {
  let index = -1;
  for (let current = 0; current <= occurrence; current += 1) {
    index = text.indexOf(search, index + 1);
    assert.notEqual(index, -1, `missing search text: ${search}`);
  }
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}
