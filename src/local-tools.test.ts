import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./local-tools.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "localspace-local-tools-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "localspace-local-tools-outside-"));

try {
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "ignored.txt\nignored-dir/\n", "utf8");
  await writeFile(join(root, "src", "alpha.ts"), "first\nexport const alpha = 1;\nlast\n", "utf8");
  await writeFile(join(root, "src", "nested", "beta.ts"), "export const beta = 'needle';\n", "utf8");
  await writeFile(join(root, "ignored.txt"), "needle\n", "utf8");
  await mkdir(join(root, "ignored-dir"));
  await writeFile(join(root, "ignored-dir", "hidden.ts"), "needle\n", "utf8");
  await git(root, ["init"]);
  await git(root, ["add", ".gitignore", "src/alpha.ts"]);

  const context = { cwd: root, root };

  const limitedRead = await readFileTool({ path: "src/alpha.ts", offset: 2, limit: 1 }, context);
  assert.equal(limitedRead.isError, undefined);
  assert.match(text(limitedRead), /^export const alpha = 1;/);
  assert.match(text(limitedRead), /2 more lines in file/);

  const write = await writeFileTool({ path: "generated/output.txt", content: "created\n" }, context);
  assert.equal(write.isError, undefined);
  assert.equal(await readFile(join(root, "generated", "output.txt"), "utf8"), "created\n");

  await writeFile(join(root, "src", "edit.ts"), "\uFEFFone\r\ntwo\r\nthree\r\n", "utf8");
  const edit = await editFileTool({
    path: "src/edit.ts",
    edits: [
      { oldText: "one\ntwo", newText: "ONE\nTWO" },
      { oldText: "three", newText: "THREE" },
    ],
  }, context);
  assert.equal(edit.isError, undefined);
  assert.match(edit.details?.patch ?? "", /ONE/);
  assert.equal(await readFile(join(root, "src", "edit.ts"), "utf8"), "\uFEFFONE\r\nTWO\r\nTHREE\r\n");

  await writeFile(join(root, "src", "duplicate.ts"), "same\nsame\n", "utf8");
  const duplicate = await editFileTool({
    path: "src/duplicate.ts",
    edits: [{ oldText: "same", newText: "changed" }],
  }, context);
  assert.equal(duplicate.isError, true);
  assert.match(text(duplicate), /not unique/);

  const grep = await grepFilesTool({ pattern: "needle", include: "**/*.ts" }, context);
  assert.equal(grep.isError, undefined);
  assert.match(text(grep), /src\/nested\/beta\.ts:1:/);
  assert.doesNotMatch(text(grep), /ignored/);

  const glob = await findFilesTool({ pattern: "src/**/*.ts" }, context);
  assert.equal(glob.isError, undefined);
  assert.match(text(glob), /src\/alpha\.ts/);
  assert.match(text(glob), /src\/nested\/beta\.ts/);
  assert.doesNotMatch(text(glob), /ignored-dir/);

  const listing = await listDirectoryTool({ path: "src" }, context);
  assert.equal(listing.isError, undefined);
  assert.match(text(listing), /nested\//);
  assert.match(text(listing), /alpha\.ts/);

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(join(root, "pixel.png"), png);
  const image = await readFileTool({ path: "pixel.png" }, context);
  assert.equal(image.isError, undefined);
  assert.equal(image.content.some((item) => item.type === "image" && item.mimeType === "image/png"), true);

  await writeFile(join(root, "not-an-image.png"), "plain text\n", "utf8");
  const fakeImage = await readFileTool({ path: "not-an-image.png" }, context);
  assert.equal(fakeImage.isError, undefined);
  assert.equal(fakeImage.content.some((item) => item.type === "image"), false);
  assert.match(text(fakeImage), /plain text/);

  if (platform() !== "win32") {
    await writeFile(join(outsideRoot, "outside.txt"), "outside\n", "utf8");
    await symlink(join(outsideRoot, "outside.txt"), join(root, "escape.txt"));
    const escapedRead = await readFileTool({ path: "escape.txt" }, context);
    assert.equal(escapedRead.isError, true);
    assert.match(text(escapedRead), /outside allowed roots/);
    const escapedWrite = await writeFileTool({ path: "escape.txt", content: "changed\n" }, context);
    assert.equal(escapedWrite.isError, true);
    assert.equal(await readFile(join(outsideRoot, "outside.txt"), "utf8"), "outside\n");
  }

  const shell = await runShellTool({ command: `node -e "console.log('native-shell')"` }, context);
  assert.equal(shell.isError, undefined);
  assert.match(text(shell), /native-shell/);

  const failedShell = await runShellTool({ command: `node -e "process.exit(3)"` }, context);
  assert.equal(failedShell.isError, true);
  assert.match(text(failedShell), /exited with code 3/);

  const largeShell = await runShellTool({
    command: `node -e "process.stdout.write('x'.repeat(70000))"`,
  }, context);
  assert.equal(largeShell.isError, undefined);
  assert.match(text(largeShell), /Output truncated/);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}

function text(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
