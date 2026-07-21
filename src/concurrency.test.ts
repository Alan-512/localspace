import assert from "node:assert/strict";
import {
  AsyncReadWriteLock,
  AsyncSemaphore,
  KeyedMutex,
  KeyedResourceMap,
} from "./concurrency.js";

const semaphore = new AsyncSemaphore(2);
const first = await semaphore.acquire();
const second = await semaphore.acquire();
assert.equal(semaphore.activeCount, 2);
assert.equal(semaphore.queuedCount, 0);

let thirdAcquired = false;
const thirdPromise = semaphore.acquire().then((permit) => {
  thirdAcquired = true;
  return permit;
});
await delay(5);
assert.equal(thirdAcquired, false);
assert.equal(semaphore.queuedCount, 1);
first.release();
const third = await thirdPromise;
assert.equal(thirdAcquired, true);
assert.ok(third.queuedMs >= 0);
second.release();
third.release();
assert.equal(semaphore.activeCount, 0);

const timedSemaphore = new AsyncSemaphore(1);
const heldPermit = await timedSemaphore.acquire();
await assert.rejects(
  timedSemaphore.acquire({ timeoutMs: 5 }),
  /timed out/,
);
heldPermit.release();

const abortSemaphore = new AsyncSemaphore(1);
const abortHeld = await abortSemaphore.acquire();
const controller = new AbortController();
const aborted = abortSemaphore.acquire({ signal: controller.signal });
controller.abort();
await assert.rejects(aborted, { name: "AbortError" });
abortHeld.release();

const lock = new AsyncReadWriteLock();
const readerA = await lock.acquireRead();
const readerB = await lock.acquireRead();
assert.equal(lock.readerCount, 2);

const order: string[] = [];
const writerPromise = lock.acquireWrite().then((permit) => {
  order.push("writer");
  return permit;
});
const laterReaderPromise = lock.acquireRead().then((permit) => {
  order.push("later-reader");
  return permit;
});
await delay(5);
assert.deepEqual(order, []);
readerA.release();
readerB.release();
const writer = await writerPromise;
assert.deepEqual(order, ["writer"]);
writer.release();
const laterReader = await laterReaderPromise;
assert.deepEqual(order, ["writer", "later-reader"]);
laterReader.release();

const batchedReaders = new AsyncReadWriteLock();
const blockingWriter = await batchedReaders.acquireWrite();
const readOne = batchedReaders.acquireRead();
const readTwo = batchedReaders.acquireRead();
blockingWriter.release();
const [readPermitOne, readPermitTwo] = await Promise.all([readOne, readTwo]);
assert.equal(batchedReaders.readerCount, 2);
readPermitOne.release();
readPermitTwo.release();

let createdResources = 0;
const resources = new KeyedResourceMap(() => ({ id: ++createdResources }));
const resourceA = resources.acquire("a");
const resourceAAgain = resources.acquire("a");
const resourceB = resources.acquire("b");
assert.equal(resourceA.resource, resourceAAgain.resource);
assert.notEqual(resourceA.resource, resourceB.resource);
assert.equal(resources.size, 2);
resourceA.release();
resourceAAgain.release();
resourceB.release();
assert.equal(resources.size, 0);

const keyed = new KeyedMutex();
const keyAFirst = await keyed.acquire("a");
const keyB = await keyed.acquire("b");
let keyASecondAcquired = false;
const keyASecondPromise = keyed.acquire("a").then((permit) => {
  keyASecondAcquired = true;
  return permit;
});
await delay(5);
assert.equal(keyASecondAcquired, false);
assert.equal(keyed.keyCount, 2);
keyAFirst.release();
const keyASecond = await keyASecondPromise;
assert.equal(keyASecondAcquired, true);
keyB.release();
keyASecond.release();
assert.equal(keyed.keyCount, 0);

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
