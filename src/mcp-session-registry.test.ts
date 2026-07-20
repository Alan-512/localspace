import assert from "node:assert/strict";
import { McpSessionRegistry, type McpSessionRegistryEvent } from "./mcp-session-registry.js";

class FakeTransport {
  closed = 0;

  close(): void {
    this.closed += 1;
  }
}

{
  let now = 0;
  const events: McpSessionRegistryEvent[] = [];
  const registry = new McpSessionRegistry<FakeTransport>(
    { idleTtlMs: 100, cleanupIntervalMs: 0, maxSessions: 4 },
    (event) => events.push(event),
    { now: () => now },
  );

  const transport = new FakeTransport();
  registry.add("session-a", transport);
  now = 50;
  assert.equal(registry.get("session-a"), transport);
  now = 149;
  assert.equal(registry.sweepExpired(), 0);
  assert.equal(registry.size(), 1);

  now = 151;
  assert.equal(registry.sweepExpired(), 1);
  assert.equal(registry.get("session-a"), undefined);
  assert.equal(transport.closed, 1);
  assert.equal(registry.size(), 0);
  assert.equal(events.at(-1)?.reason, "idle_timeout");
}

{
  let now = 0;
  const registry = new McpSessionRegistry<FakeTransport>(
    { idleTtlMs: 1000, cleanupIntervalMs: 0, maxSessions: 2 },
    undefined,
    { now: () => now },
  );

  const a = new FakeTransport();
  const b = new FakeTransport();
  const c = new FakeTransport();

  registry.add("a", a);
  now = 1;
  registry.add("b", b);
  now = 2;
  assert.equal(registry.get("a"), a);
  now = 3;
  registry.add("c", c);

  assert.equal(a.closed, 0);
  assert.equal(b.closed, 1);
  assert.equal(c.closed, 0);
  assert.equal(registry.get("b"), undefined);
  assert.equal(registry.size(), 2);
}

{
  let now = 0;
  const events: McpSessionRegistryEvent[] = [];
  const registry = new McpSessionRegistry<FakeTransport>(
    { idleTtlMs: 1000, cleanupIntervalMs: 0, maxSessions: 4 },
    (event) => events.push(event),
    { now: () => now },
  );

  const transport = new FakeTransport();
  registry.add("client-session", transport);
  now = 10;
  assert.equal(registry.delete("client-session", "client_closed", { closeTransport: false }), true);

  assert.equal(transport.closed, 0);
  assert.equal(registry.size(), 0);
  assert.equal(events.at(-1)?.reason, "client_closed");
}

{
  const registry = new McpSessionRegistry<FakeTransport>(
    { idleTtlMs: 1000, cleanupIntervalMs: 0, maxSessions: 4 },
  );
  const a = new FakeTransport();
  const b = new FakeTransport();
  registry.add("a", a);
  registry.add("b", b);
  await registry.closeAll("server_shutdown");

  assert.equal(a.closed, 1);
  assert.equal(b.closed, 1);
  assert.equal(registry.size(), 0);
}

{
  let releaseClose: (() => void) | undefined;
  let closeFinished = false;
  const registry = new McpSessionRegistry<{ close(): Promise<void> }>(
    { idleTtlMs: 1000, cleanupIntervalMs: 0, maxSessions: 4 },
  );
  registry.add("async", {
    close: async () => {
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      closeFinished = true;
    },
  });

  const closing = registry.closeAll("server_shutdown");
  assert.equal(registry.size(), 0);
  assert.equal(closeFinished, false);
  releaseClose?.();
  await closing;
  assert.equal(closeFinished, true);
}
