import type { ToolConcurrencyConfig } from "./config.js";
import {
  AsyncReadWriteLock,
  AsyncSemaphore,
  KeyedMutex,
  KeyedResourceMap,
  type AcquiredPermit,
  type AcquireOptions,
} from "./concurrency.js";
import {
  toolCatalogEntry,
  toolNames,
  type ToolConcurrencyClass,
  type ToolName,
} from "./tool-catalog.js";

export interface ToolConcurrencyResolver {
  workspaceKey(workspaceId: string): string;
}

export interface ToolConcurrencyPermit {
  queuedMs: number;
  waits: Partial<Record<ConcurrencyWaitKind, number>>;
  release(): void;
}

export type ConcurrencyWaitKind =
  | "global"
  | "global-execution"
  | "heavy-read"
  | "git-root"
  | "workspace-read"
  | "workspace-write"
  | "process-global"
  | "process-workspace"
  | "process-session";

interface HeldPermit {
  kind: ConcurrencyWaitKind;
  permit: AcquiredPermit;
  releaseResource?: () => void;
}

export class ToolConcurrencyScheduler {
  private readonly globalTools: AsyncSemaphore;
  private readonly globalExecution = new AsyncReadWriteLock();
  private readonly heavyReads: AsyncSemaphore;
  private readonly globalProcesses: AsyncSemaphore;
  private readonly workspaceProcesses: KeyedResourceMap<AsyncSemaphore>;
  private readonly workspaceLocks = new KeyedResourceMap(() => new AsyncReadWriteLock());
  private readonly gitRoots = new KeyedMutex();
  private readonly processSessions = new KeyedMutex();

  constructor(
    private readonly config: ToolConcurrencyConfig,
    private readonly resolver: ToolConcurrencyResolver,
  ) {
    this.globalTools = new AsyncSemaphore(config.maxConcurrentToolCalls);
    this.heavyReads = new AsyncSemaphore(config.maxConcurrentScans);
    this.globalProcesses = new AsyncSemaphore(config.maxConcurrentProcesses);
    this.workspaceProcesses = new KeyedResourceMap(
      () => new AsyncSemaphore(config.maxWorkspaceProcesses),
    );
  }

  async acquire(
    tool: ToolName,
    input: unknown,
    options: Pick<AcquireOptions, "signal"> = {},
  ): Promise<ToolConcurrencyPermit> {
    const startedAt = performance.now();
    const held: HeldPermit[] = [];
    const waits: Partial<Record<ConcurrencyWaitKind, number>> = {};
    const concurrencyClass = effectiveConcurrencyClass(tool, input);
    const workspaceId = inputWorkspaceId(input);
    const workspaceKey = workspaceId ? this.resolver.workspaceKey(workspaceId) : undefined;

    try {
      await this.holdSemaphore(
        held,
        waits,
        "global",
        this.globalTools,
        startedAt,
        options.signal,
      );

      const globalExecutionPermit = concurrencyClass === "global-exclusive"
        ? await this.globalExecution.acquireWrite(this.acquireOptions(startedAt, options.signal))
        : await this.globalExecution.acquireRead(this.acquireOptions(startedAt, options.signal));
      waits["global-execution"] = globalExecutionPermit.queuedMs;
      held.push({ kind: "global-execution", permit: globalExecutionPermit });

      if (concurrencyClass === "heavy-read") {
        await this.holdSemaphore(
          held,
          waits,
          "heavy-read",
          this.heavyReads,
          startedAt,
          options.signal,
        );
      }

      if (concurrencyClass === "process-start") {
        await this.holdSemaphore(
          held,
          waits,
          "process-global",
          this.globalProcesses,
          startedAt,
          options.signal,
        );
        if (workspaceKey) {
          await this.holdKeyedSemaphore(
            held,
            waits,
            "process-workspace",
            this.workspaceProcesses,
            workspaceKey,
            startedAt,
            options.signal,
          );
        }
      }

      if (concurrencyClass === "git-write" && workspaceKey) {
        await this.holdKeyedMutex(
          held,
          waits,
          "git-root",
          this.gitRoots,
          workspaceKey,
          startedAt,
          options.signal,
        );
      }

      if (workspaceKey && isWorkspaceRead(concurrencyClass)) {
        await this.holdWorkspaceLock(
          held,
          waits,
          "workspace-read",
          workspaceKey,
          "read",
          startedAt,
          options.signal,
        );
      }

      if (workspaceKey && isWorkspaceWrite(concurrencyClass)) {
        await this.holdWorkspaceLock(
          held,
          waits,
          "workspace-write",
          workspaceKey,
          "write",
          startedAt,
          options.signal,
        );
      }

      if (concurrencyClass === "process-session") {
        const sessionKey = processSessionKey(input);
        if (sessionKey) {
          await this.holdKeyedMutex(
            held,
            waits,
            "process-session",
            this.processSessions,
            sessionKey,
            startedAt,
            options.signal,
          );
        }
      }

      let released = false;
      return {
        queuedMs: round(Object.values(waits).reduce((sum, value) => sum + (value ?? 0), 0)),
        waits,
        release: () => {
          if (released) return;
          released = true;
          releaseHeld(held);
        },
      };
    } catch (error) {
      releaseHeld(held);
      throw error;
    }
  }

