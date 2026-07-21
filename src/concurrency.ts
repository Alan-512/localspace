export interface AcquireOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AcquiredPermit {
  queuedMs: number;
  release(): void;
}

interface Waiter {
  resolve: (permit: AcquiredPermit) => void;
  reject: (error: Error) => void;
  queuedAt: number;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
  active: boolean;
}

export class AsyncSemaphore {
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Semaphore capacity must be a positive integer.");
    }
    this.available = capacity;
  }

  get activeCount(): number {
    return this.capacity - this.available;
  }

  get queuedCount(): number {
    return this.waiters.filter((waiter) => waiter.active).length;
  }

  acquire(options: AcquireOptions = {}): Promise<AcquiredPermit> {
    validateAcquireOptions(options);
    if (options.signal?.aborted) {
      return Promise.reject(abortError());
    }

    if (this.available > 0 && this.waiters.length === 0) {
      this.available -= 1;
      return Promise.resolve(this.createPermit(0));
    }

    return new Promise<AcquiredPermit>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        queuedAt: performance.now(),
        signal: options.signal,
        active: true,
      };
      installWaiterCancellation(waiter, options, () => this.removeWaiter(waiter));
      this.waiters.push(waiter);
      this.drain();
    });
  }

  async run<T>(operation: () => Promise<T> | T, options: AcquireOptions = {}): Promise<T> {
    const permit = await this.acquire(options);
    try {
      return await operation();
    } finally {
      permit.release();
    }
  }

  private drain(): void {
    while (this.available > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (!waiter.active) continue;

      waiter.active = false;
      cleanupWaiter(waiter);
      this.available -= 1;
      waiter.resolve(this.createPermit(elapsedMs(waiter.queuedAt)));
    }
  }

  private createPermit(queuedMs: number): AcquiredPermit {
    let released = false;
    return {
      queuedMs,
      release: () => {
        if (released) return;
        released = true;
        this.available += 1;
        if (this.available > this.capacity) {
          this.available = this.capacity;
          throw new Error("Semaphore permit released more than once.");
        }
        this.drain();
      },
    };
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }
}

type LockMode = "read" | "write";

interface LockWaiter extends Waiter {
  mode: LockMode;
}

export class AsyncReadWriteLock {
  private activeReaders = 0;
  private writerActive = false;
  private readonly waiters: LockWaiter[] = [];

  get readerCount(): number {
    return this.activeReaders;
  }

  get writing(): boolean {
    return this.writerActive;
  }

  get queuedCount(): number {
    return this.waiters.filter((waiter) => waiter.active).length;
  }

  acquireRead(options: AcquireOptions = {}): Promise<AcquiredPermit> {
    return this.acquire("read", options);
  }

  acquireWrite(options: AcquireOptions = {}): Promise<AcquiredPermit> {
    return this.acquire("write", options);
  }

  async withRead<T>(operation: () => Promise<T> | T, options: AcquireOptions = {}): Promise<T> {
    const permit = await this.acquireRead(options);
    try {
      return await operation();
    } finally {
      permit.release();
    }
  }

  async withWrite<T>(operation: () => Promise<T> | T, options: AcquireOptions = {}): Promise<T> {
    const permit = await this.acquireWrite(options);
    try {
      return await operation();
    } finally {
      permit.release();
    }
  }

