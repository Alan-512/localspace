import { randomUUID } from "node:crypto";
import {
  toolCatalogEntry,
  type ToolCategory,
  type ToolConcurrencyClass,
  type ToolName,
} from "./tool-catalog.js";

export interface ToolActivityInput {
  activityId?: string;
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  success: boolean;
  durationMs: number;
  queuedMs?: number;
  running?: boolean;
  exitCode?: number;
  outputBytes?: number;
  structuredOutputBytes?: number;
  truncated?: boolean;
  error?: string;
}

export interface ToolActivityEvent extends Omit<ToolActivityInput, "activityId"> {
  id: string;
  time: string;
  category: ToolCategory | "unknown";
  concurrencyClass: ToolConcurrencyClass | "unknown";
}

export interface ToolActivityStats {
  count: number;
  successful: number;
  failed: number;
  running: number;
  truncated: number;
  totalDurationMs: number;
  averageDurationMs: number;
  maxDurationMs: number;
  totalQueuedMs: number;
  maxQueuedMs: number;
  totalOutputBytes: number;
  averageOutputBytes: number;
  maxOutputBytes: number;
  totalStructuredOutputBytes: number;
  averageStructuredOutputBytes: number;
  maxStructuredOutputBytes: number;
}

export interface ToolActivitySummary {
  totalEvents: number;
  successfulEvents: number;
  failedEvents: number;
  runningEvents: number;
  truncatedEvents: number;
  processPolls: number;
  averageDurationMs: number;
  maxDurationMs: number;
  averageQueuedMs: number;
  maxQueuedMs: number;
  tools: Record<string, number>;
  categories: Record<string, number>;
  concurrencyClasses: Record<string, number>;
  toolStats: Record<string, ToolActivityStats>;
  paths: string[];
  recentEvents: ToolActivityEvent[];
  text: string;
}

export class ToolActivityLogManager {
  private readonly events: ToolActivityEvent[] = [];

  constructor(private readonly maxMemoryEvents: number) {}

  record(input: ToolActivityInput): void {
    const { activityId, ...fields } = input;
    const catalog = safeCatalogEntry(input.tool);
    const event: ToolActivityEvent = {
      id: activityId ?? `activity_${randomUUID()}`,
      time: new Date().toISOString(),
      ...fields,
      category: catalog?.category ?? "unknown",
      concurrencyClass: catalog?.concurrencyClass ?? "unknown",
    };
    this.events.push(event);
    while (this.events.length > this.maxMemoryEvents) this.events.shift();
  }

  updateResult(
    activityId: string,
    result: {
      outputBytes?: number;
      structuredOutputBytes?: number;
      truncated?: boolean;
      success?: boolean;
      error?: string;
    },
  ): boolean {
    const event = [...this.events].reverse().find((candidate) => candidate.id === activityId);
    if (!event) return false;
    if (result.outputBytes !== undefined) event.outputBytes = result.outputBytes;
    if (result.structuredOutputBytes !== undefined) {
      event.structuredOutputBytes = result.structuredOutputBytes;
    }
    if (result.truncated) event.truncated = true;
    if (result.success !== undefined) event.success = result.success;
    if (result.error !== undefined) event.error = result.error;
    return true;
  }

