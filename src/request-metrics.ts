import { randomUUID } from "node:crypto";

export type RequestTransportMode = "stateful" | "stateless";

export interface McpRequestMetricInput {
  requestId?: string;
  transportMode: RequestTransportMode;
  httpMethod: string;
  rpcMethod?: string;
  tool?: string;
  workspaceId?: string;
  status: number;
  success: boolean;
  requestBytes?: number;
  responseBytes?: number;
  authMs: number;
  serverCreateMs: number;
  transportConnectMs: number;
  transportHandleMs: number;
  cleanupMs: number;
  totalMs: number;
}

export interface McpRequestMetric extends McpRequestMetricInput {
  id: string;
  time: string;
}

export interface RequestPhaseStats {
  averageMs: number;
  maxMs: number;
}

export interface McpRequestMetricsSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  statelessRequests: number;
  statefulRequests: number;
  averageTotalMs: number;
  maxTotalMs: number;
  averageRequestBytes: number;
  averageResponseBytes: number;
  phases: {
    auth: RequestPhaseStats;
    serverCreate: RequestPhaseStats;
    transportConnect: RequestPhaseStats;
    transportHandle: RequestPhaseStats;
    cleanup: RequestPhaseStats;
  };
  rpcMethods: Record<string, number>;
  tools: Record<string, number>;
  recentRequests: McpRequestMetric[];
}

export class McpRequestMetricsManager {
  private readonly events: McpRequestMetric[] = [];

  constructor(private readonly maxMemoryEvents: number) {}

  record(input: McpRequestMetricInput): void {
    this.events.push({
      id: `request_${randomUUID()}`,
      time: new Date().toISOString(),
      ...input,
    });
    while (this.events.length > this.maxMemoryEvents) this.events.shift();
  }

  summarize(options: { workspaceId?: string; limit?: number } = {}): McpRequestMetricsSummary {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 500));
    const filtered = this.events
      .filter((event) => !options.workspaceId || event.workspaceId === options.workspaceId)
      .slice(-limit);
    const rpcMethods: Record<string, number> = {};
    const tools: Record<string, number> = {};
    let successfulRequests = 0;
    let failedRequests = 0;
    let statelessRequests = 0;
    let statefulRequests = 0;

    for (const event of filtered) {
      if (event.success) successfulRequests += 1;
      else failedRequests += 1;
      if (event.transportMode === "stateless") statelessRequests += 1;
      else statefulRequests += 1;
      if (event.rpcMethod) rpcMethods[event.rpcMethod] = (rpcMethods[event.rpcMethod] ?? 0) + 1;
      if (event.tool) tools[event.tool] = (tools[event.tool] ?? 0) + 1;
    }

    return {
      totalRequests: filtered.length,
      successfulRequests,
      failedRequests,
      statelessRequests,
      statefulRequests,
      averageTotalMs: average(filtered.map((event) => event.totalMs)),
      maxTotalMs: maximum(filtered.map((event) => event.totalMs)),
      averageRequestBytes: averageDefined(filtered.map((event) => event.requestBytes)),
      averageResponseBytes: averageDefined(filtered.map((event) => event.responseBytes)),
      phases: {
        auth: phaseStats(filtered.map((event) => event.authMs)),
        serverCreate: phaseStats(filtered.map((event) => event.serverCreateMs)),
        transportConnect: phaseStats(filtered.map((event) => event.transportConnectMs)),
        transportHandle: phaseStats(filtered.map((event) => event.transportHandleMs)),
        cleanup: phaseStats(filtered.map((event) => event.cleanupMs)),
      },
      rpcMethods,
      tools,
      recentRequests: filtered,
    };
  }
}

function phaseStats(values: number[]): RequestPhaseStats {
  return {
    averageMs: average(values),
    maxMs: maximum(values),
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function averageDefined(values: Array<number | undefined>): number {
  return average(values.filter((value): value is number => value !== undefined));
}

function maximum(values: number[]): number {
  return round(values.length === 0 ? 0 : Math.max(...values));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
