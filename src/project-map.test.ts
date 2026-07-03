import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { generateProjectMap } from "./project-map.js";

const root = await mkdtemp(join(tmpdir(), "localspace-project-map-test-"));

try {
  await mkdir(join(root, "src", "ui"), { recursive: true });
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await mkdir(join(root, "dist"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, ".hidden-dir"));
  await writeFile(join(root, "README.md"), "hello\n");
  await writeFile(join(root, "src", "server.ts"), "export {};\n");
  await writeFile(join(root, "src", "config.ts"), "export {};\n");
  await writeFile(join(root, "src", "ui", "app.tsx"), "export {};\n");
  await writeFile(join(root, ".env"), "SECRET=1\n");
  await writeFile(join(root, "node_modules", "ignored", "package.json"), "{}\n");
  await writeFile(join(root, "dist", "server.js"), "\n");

  const basic = await generateProjectMap(root, root, { depth: 3 });
  assert.match(basic, /^\./);
  assert.match(basic, /src\//);
  assert.match(basic, /server\.ts/);
  assert.match(basic, /README\.md/);

  const shallow = await generateProjectMap(root, root, { depth: 1 });
  assert.match(shallow, /src\//);
  assert.doesNotMatch(shallow, /server\.ts/);

  const limited = await generateProjectMap(root, root, { maxEntries: 2 });
  assert.match(limited, /truncated after 2 entries/);

  const directoriesOnly = await generateProjectMap(root, root, { includeFiles: false });
  assert.match(directoriesOnly, /src\//);
  assert.doesNotMatch(directoriesOnly, /README\.md/);

  const noHidden = await generateProjectMap(root, root, { showHidden: false });
  assert.doesNotMatch(noHidden, /\.env/);
  assert.doesNotMatch(noHidden, /\.hidden-dir/);

  const skipDefaults = await generateProjectMap(root, root, { showHidden: true });
  assert.doesNotMatch(skipDefaults, /node_modules/);
  assert.doesNotMatch(skipDefaults, /dist\//);
  assert.doesNotMatch(skipDefaults, /\.git\//);

  await assert.rejects(
    () => generateProjectMap(root, join(root, ".."), {}),
    /Path is outside workspace root/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