  summarize(options: { workspaceId?: string; limit?: number } = {}): ToolActivitySummary {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 500));
    const filtered = this.events
      .filter((event) => !options.workspaceId || event.workspaceId === options.workspaceId)
      .slice(-limit);
    const tools: Record<string, number> = {};
    const categories: Record<string, number> = {};
    const concurrencyClasses: Record<string, number> = {};
    const toolStats: Record<string, ToolActivityStats> = {};
    const paths = new Set<string>();
    let successfulEvents = 0;
    let failedEvents = 0;
    let runningEvents = 0;
    let truncatedEvents = 0;
    let processPolls = 0;
    let totalDurationMs = 0;
    let maxDurationMs = 0;
    let totalQueuedMs = 0;
    let maxQueuedMs = 0;

    for (const event of filtered) {
      tools[event.tool] = (tools[event.tool] ?? 0) + 1;
      categories[event.category] = (categories[event.category] ?? 0) + 1;
      concurrencyClasses[event.concurrencyClass] =
        (concurrencyClasses[event.concurrencyClass] ?? 0) + 1;
      if (event.success) successfulEvents += 1;
      else failedEvents += 1;
      if (event.running) runningEvents += 1;
      if (event.truncated) truncatedEvents += 1;
      if (event.tool === "write_stdin") processPolls += 1;
      if (event.path) paths.add(event.path);
      if (event.workingDirectory) paths.add(event.workingDirectory);

      totalDurationMs += event.durationMs;
      maxDurationMs = Math.max(maxDurationMs, event.durationMs);
      const queuedMs = event.queuedMs ?? 0;
      totalQueuedMs += queuedMs;
      maxQueuedMs = Math.max(maxQueuedMs, queuedMs);

      const stats = toolStats[event.tool] ?? emptyStats();
      stats.count += 1;
      if (event.success) stats.successful += 1;
      else stats.failed += 1;
      if (event.running) stats.running += 1;
      if (event.truncated) stats.truncated += 1;
      stats.totalDurationMs += event.durationMs;
      stats.maxDurationMs = Math.max(stats.maxDurationMs, event.durationMs);
      stats.totalQueuedMs += queuedMs;
      stats.maxQueuedMs = Math.max(stats.maxQueuedMs, queuedMs);
      const outputBytes = event.outputBytes ?? 0;
      const structuredOutputBytes = event.structuredOutputBytes ?? 0;
      stats.totalOutputBytes += outputBytes;
      stats.maxOutputBytes = Math.max(stats.maxOutputBytes, outputBytes);
      stats.totalStructuredOutputBytes += structuredOutputBytes;
      stats.maxStructuredOutputBytes = Math.max(
        stats.maxStructuredOutputBytes,
        structuredOutputBytes,
      );
      toolStats[event.tool] = stats;
    }

    for (const stats of Object.values(toolStats)) {
      stats.averageDurationMs = roundedAverage(stats.totalDurationMs, stats.count);
      stats.averageOutputBytes = roundedAverage(stats.totalOutputBytes, stats.count);
      stats.averageStructuredOutputBytes = roundedAverage(
        stats.totalStructuredOutputBytes,
        stats.count,
      );
    }

    const summary: ToolActivitySummary = {
      totalEvents: filtered.length,
      successfulEvents,
      failedEvents,
      runningEvents,
      truncatedEvents,
      processPolls,
      averageDurationMs: roundedAverage(totalDurationMs, filtered.length),
      maxDurationMs,
      averageQueuedMs: roundedAverage(totalQueuedMs, filtered.length),
      maxQueuedMs,
      tools,
      categories,
      concurrencyClasses,
      toolStats,
      paths: [...paths].sort(),
      recentEvents: filtered,
      text: "",
    };
    summary.text = formatActivitySummary(summary, options.workspaceId);
    return summary;
  }
}

function safeCatalogEntry(tool: string) {
  try {
    return toolCatalogEntry(tool as ToolName);
  } catch {
    return undefined;
  }
}

function emptyStats(): ToolActivityStats {
  return {
    count: 0,
    successful: 0,
    failed: 0,
    running: 0,
    truncated: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    maxDurationMs: 0,
    totalQueuedMs: 0,
    maxQueuedMs: 0,
    totalOutputBytes: 0,
    averageOutputBytes: 0,
    maxOutputBytes: 0,
    totalStructuredOutputBytes: 0,
    averageStructuredOutputBytes: 0,
    maxStructuredOutputBytes: 0,
  };
}

function roundedAverage(total: number, count: number): number {
  if (count === 0) return 0;
  return Math.round((total / count) * 100) / 100;
}

function formatActivitySummary(
  summary: ToolActivitySummary,
  workspaceId: string | undefined,
): string {
  const lines = ["Session activity summary", ""];
  lines.push(`Scope: ${workspaceId ?? "all workspaces"}`);
  lines.push(`Activities: ${summary.totalEvents}`);
  lines.push(`Successful: ${summary.successfulEvents}`);
  lines.push(`Failed: ${summary.failedEvents}`);
  lines.push(`Average duration: ${summary.averageDurationMs} ms`);
  lines.push(`Maximum duration: ${summary.maxDurationMs} ms`);
  lines.push(`Process polls: ${summary.processPolls}`);
  lines.push("");

  lines.push("Tools:");
  for (const [tool, stats] of Object.entries(summary.toolStats).sort()) {
    lines.push(
      `- ${tool}: ${stats.count} call(s), ${stats.averageDurationMs} ms average, ${stats.maxDurationMs} ms max`,
    );
  }
  if (Object.keys(summary.toolStats).length === 0) lines.push("- none");
  lines.push("");

  lines.push("Categories:");
  for (const [category, count] of Object.entries(summary.categories).sort()) {
    lines.push(`- ${category}: ${count}`);
  }
  if (Object.keys(summary.categories).length === 0) lines.push("- none");
  lines.push("");

  lines.push("Recent activities:");
  for (const event of summary.recentEvents.slice(-20)) {
    lines.push(
      `- ${event.time} ${event.tool} ${event.success ? "ok" : "failed"} ${event.durationMs}ms`,
    );
  }
  if (summary.recentEvents.length === 0) lines.push("- none");
  return lines.join("\n");
}
