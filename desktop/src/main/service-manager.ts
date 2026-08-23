import { spawn } from "node:child_process";
import type { RuntimePaths } from "./runtime-paths.js";
import { LineSplitter } from "./logger.js";
import type { ServiceStatus } from "../shared/types.js";

/** Minimal process surface the manager needs; real children and test fakes both fit. */
export interface ServiceChild {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  stdout: { setEncoding(encoding: string): unknown; on(event: "data", listener: (chunk: string) => void): unknown } | null;
  stderr: { setEncoding(encoding: string): unknown; on(event: "data", listener: (chunk: string) => void): unknown } | null;
}

export type SpawnServiceChild = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => ServiceChild;

export type HealthProbe = (url: string, timeoutMs: number) => Promise<boolean>;

export interface ServiceManagerOptions {
  readonly paths: RuntimePaths;
  readonly log: (stream: "stdout" | "stderr", line: string) => void;
  /** Reads the currently configured local port before each start. */
  readonly readPort: () => number | undefined;
  readonly spawnChild?: SpawnServiceChild;
  readonly probeHealth?: HealthProbe;
  readonly healthPollIntervalMs?: number;
  readonly healthTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly now?: () => number;
}

export class ServiceBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceBusyError";
  }
}

const defaultPollIntervalMs = 500;
const defaultHealthTimeoutMs = 20000;
const defaultStopGraceMs = 5000;

/**
 * Owns the `localspace serve` sidecar process: start, health-gated readiness,
 * stop with grace period, restart, crash detection, and log streaming.
 */
export class ServiceManager {
  private child: ServiceChild | null = null;
  private currentState: ServiceStatus = { state: "stopped" };
  private stopRequested = false;
  private listeners = new Set<(status: ServiceStatus) => void>();

  private readonly spawnChild: SpawnServiceChild;
  private readonly probeHealth: HealthProbe;
  private readonly healthPollIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ServiceManagerOptions) {
    this.spawnChild = options.spawnChild ?? defaultSpawn;
    this.probeHealth = options.probeHealth ?? defaultProbeHealth;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? defaultPollIntervalMs;
    this.healthTimeoutMs = options.healthTimeoutMs ?? defaultHealthTimeoutMs;
    this.stopGraceMs = options.stopGraceMs ?? defaultStopGraceMs;
    this.now = options.now ?? Date.now;
  }

  get status(): ServiceStatus {
    return this.currentState;
  }

  onStatusChange(listener: (status: ServiceStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<ServiceStatus> {
    const state = this.currentState.state;
    if (state === "starting" || state === "running" || state === "stopping") {
      throw new ServiceBusyError(`Service is ${state}; wait for it to settle before starting.`);
    }

    this.stopRequested = false;
    const port = this.options.readPort() ?? 7676;
    this.setState({ state: "starting", port });

    const child = this.spawnChild(this.options.paths.nodeExecutable, [this.options.paths.cliScript, "serve"], {
      cwd: this.options.paths.serverRoot,
      env: { ...process.env },
      windowsHide: true,
    });
    this.child = child;
    this.wireOutput(child);

    child.on("exit", (code, signal) => {
      this.handleExit(code, signal);
    });
    child.on("error", (error) => {
      // Spawn failures (ENOENT, EACCES) arrive here instead of crashing the app.
      if (this.child === child) this.child = null;
      const state = this.currentState.state;
      if (this.stopRequested || state === "stopped" || state === "stopping") return;
      this.setState({
        state: "error",
        port: this.currentState.port,
        error: `Unable to start the LocalSpace core process: ${error.message}`,
      });
    });

    const healthy = await this.waitForHealthy(port);
    if (this.child !== child) {
      // A stop() raced the health wait; report its outcome instead.
      return this.currentState;
    }
    if (!healthy) {
      await this.killChild();
      this.setState({
        state: "error",
        port,
        error: `The MCP server did not become healthy within ${Math.round(this.healthTimeoutMs / 1000)}s. Check the logs page for details.`,
      });
      return this.currentState;
    }

    this.setState({ state: "running", pid: child.pid, port, startedAt: this.now() });
    return this.currentState;
  }

  async stop(): Promise<ServiceStatus> {
    const child = this.child;
    if (!child || this.currentState.state === "stopped") {
      this.setState({ state: "stopped" });
      return this.currentState;
    }

    this.stopRequested = true;
    this.setState({ state: "stopping", pid: child.pid, port: this.currentState.port });
    // Ask for termination immediately; waitForExit only escalates to SIGKILL
    // once the grace period elapses.
    child.kill();
    await this.waitForExit(child);
    this.setState({ state: "stopped" });
    return this.currentState;
  }

  async restart(): Promise<ServiceStatus> {
    await this.stop();
    return this.start();
  }

  /** Best-effort teardown for app quit; never throws. */
  async dispose(): Promise<void> {
    try {
      await this.stop();
    } catch {
      this.child = null;
    }
  }

  private setState(next: ServiceStatus): void {
    this.currentState = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        // Listener failures must not break state transitions.
      }
    }
  }

  private wireOutput(child: ServiceChild): void {
    const stdoutSplitter = new LineSplitter();
    const stderrSplitter = new LineSplitter();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of stdoutSplitter.push(chunk)) this.options.log("stdout", line);
    });
    child.stderr?.on("data", (chunk: string) => {
      for (const line of stderrSplitter.push(chunk)) this.options.log("stderr", line);
    });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    const state = this.currentState.state;
    if (this.stopRequested || state === "stopped") return;

    if (state === "stopping") {
      this.setState({ state: "stopped" });
      return;
    }

    this.setState({
      state: "error",
      port: this.currentState.port,
      error: `The MCP server exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}). Check the logs page for details.`,
    });
  }

  private async waitForHealthy(port: number): Promise<boolean> {
    const deadline = this.now() + this.healthTimeoutMs;
    const url = `http://127.0.0.1:${port}/healthz`;
    while (this.now() < deadline) {
      if (this.child === null) return false;
      if (await this.probeHealth(url, 1500)) return true;
      await delay(this.healthPollIntervalMs);
    }
    return false;
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopRequested = true;
    child.kill();
    await this.waitForExit(child);
  }

  private waitForExit(child: ServiceChild): Promise<void> {
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.child === child) this.child = null;
        resolvePromise();
      };
      child.on("exit", () => finish());
      setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        // Give the forced kill a moment, then move on regardless.
        setTimeout(finish, 250);
      }, this.stopGraceMs);
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const defaultSpawn: SpawnServiceChild = (command, args, options) =>
  spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ServiceChild;

const defaultProbeHealth: HealthProbe = async (url, timeoutMs) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
};
