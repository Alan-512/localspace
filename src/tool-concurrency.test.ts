import assert from "node:assert/strict";
import { ToolConcurrencyScheduler } from "./tool-concurrency.js";
import { toolNames } from "./tool-catalog.js";

const config = {
  maxConcurrentToolCalls: 4,
  maxConcurrentScans: 1,
  maxConcurrentProcesses: 2,
  maxWorkspaceProcesses: 1,
  queueTimeoutMs: 1_000,
};
const scheduler = new ToolConcurrencyScheduler(config, {
  workspaceKey: (workspaceId) => workspaceId === "ws_alias" ? "root-a" : workspaceId,
});

const processOne = await scheduler.acquire(toolNames.execCommand, { workspaceId: "root-process" });
let processTwoAcquired = false;
const processTwoPromise = scheduler.acquire(toolNames.execCommand, { workspaceId: "root-process" })
  .then((permit) => {
    processTwoAcquired = true;
    return permit;
  });
await delay(5);
assert.equal(processTwoAcquired, false);
processOne.release();
const processTwo = await processTwoPromise;
assert.equal(processTwoAcquired, true);
processTwo.release();

const readOne = await scheduler.acquire(toolNames.read, { workspaceId: "root-a" });
const readTwo = await scheduler.acquire(toolNames.grep, { workspaceId: "ws_alias" });
readOne.release();
readTwo.release();

const blockingRead = await scheduler.acquire(toolNames.read, { workspaceId: "root-a" });
let writeAcquired = false;
const writePromise = scheduler.acquire(toolNames.applyPatch, { workspaceId: "ws_alias" })
  .then((permit) => {
    writeAcquired = true;
    return permit;
  });
await delay(5);
assert.equal(writeAcquired, false);
blockingRead.release();
const writePermit = await writePromise;
assert.equal(writeAcquired, true);
assert.ok((writePermit.waits["workspace-write"] ?? 0) >= 0);
writePermit.release();

const gitWrite = await scheduler.acquire(toolNames.gitAdd, { workspaceId: "root-a" });
let secondGitWriteAcquired = false;
const secondGitWritePromise = scheduler.acquire(toolNames.gitCommit, { workspaceId: "ws_alias" })
  .then((permit) => {
    secondGitWriteAcquired = true;
    return permit;
  });
await delay(5);
assert.equal(secondGitWriteAcquired, false);
gitWrite.release();
const secondGitWrite = await secondGitWritePromise;
assert.equal(secondGitWriteAcquired, true);
secondGitWrite.release();

const heavyOne = await scheduler.acquire(toolNames.symbols, { workspaceId: "root-a" });
let heavyTwoAcquired = false;
const heavyTwoPromise = scheduler.acquire(toolNames.imports, { workspaceId: "root-b" })
  .then((permit) => {
    heavyTwoAcquired = true;
    return permit;
  });
await delay(5);
assert.equal(heavyTwoAcquired, false);
heavyOne.release();
const heavyTwo = await heavyTwoPromise;
assert.equal(heavyTwoAcquired, true);
heavyTwo.release();

const sessionOne = await scheduler.acquire(toolNames.writeStdin, {
  workspaceId: "root-a",
  sessionId: 42,
});
let sessionTwoAcquired = false;
const sessionTwoPromise = scheduler.acquire(toolNames.writeStdin, {
  workspaceId: "root-a",
  sessionId: 42,
}).then((permit) => {
  sessionTwoAcquired = true;
  return permit;
});
const otherSession = await scheduler.acquire(toolNames.writeStdin, {
  workspaceId: "root-a",
  sessionId: 43,
});
await delay(5);
assert.equal(sessionTwoAcquired, false);
otherSession.release();
sessionOne.release();
const sessionTwo = await sessionTwoPromise;
assert.equal(sessionTwoAcquired, true);
sessionTwo.release();

const checkoutOpen = await scheduler.acquire(toolNames.openWorkspace, { mode: "checkout" });
let worktreeOpenAcquired = false;
const worktreeOpenPromise = scheduler.acquire(toolNames.openWorkspace, { mode: "worktree" })
  .then((permit) => {
    worktreeOpenAcquired = true;
    return permit;
  });
await delay(5);
assert.equal(worktreeOpenAcquired, false);
checkoutOpen.release();
const worktreeOpen = await worktreeOpenPromise;
assert.equal(worktreeOpenAcquired, true);
assert.ok(worktreeOpen.waits["global-execution"] !== undefined);
worktreeOpen.release();

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
