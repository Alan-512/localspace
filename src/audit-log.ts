import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface AuditLogConfig {
  enabled: boolean;
  path: string;
  maxMemoryEvents: number;
}

export interface AuditEvent {
  id: string;
  time: string;
  tool: string;
  workspaceId?: string;
  action?: string;
  success: boolean;
  blocked?: boolean;
  approved?: boolean;
  risk?: string;
  paths?: string[];
  commandPreview?: string;
  additions?: number;
  removals?: number;
  exitCode?: number;
  running?: boolean;
  durationMs?: number;
  error?: string;
}

export interface AuditSummary {
  totalEvents: number;
  successfulEvents: number;
  failedEvents: number;
  blockedEvents: number;
  approvedEvents: number;
  tools: Record<string, number>;
  paths: string[];
  commands: string[];
  risks: Record<string, number>;
  recentEvents: AuditEvent[];
  text: string;
}

export class AuditLogManager {
  private readonly events: AuditEvent[] = [];

  constructor(private readonly config: AuditLogConfig) {}

  record(event: Omit<AuditEvent, "id" | "time">): void {
    if (!this.config.enabled) return;

    const entry: AuditEvent = {
      id: `audit_${randomUUID()}`,
      time: new Date().toISOString(),
      ...event,
    };
    this.events.push(entry);
    while (this.events.length > this.config.maxMemoryEvents) this.events.shift();

    try {
      mkdirSync(dirname(this.config.path), { recursive: true });
      appendFileSync(this.config.path, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Audit logging must never break the main tool path.
    }
  }

  summarize(options: { workspaceId?: string; limit?: number } = {}): AuditSummary {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 500));
    const filtered = this.events
      .filter((event) => !options.workspaceId || event.workspaceId === options.workspaceId)
      .slice(-limit);
    const tools: Record<string, number> = {};
    const risks: Record<string, number> = {};
    const paths = new Set<string>();
    const commands: string[] = [];
    let successfulEvents = 0;
    let failedEvents = 0;
    let blockedEvents = 0;
    let approvedEvents = 0;

    for (const event of filtered) {
      tools[event.tool] = (tools[event.tool] ?? 0) + 1;
      if (event.risk) risks[event.risk] = (risks[event.risk] ?? 0) + 1;
      if (event.success) successfulEvents += 1;
      else failedEvents += 1;
      if (event.blocked) blockedEvents += 1;
      if (event.approved) approvedEvents += 1;
      for (const path of event.paths ?? []) paths.add(path);
      if (event.commandPreview) commands.push(event.commandPreview);
    }

    const summary: AuditSummary = {
      totalEvents: filtered.length,
      successfulEvents,
      failedEvents,
      blockedEvents,
      approvedEvents,
      tools,
      paths: [...paths].sort(),
      commands: commands.slice(-20),
      risks,
      recentEvents: filtered,
      text: "",
    };
    summary.text = formatAuditSummary(summary, options.workspaceId);
    return summary;
  }
}

export function defaultAuditLogPath(stateDir: string): string {
  return resolve(join(stateDir, "audit.jsonl"));
}

function formatAuditSummary(summary: AuditSummary, workspaceId: string | undefined): string {
  const lines = ["Session summary", ""];
  lines.push(`Scope: ${workspaceId ?? "all workspaces"}`);
  lines.push(`Events: ${summary.totalEvents}`);
  lines.push(`Successful: ${summary.successfulEvents}`);
  lines.push(`Failed: ${summary.failedEvents}`);
  lines.push(`Blocked: ${summary.blockedEvents}`);
  lines.push(`Approved: ${summary.approvedEvents}`);
  lines.push("");

  lines.push("Tools:");
  for (const [tool, count] of Object.entries(summary.tools).sort()) lines.push(`- ${tool}: ${count}`);
  if (Object.keys(summary.tools).length === 0) lines.push("- none");
  lines.push("");

  lines.push("Paths:");
  for (const path of summary.paths.slice(0, 30)) lines.push(`- ${path}`);
  if (summary.paths.length === 0) lines.push("- none");
  if (summary.paths.length > 30) lines.push(`- ... (${summary.paths.length - 30} more)`);
  lines.push("");

  lines.push("Commands:");
  for (const command of summary.commands) lines.push(`- ${command}`);
  if (summary.commands.length === 0) lines.push("- none");
  lines.push("");

  lines.push("Recent events:");
  for (const event of summary.recentEvents.slice(-20)) {
    lines.push(`- ${event.time} ${event.tool} ${event.success ? "ok" : "failed"}${event.blocked ? " blocked" : ""}`);
  }
  if (summary.recentEvents.length === 0) lines.push("- none");
  return lines.join("\n");
}
