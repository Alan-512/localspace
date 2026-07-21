import { HeadTailBuffer, ProcessSessionManager } from "./process-sessions.js";
import { KeyedMutex } from "./concurrency.js";
import type { PreparedPackageCheck } from "./package-checks.js";
import { workspaceRevision } from "./workspace-revision.js";

const DEFAULT_CHECK_CONCURRENCY = 2;
const MAX_CHECK_CONCURRENCY = 4;
const DEFAULT_CHECK_YIELD_MS = 10_000;
const MAX_CHECK_YIELD_MS = 30_000;
const DEFAULT_CHECK_OUTPUT_TOKENS = 20_000;
const COMPLETED_CHECK_SESSION_TTL_MS = 5 * 60 * 1_000;

export type CheckStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "skipped"
  | "cancelled";

export interface CheckResult {
  name: string;
  command: string;
  status: CheckStatus;
  exitCode?: number;
  signal?: string;
  wallTimeMs?: number;
  queuedMs: number;
  output: string;
  outputTruncated: boolean;
  commandRisk: PreparedPackageCheck["safety"]["level"];
  commandSafetyFindings: PreparedPackageCheck["safety"]["findings"];
}

export interface CheckSummary {
  requested: number;
  queued: number;
  running: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  cancelled: number;
}

export interface CheckSessionSnapshot {
  sessionId?: number;
  running: boolean;
  result: string;
  outputTruncated: boolean;
  wallTimeMs: number;
  queuedMs: number;
  checks: CheckResult[];
  summary: CheckSummary;
  workspaceRevisionAtStart?: string;
  workspaceRevisionAtEnd?: string;
  workspaceChangedDuringRun?: boolean;
  failFast: boolean;
  concurrency: number;
}