  private acquire(mode: LockMode, options: AcquireOptions): Promise<AcquiredPermit> {
    validateAcquireOptions(options);
    if (options.signal?.aborted) return Promise.reject(abortError());

    if (this.canAcquireImmediately(mode)) {
      this.markAcquired(mode);
      return Promise.resolve(this.createPermit(mode, 0));
    }

    return new Promise<AcquiredPermit>((resolve, reject) => {
      const waiter: LockWaiter = {
        mode,
        resolve,
        reject,
        queuedAt: performance.now(),
        signal: options.signal,
        active: true,
      };
      installWaiterCancellation(waiter, options, () => this.removeWaiter(waiter));
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private canAcquireImmediately(mode: LockMode): boolean {
    if (this.waiters.some((waiter) => waiter.active)) return false;
    if (mode === "read") return !this.writerActive;
    return !this.writerActive && this.activeReaders === 0;
  }

  private drain(): void {
    if (this.writerActive || this.activeReaders > 0) return;

    while (this.waiters.length > 0 && !this.waiters[0]?.active) this.waiters.shift();
    const first = this.waiters[0];
    if (!first) return;

    if (first.mode === "write") {
      this.waiters.shift();
      this.resolveWaiter(first);
      return;
    }

    while (this.waiters[0]?.mode === "read") {
      const reader = this.waiters.shift();
      if (!reader || !reader.active) continue;
      this.resolveWaiter(reader);
    }
  }

  private resolveWaiter(waiter: LockWaiter): void {
    waiter.active = false;
    cleanupWaiter(waiter);
    this.markAcquired(waiter.mode);
    waiter.resolve(this.createPermit(waiter.mode, elapsedMs(waiter.queuedAt)));
  }

  private markAcquired(mode: LockMode): void {
    if (mode === "read") this.activeReaders += 1;
    else this.writerActive = true;
  }

  private createPermit(mode: LockMode, queuedMs: number): AcquiredPermit {
    let released = false;
    return {
      queuedMs,
      release: () => {
        if (released) return;
        released = true;
        if (mode === "read") {
          this.activeReaders -= 1;
          if (this.activeReaders < 0) throw new Error("Read lock released more than acquired.");
        } else {
          if (!this.writerActive) throw new Error("Write lock released without an active writer.");
          this.writerActive = false;
        }
        this.drain();
      },
    };
  }

  private removeWaiter(waiter: LockWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.drain();
  }
}

interface KeyedEntry<T> {
  resource: T;
  references: number;
}

export class KeyedResourceMap<T> {
  private readonly entries = new Map<string, KeyedEntry<T>>();

  constructor(private readonly createResource: () => T) {}

  acquire(key: string): { resource: T; release(): void } {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { resource: this.createResource(), references: 0 };
      this.entries.set(key, entry);
    }
    entry.references += 1;

    let released = false;
    return {
      resource: entry.resource,
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(key);
        if (!current) return;
        current.references -= 1;
        if (current.references <= 0) this.entries.delete(key);
      },
    };
  }

  get size(): number {
    return this.entries.size;
  }
}

export class KeyedMutex {
  private readonly locks = new KeyedResourceMap(() => new AsyncSemaphore(1));

  async acquire(key: string, options: AcquireOptions = {}): Promise<AcquiredPermit> {
    const entry = this.locks.acquire(key);
    try {
      const permit = await entry.resource.acquire(options);
      let released = false;
      return {
        queuedMs: permit.queuedMs,
        release: () => {
          if (released) return;
          released = true;
          permit.release();
          entry.release();
        },
      };
    } catch (error) {
      entry.release();
      throw error;
    }
  }

  async run<T>(key: string, operation: () => Promise<T> | T, options: AcquireOptions = {}): Promise<T> {
    const permit = await this.acquire(key, options);
    try {
      return await operation();
    } finally {
      permit.release();
    }
  }

  get keyCount(): number {
    return this.locks.size;
  }
}

function installWaiterCancellation(
  waiter: Waiter,
  options: AcquireOptions,
  remove: () => void,
): void {
  if (options.timeoutMs !== undefined) {
    waiter.timer = setTimeout(() => {
      if (!waiter.active) return;
      waiter.active = false;
      remove();
      cleanupWaiter(waiter);
      waiter.reject(new Error(`Concurrency wait timed out after ${options.timeoutMs} ms.`));
    }, options.timeoutMs);
  }

  if (options.signal) {
    waiter.abortHandler = () => {
      if (!waiter.active) return;
      waiter.active = false;
      remove();
      cleanupWaiter(waiter);
      waiter.reject(abortError());
    };
    options.signal.addEventListener("abort", waiter.abortHandler, { once: true });
  }
}

function cleanupWaiter(waiter: Waiter): void {
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.abortHandler) {
    waiter.signal.removeEventListener("abort", waiter.abortHandler);
  }
}

function validateAcquireOptions(options: AcquireOptions): void {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
    throw new Error("Concurrency timeout must be a non-negative number.");
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function abortError(): Error {
  const error = new Error("Concurrency wait aborted.");
  error.name = "AbortError";
  return error;
}