  private async holdSemaphore(
    held: HeldPermit[],
    waits: Partial<Record<ConcurrencyWaitKind, number>>,
    kind: ConcurrencyWaitKind,
    semaphore: AsyncSemaphore,
    startedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const permit = await semaphore.acquire(this.acquireOptions(startedAt, signal));
    waits[kind] = permit.queuedMs;
    held.push({ kind, permit });
  }

  private async holdKeyedMutex(
    held: HeldPermit[],
    waits: Partial<Record<ConcurrencyWaitKind, number>>,
    kind: ConcurrencyWaitKind,
    mutex: KeyedMutex,
    key: string,
    startedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const permit = await mutex.acquire(key, this.acquireOptions(startedAt, signal));
    waits[kind] = permit.queuedMs;
    held.push({ kind, permit });
  }

  private async holdKeyedSemaphore(
    held: HeldPermit[],
    waits: Partial<Record<ConcurrencyWaitKind, number>>,
    kind: ConcurrencyWaitKind,
    resources: KeyedResourceMap<AsyncSemaphore>,
    key: string,
    startedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const entry = resources.acquire(key);
    try {
      const permit = await entry.resource.acquire(this.acquireOptions(startedAt, signal));
      waits[kind] = permit.queuedMs;
      held.push({ kind, permit, releaseResource: entry.release });
    } catch (error) {
      entry.release();
      throw error;
    }
  }

  private async holdWorkspaceLock(
    held: HeldPermit[],
    waits: Partial<Record<ConcurrencyWaitKind, number>>,
    kind: "workspace-read" | "workspace-write",
    key: string,
    mode: "read" | "write",
    startedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const entry = this.workspaceLocks.acquire(key);
    try {
      const permit = mode === "read"
        ? await entry.resource.acquireRead(this.acquireOptions(startedAt, signal))
        : await entry.resource.acquireWrite(this.acquireOptions(startedAt, signal));
      waits[kind] = permit.queuedMs;
      held.push({ kind, permit, releaseResource: entry.release });
    } catch (error) {
      entry.release();
      throw error;
    }
  }

  private acquireOptions(startedAt: number, signal: AbortSignal | undefined): AcquireOptions {
    const elapsed = performance.now() - startedAt;
    const timeoutMs = Math.max(0, this.config.queueTimeoutMs - elapsed);
    if (timeoutMs <= 0) {
      throw new Error(`Tool concurrency wait timed out after ${this.config.queueTimeoutMs} ms.`);
    }
    return { timeoutMs, signal };
  }
}

function effectiveConcurrencyClass(tool: ToolName, input: unknown): ToolConcurrencyClass {
  if (tool === toolNames.openWorkspace && inputMode(input) === "worktree") {
    return "global-exclusive";
  }
  return toolCatalogEntry(tool).concurrencyClass;
}

function isWorkspaceRead(concurrencyClass: ToolConcurrencyClass): boolean {
  return concurrencyClass === "shared-read" || concurrencyClass === "heavy-read";
}

function isWorkspaceWrite(concurrencyClass: ToolConcurrencyClass): boolean {
  return concurrencyClass === "workspace-write" || concurrencyClass === "git-write";
}

function inputWorkspaceId(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).workspaceId;
  return typeof value === "string" ? value : undefined;
}

function inputMode(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).mode;
  return typeof value === "string" ? value : undefined;
}

function processSessionKey(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.workspaceId !== "string" || typeof record.sessionId !== "number") {
    return undefined;
  }
  return `${record.workspaceId}:${record.sessionId}`;
}

function releaseHeld(held: HeldPermit[]): void {
  for (const item of held.reverse()) {
    item.permit.release();
    item.releaseResource?.();
  }
  held.length = 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
