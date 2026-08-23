import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  ServiceBusyError,
  ServiceManager,
  type HealthProbe,
  type ServiceChild,
} from "./service-manager.js";
import type { RuntimePaths } from "./runtime-paths.js";

const paths: RuntimePaths = {
  nodeExecutable: "node",
  serverRoot: "/tmp/server",
  cliScript: "/tmp/server/dist/cli.js",
};

function makeStream(): EventEmitter & { setEncoding(encoding: string): unknown } {
  const stream = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): unknown };
  stream.setEncoding = () => undefined;
  return stream;
}

class FakeChild implements Partial<ServiceChild> {
  readonly pid = 4321;
  readonly stdout = makeStream();
  readonly stderr = makeStream();
  exited = false;
  killCalled = false;
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];

  on(event: "exit" | "error", listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): unknown {
    if (event === "error") {
      this.errorListeners.push(listener as (error: Error) => void);
    } else {
      this.exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    }
    return this;
  }

  kill(): boolean {
    if (this.exited) return false;
    this.killCalled = true;
    this.emitExit(null, "SIGTERM");
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

interface Harness {
  manager: ServiceManager;
  children: FakeChild[];
  logLines: Array<{ stream: string; line: string }>;
  statuses: Array<string>;
}

function createHarness(options?: { succeedAfter?: number }): Harness {
  const children: FakeChild[] = [];
  let probeCount = 0;
  const succeedAfter = options?.succeedAfter ?? 0;
  const logLines: Array<{ stream: string; line: string }> = [];
  const statuses: Array<string> = [];

  const probeHealth: HealthProbe = async () => {
    probeCount += 1;
    return probeCount > succeedAfter;
  };

  const manager = new ServiceManager({
    paths,
    log: (stream, line) => logLines.push({ stream, line }),
    readPort: () => 7788,
    spawnChild: (command, args) => {
      void command;
      void args;
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ServiceChild;
    },
    probeHealth,
    healthPollIntervalMs: 5,
    healthTimeoutMs: 300,
    stopGraceMs: 50,
  });
  manager.onStatusChange((status) => statuses.push(status.state));

  return { manager, children, logLines, statuses };
}

async function main(): Promise<void> {
  // successful start reaches running and streams output lines
  {
    const harness = createHarness({ succeedAfter: 2 });
    const finalStatus = await harness.manager.start();

    assert.equal(finalStatus.state, "running");
    assert.equal(finalStatus.pid, 4321);
    assert.equal(finalStatus.port, 7788);
    assert.equal(harness.statuses[0], "starting");
    assert.equal(harness.statuses[harness.statuses.length - 1], "running");

    (harness.children[0] as FakeChild).stdout.emit("data", "localspace listening\nsecond line\npart");
    await delay(10);
    assert.deepEqual(
      harness.logLines.map((entry) => entry.line),
      // The trailing fragment without a newline stays buffered until more data arrives.
      ["localspace listening", "second line"],
    );

    await assert.rejects(() => harness.manager.start(), ServiceBusyError);

    const stopStatus = await harness.manager.stop();
    assert.equal(stopStatus.state, "stopped");
  }

  // unhealthy server times out, reports an error, and kills the child
  {
    const harness = createHarness({ succeedAfter: Number.POSITIVE_INFINITY });
    const finalStatus = await harness.manager.start();

    assert.equal(finalStatus.state, "error");
    assert.match(finalStatus.error ?? "", /did not become healthy/);
    assert.ok(harness.children.every((child) => child.killCalled || child.exited));
  }

  // unexpected crash surfaces an error status
  {
    const harness = createHarness();
    await harness.manager.start();

    harness.children[0]?.emitExit(1, null);

    assert.equal(harness.manager.status.state, "error");
    assert.match(harness.manager.status.error ?? "", /exited unexpectedly/);
  }

  // intentional stop during startup does not become an error
  {
    const harness = createHarness({ succeedAfter: Number.POSITIVE_INFINITY });
    const startPromise = harness.manager.start();
    await delay(20);
    const stopStatus = await harness.manager.stop();
    await startPromise;

    assert.equal(stopStatus.state, "stopped");
    assert.notEqual(harness.manager.status.state, "error");
  }

  // restart recovers from an error state
  {
    const harness = createHarness();
    await harness.manager.start();
    harness.children[0]?.emitExit(2, null);
    assert.equal(harness.manager.status.state, "error");

    const restarted = await harness.manager.restart();
    assert.equal(restarted.state, "running");
    assert.equal(harness.children.length, 2);
  }

  // a spawn failure (e.g. ENOENT from the sidecar binary) becomes an error state, not a crash
  {
    // Probes never succeed so the health wait keeps polling until the error lands.
    const harness = createHarness({ succeedAfter: Number.POSITIVE_INFINITY });
    const startPromise = harness.manager.start();
    // Node emits 'error' without any 'exit' event when a spawn itself fails.
    harness.children[0]?.emitError(new Error("spawn node.exe ENOENT"));

    const result = await startPromise;
    assert.equal(result.state, "error");

    const status = harness.manager.status;
    assert.equal(status.state, "error");
    assert.match(status.error ?? "", /ENOENT/);
    await assert.doesNotReject(() => harness.manager.stop());
  }

  console.log("service-manager tests passed");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