export interface StartCheckSessionInput {
  workspaceId: string;
  root: string;
  checks: PreparedPackageCheck[];
  concurrency?: number;
  failFast?: boolean;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface PollCheckSessionInput {
  workspaceId: string;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

interface ManagedCheck extends CheckResult {
  definition: PreparedPackageCheck;
  buffer: HeadTailBuffer;
}

interface CheckSession {
  id: number;
  workspaceId: string;
  root: string;
  startedAt: number;
  checks: ManagedCheck[];
  concurrency: number;
  failFast: boolean;
  running: boolean;
  cancelled: boolean;
  failFastTriggered: boolean;
  nextIndex: number;
  activeProcessSessions: Set<number>;
  buffer: HeadTailBuffer;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  workspaceRevisionAtStart?: string;
  workspaceRevisionAtEnd?: string;
  cleanupTimer?: NodeJS.Timeout;
}

export class CheckSessionManager {
  private readonly sessions = new Map<number, CheckSession>();
  private readonly interactions = new KeyedMutex();
  private nextSessionId = -1;

  constructor(
    private readonly processes: ProcessSessionManager,
    private readonly options: {
      completedSessionTtlMs?: number;
    } = {},
  ) {}

  has(workspaceId: string, sessionId: number): boolean {
    const session = this.sessions.get(sessionId);
    return Boolean(session && session.workspaceId === workspaceId);
  }

  async start(input: StartCheckSessionInput): Promise<CheckSessionSnapshot> {
    const concurrency = boundedInteger(
      input.concurrency,
      DEFAULT_CHECK_CONCURRENCY,
      MAX_CHECK_CONCURRENCY,
      "concurrency",
    );
    const yieldTimeMs = boundedInteger(
      input.yieldTimeMs,
      DEFAULT_CHECK_YIELD_MS,
      MAX_CHECK_YIELD_MS,
      "yieldTimeMs",
      true,
    );
    const maxOutputTokens = boundedInteger(
      input.maxOutputTokens,
      DEFAULT_CHECK_OUTPUT_TOKENS,
      100_000,
      "maxOutputTokens",
    );
    const perCheckCharacters = Math.max(
      4_000,
      Math.floor((maxOutputTokens * 4) / Math.max(1, input.checks.length)),
    );
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const session: CheckSession = {
      id: this.nextSessionId,
      workspaceId: input.workspaceId,
      root: input.root,
      startedAt: Date.now(),
      checks: input.checks.map((definition) => ({
        name: definition.name,
        command: definition.command,
        status: "queued",
        queuedMs: 0,
        output: "",
        outputTruncated: false,
        commandRisk: definition.safety.level,
        commandSafetyFindings: definition.safety.findings,
        definition,
        buffer: new HeadTailBuffer(perCheckCharacters),
      })),
      concurrency,
      failFast: input.failFast ?? false,
      running: true,
      cancelled: false,
      failFastTriggered: false,
      nextIndex: 0,
      activeProcessSessions: new Set(),
      buffer: new HeadTailBuffer(maxOutputTokens * 4),
      exitPromise,
      resolveExit,
    };
    this.nextSessionId -= 1;
    this.sessions.set(session.id, session);
    void this.run(session, Math.max(1_000, Math.floor(maxOutputTokens / input.checks.length)));

    await waitForExitOrTimeout(session.exitPromise, yieldTimeMs);
    const snapshot = this.consume(session, maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: PollCheckSessionInput): Promise<CheckSessionSnapshot> {
    const permit = await this.interactions.acquire(
      `${input.workspaceId}:${input.sessionId}`,
      { timeoutMs: 120_000 },
    );
    try {
      const session = this.getOwnedSession(input.workspaceId, input.sessionId);
      if (input.columns !== undefined || input.rows !== undefined) {
        throw new Error("Check group sessions do not support terminal resize.");
      }
      if (input.chars && input.chars !== "\u0003") {
        throw new Error("Check group sessions support polling or Ctrl-C only.");
      }
      if (input.chars === "\u0003") await this.cancel(session);

      const yieldTimeMs = boundedInteger(
        input.yieldTimeMs,
        DEFAULT_CHECK_YIELD_MS,
        110_000,
        "yieldTimeMs",
        true,
      );
      const maxOutputTokens = boundedInteger(
        input.maxOutputTokens,
        DEFAULT_CHECK_OUTPUT_TOKENS,
        100_000,
        "maxOutputTokens",
      );
      await waitForExitOrTimeout(session.exitPromise, yieldTimeMs);
      const snapshot = this.consume(session, maxOutputTokens, permit.queuedMs);
      if (!session.running) this.removeSession(session.id);
      return snapshot;
    } finally {
      permit.release();
    }
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      void this.cancel(session);
    }
    this.sessions.clear();
  }

  private async run(session: CheckSession, perCheckOutputTokens: number): Promise<void> {
    session.workspaceRevisionAtStart = await workspaceRevision(session.root);
    const workers = Array.from(
      { length: Math.min(session.concurrency, session.checks.length) },
      async () => {
        while (true) {
          const index = session.nextIndex;
          session.nextIndex += 1;
          if (index >= session.checks.length) return;
          const check = session.checks[index];
          if (!check) return;
          if (session.cancelled) {
            check.status = "cancelled";
            session.buffer.append(`[${check.name}] cancelled before start\n`);
            continue;
          }
          if (session.failFast && session.failFastTriggered) {
            check.status = "skipped";
            session.buffer.append(`[${check.name}] skipped after earlier failure\n`);
            continue;
          }
          await this.runCheck(session, check, perCheckOutputTokens);
          if (check.status === "failed") session.failFastTriggered = true;
        }
      },
    );

    await Promise.all(workers);
    session.workspaceRevisionAtEnd = await workspaceRevision(session.root);
    session.running = false;
    session.resolveExit();
    session.cleanupTimer = setTimeout(
      () => this.removeSession(session.id),
      this.options.completedSessionTtlMs ?? COMPLETED_CHECK_SESSION_TTL_MS,
    );
    session.cleanupTimer.unref?.();
  }

  private async runCheck(
    session: CheckSession,
    check: ManagedCheck,
    maxOutputTokens: number,
  ): Promise<void> {
    check.status = "running";
    session.buffer.append(`[${check.name}] started: ${check.command}\n`);
    try {
      let snapshot = await this.processes.start({
        workspaceId: session.workspaceId,
        command: check.command,
        cwd: session.root,
        yieldTimeMs: 0,
        maxOutputTokens,
      });
      check.queuedMs += snapshot.queuedMs;
      this.appendCheckOutput(check, snapshot.output, snapshot.outputTruncated);
      if (snapshot.sessionId) session.activeProcessSessions.add(snapshot.sessionId);

      while (snapshot.running && snapshot.sessionId) {
        snapshot = await this.processes.write({
          workspaceId: session.workspaceId,
          sessionId: snapshot.sessionId,
          yieldTimeMs: 1_000,
          maxOutputTokens,
        });
        check.queuedMs += snapshot.queuedMs;
        this.appendCheckOutput(check, snapshot.output, snapshot.outputTruncated);
      }
      if (snapshot.sessionId) session.activeProcessSessions.delete(snapshot.sessionId);
      check.exitCode = snapshot.exitCode;
      check.signal = snapshot.signal;
      check.wallTimeMs = snapshot.wallTimeMs;
      const output = check.buffer.drain(maxOutputTokens * 4);
      check.output = output.output;
      check.outputTruncated ||= output.truncated;
      check.status = session.cancelled && snapshot.exitCode !== 0
        ? "cancelled"
        : snapshot.exitCode === 0
          ? "passed"
          : "failed";
      session.buffer.append(
        `[${check.name}] ${check.status} (${snapshot.wallTimeMs}ms, exit ${snapshot.exitCode ?? "unknown"})\n${check.output}\n`,
      );
    } catch (error) {
      check.status = session.cancelled ? "cancelled" : "failed";
      check.output = error instanceof Error ? error.message : String(error);
      session.buffer.append(`[${check.name}] ${check.status}: ${check.output}\n`);
    }
  }

  private appendCheckOutput(check: ManagedCheck, output: string, truncated: boolean): void {
    if (output) check.buffer.append(output);
    check.outputTruncated ||= truncated;
  }

  private async cancel(session: CheckSession): Promise<void> {
    session.cancelled = true;
    await Promise.all(
      [...session.activeProcessSessions].map(async (sessionId) => {
        try {
          await this.processes.write({
            workspaceId: session.workspaceId,
            sessionId,
            chars: "\u0003",
            yieldTimeMs: 0,
          });
        } catch {
          // The child may have exited between snapshot and cancellation.
        }
      }),
    );
  }

  private consume(
    session: CheckSession,
    maxOutputTokens: number,
    interactionQueuedMs = 0,
  ): CheckSessionSnapshot {
    const output = session.buffer.drain(maxOutputTokens * 4);
    const checks = session.checks.map(({ definition: _definition, buffer: _buffer, ...check }) => ({ ...check }));
    return {
      sessionId: session.running ? session.id : undefined,
      running: session.running,
      result: output.output,
      outputTruncated: output.truncated,
      wallTimeMs: Date.now() - session.startedAt,
      queuedMs: round(
        interactionQueuedMs + checks.reduce((sum, check) => sum + check.queuedMs, 0),
      ),
      checks,
      summary: summarizeChecks(checks),
      workspaceRevisionAtStart: session.workspaceRevisionAtStart,
      workspaceRevisionAtEnd: session.workspaceRevisionAtEnd,
      workspaceChangedDuringRun:
        session.workspaceRevisionAtStart !== undefined
        && session.workspaceRevisionAtEnd !== undefined
          ? session.workspaceRevisionAtStart !== session.workspaceRevisionAtEnd
          : undefined,
      failFast: session.failFast,
      concurrency: session.concurrency,
    };
  }

  private getOwnedSession(workspaceId: string, sessionId: number): CheckSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown check session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Check session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
  }
}

function summarizeChecks(checks: readonly CheckResult[]): CheckSummary {
  const summary: CheckSummary = {
    requested: checks.length,
    queued: 0,
    running: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
  allowZero = false,
): number {
  if (value === undefined) return fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

async function waitForExitOrTimeout(exitPromise: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  await Promise.race([
    exitPromise,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
