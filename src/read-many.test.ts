import assert from "node:assert/strict";
import { readManyFiles } from "./read-many.js";

let active = 0;
let maxActive = 0;
const ordered = await readManyFiles(
  [
    { path: "slow.txt" },
    { path: "fast.txt", offset: 2, limit: 3 },
    { path: "missing.txt" },
  ],
  async (file) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(file.path === "slow.txt" ? 20 : 5);
    active -= 1;
    if (file.path === "missing.txt") {
      return { content: [{ type: "text", text: "ENOENT" }], isError: true };
    }
    return { content: [{ type: "text", text: file.path }] };
  },
  { concurrency: 2 },
);
assert.equal(maxActive, 2);
assert.deepEqual(ordered.results.map((result) => result.path), [
  "slow.txt",
  "fast.txt",
  "missing.txt",
]);
assert.equal(ordered.results[1]?.offset, 2);
assert.equal(ordered.results[1]?.limited, true);
assert.equal(ordered.summary.succeeded, 2);
assert.equal(ordered.summary.failed, 1);
assert.match(ordered.text, /## slow\.txt/);
assert.match(ordered.text, /Error: ENOENT/);

const bounded = await readManyFiles(
  [{ path: "a.txt" }, { path: "b.txt" }],
  async (file) => ({ content: [{ type: "text", text: file.path === "a.txt" ? "12345" : "67890" }] }),
  { maxTotalCharacters: 7 },
);
assert.equal(bounded.results[0]?.text, "12345");
assert.equal(bounded.results[1]?.text, "67");
assert.equal(bounded.results[1]?.truncated, true);
assert.equal(bounded.summary.characters, 7);
assert.equal(bounded.summary.truncated, 1);

const image = await readManyFiles(
  [{ path: "image.png" }],
  async () => ({ content: [{ type: "image", data: "abc", mimeType: "image/png" }] }),
);
assert.equal(image.results[0]?.success, false);
assert.match(image.results[0]?.error ?? "", /use read/);

await assert.rejects(
  readManyFiles([], async () => ({ content: [] })),
  /between 1 and 20/,
);

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
