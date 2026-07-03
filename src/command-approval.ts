import { randomUUID } from "node:crypto";
import type { CommandSafetyAnalysis } from "./command-safety.js";

export interface CommandApprovalContext {
  workspaceId: string;
  cwd: string;
  command: string;
  safety: CommandSafetyAnalysis;
}

export interface CommandApprovalRequest {
  token: string;
  workspaceId: string;
  cwd: string;
  command: string;
  risk: CommandSafetyAnalysis["level"];
  createdAt: string;
  expiresAt: string;
}

export interface CommandApprovalResult {
  approved: boolean;
  reason?: "missing" | "not_found" | "expired" | "mismatch";
}

export class CommandApprovalManager {
  private readonly ttlMs: number;
  private readonly requests = new Map<string, CommandApprovalRequest>();

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1_000;
  }

  create(context: CommandApprovalContext): CommandApprovalRequest {
    this.pruneExpired();
    const now = Date.now();
    const request: CommandApprovalRequest = {
      token: `approve-${randomUUID().slice(0, 8)}`,
      workspaceId: context.workspaceId,
      cwd: context.cwd,
      command: context.command,
      risk: context.safety.level,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    this.requests.set(request.token, request);
    return request;
  }

  consume(token: string | undefined, context: CommandApprovalContext): CommandApprovalResult {
    if (!token) return { approved: false, reason: "missing" };

    const request = this.requests.get(token);
    if (!request) return { approved: false, reason: "not_found" };

    if (Date.parse(request.expiresAt) <= Date.now()) {
      this.requests.delete(token);
      return { approved: false, reason: "expired" };
    }

    if (
      request.workspaceId !== context.workspaceId ||
      request.cwd !== context.cwd ||
      request.command !== context.command ||
      request.risk !== context.safety.level
    ) {
      return { approved: false, reason: "mismatch" };
    }

    this.requests.delete(token);
    return { approved: true };
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [token, request] of this.requests) {
      if (Date.parse(request.expiresAt) <= now) this.requests.delete(token);
    }
  }
}
