export const DEFAULT_MCP_SESSION_IDLE_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_MCP_SESSION_CLEANUP_INTERVAL_MS = 60_000;
export const DEFAULT_MCP_MAX_SESSIONS = 16;

export interface McpSessionConfig {
  idleTtlMs: number;
  cleanupIntervalMs: number;
  maxSessions: number;
}

export type McpSessionCloseReason = "client_closed" | "idle_timeout" | "session_cap" | "server_shutdown";

export interface McpSessionRegistryEvent {
  action: "created" | "closed";
  sessionId: string;
  reason?: McpSessionCloseReason;
  activeSessions: number;
  ageMs?: number;
  idleMs?: number;
}

export interface McpTransportLike {
  close?: () => void | Promise<void>;
}

interface McpSessionRecord<TTransport extends McpTransportLike> {
  transport: TTransport;
  createdAt: number;
  lastSeenAt: number;
}

interface McpSessionRegistryOptions {
  now?: () => number;
}

interface DeleteSessionOptions {
  closeTransport?: boolean;
}

export class McpSessionRegistry<TTransport extends McpTransportLike> {
  private readonly sessions = new Map<string, McpSessionRecord<TTransport>>();
  private readonly now: () => number;
  private readonly cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: McpSessionConfig,
    private readonly onEvent?: (event: McpSessionRegistryEvent) => void,
    options: McpSessionRegistryOptions = {},
  ) {
    assertSessionConfig(config);
    this.now = options.now ?? Date.now;
    if (config.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.sweepExpired(), config.cleanupIntervalMs);
      this.cleanupTimer.unref();
    }
  }

  add(sessionId: string, transport: TTransport): void {
    const now = this.now();
    const existing = this.sessions.get(sessionId);
    if (existing) this.closeSession(sessionId, existing, "client_closed", now, { closeTransport: true });

    this.sessions.set(sessionId, { transport, createdAt: now, lastSeenAt: now });
    this.emit({ action: "created", sessionId, activeSessions: this.sessions.size });
    this.enforceLimit(now);
  }

  get(sessionId: string): TTransport | undefined {
    const now = this.now();
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;

    const idleMs = now - record.lastSeenAt;
    if (idleMs >= this.config.idleTtlMs) {
      this.closeSession(sessionId, record, "idle_timeout", now, { closeTransport: true });
      return undefined;
    }

    record.lastSeenAt = now;
    return record.transport;
  }

  delete(
    sessionId: string,
    reason: McpSessionCloseReason,
    options: DeleteSessionOptions = {},
  ): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    this.closeSession(sessionId, record, reason, this.now(), {
      closeTransport: options.closeTransport ?? true,
    });
    return true;
  }

  sweepExpired(): number {
    const now = this.now();
    let closed = 0;
    for (const [sessionId, record] of Array.from(this.sessions.entries())) {
      if (now - record.lastSeenAt >= this.config.idleTtlMs) {
        this.closeSession(sessionId, record, "idle_timeout", now, { closeTransport: true });
        closed += 1;
      }
    }
    return closed;
  }

  closeAll(reason: McpSessionCloseReason = "server_shutdown"): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    const now = this.now();
    for (const [sessionId, record] of Array.from(this.sessions.entries())) {
      this.closeSession(sessionId, record, reason, now, { closeTransport: true });
    }
  }

  size(): number {
    return this.sessions.size;
  }

  private enforceLimit(now: number): void {
    while (this.sessions.size > this.config.maxSessions) {
      const oldest = this.oldestSession();
      if (!oldest) return;
      this.closeSession(oldest.sessionId, oldest.record, "session_cap", now, { closeTransport: true });
    }
  }

  private oldestSession(): { sessionId: string; record: McpSessionRecord<TTransport> } | undefined {
    let oldest: { sessionId: string; record: McpSessionRecord<TTransport> } | undefined;
    for (const [sessionId, record] of this.sessions.entries()) {
      if (!oldest || record.lastSeenAt < oldest.record.lastSeenAt) {
        oldest = { sessionId, record };
      }
    }
    return oldest;
  }

  private closeSession(
    sessionId: string,
    record: McpSessionRecord<TTransport>,
    reason: McpSessionCloseReason,
    now: number,
    options: Required<DeleteSessionOptions>,
  ): void {
    this.sessions.delete(sessionId);
    if (options.closeTransport) safeClose(record.transport);
    this.emit({
      action: "closed",
      sessionId,
      reason,
      activeSessions: this.sessions.size,
      ageMs: Math.max(0, now - record.createdAt),
      idleMs: Math.max(0, now - record.lastSeenAt),
    });
  }

  private emit(event: McpSessionRegistryEvent): void {
    this.onEvent?.(event);
  }
}

function assertSessionConfig(config: McpSessionConfig): void {
  assertPositiveInteger(config.idleTtlMs, "MCP session idle TTL");
  assertPositiveInteger(config.maxSessions, "MCP max sessions");
  if (!Number.isInteger(config.cleanupIntervalMs) || config.cleanupIntervalMs < 0) {
    throw new Error("MCP session cleanup interval must be a non-negative integer.");
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function safeClose(transport: McpTransportLike): void {
  try {
    const result = transport.close?.();
    if (result && typeof result === "object" && "catch" in result) {
      void result.catch(() => undefined);
    }
  } catch {
    // Cleanup should be fail-closed for registry state even if a transport close throws.
  }
}
