import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { toolCatalogEntry, type ToolName } from "./tool-catalog.js";

const root = await mkdtemp(join(tmpdir(), "localspace-mcp-restart-test-"));
const accessToken = "restart-test-access-token";
const refreshToken = "restart-test-refresh-token";

try {
  await writeFile(join(root, "activity.txt"), "activity baseline\n", "utf8");
  await writeFile(join(root, "batch-a.txt"), "batch alpha\n", "utf8");
  await writeFile(join(root, "batch-b.txt"), "batch bravo\n", "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "mcp-restart-fixture",
    packageManager: "npm@10.0.0",
    scripts: {
      "check:one": "node -e \"setTimeout(() => console.log('check-one'), 120)\"",
      "check:two": "node -e \"setTimeout(() => console.log('check-two'), 120)\"",
      "check:long": "node -e \"setTimeout(() => console.log('check-long'), 250)\"",
      "check:fail": "node -e \"process.exit(2)\"",
      "check:danger": "node -e \"console.log('git reset --hard HEAD')\""
    }
  }, null, 2), "utf8");
  const config = testConfig(root);
  seedOAuthToken(config, accessToken, refreshToken);

  const first = await startServer(config);
  const initializeResponse = await mcpRequest(first.baseUrl, accessToken, initializeRequest());
  assert.equal(initializeResponse.status, 200);
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  assert.ok(sessionId);
  await initializeResponse.text();
  await first.close();

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const second = await startServer(config);
    try {
      const staleSessionResponse = await mcpRequest(
        second.baseUrl,
        accessToken,
        toolsListRequest(),
        sessionId,
      );
      assert.equal(staleSessionResponse.status, 404);
      assert.deepEqual(await staleSessionResponse.json(), {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
    } finally {
      await second.close();
    }
  } finally {
    console.warn = originalWarn;
  }

  const sessionNotFoundLog = warnings
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.event === "mcp_session_not_found");
  assert.ok(sessionNotFoundLog);
  assert.equal(sessionNotFoundLog.sessionIdPrefix, sessionId.slice(0, 8));
  assert.equal(sessionNotFoundLog.activeSessions, 0);

  const toolSurfaceBaseline = await loadToolSurfaceBaseline();
  for (const mode of ["minimal", "full", "codex", "hybrid"] as const) {
    const expected = [...toolSurfaceBaseline.widgetsOff[mode]].sort();
    const actual = await listToolNames(
      {
        ...config,
        toolMode: mode,
        widgets: "off",
        mcpTransportMode: "stateless",
      },
      accessToken,
    );
    assert.deepEqual(actual, expected, `${mode} tools/list drifted from the v1.0.6 baseline`);

    const withChangesWidget = await listToolNames(
      {
        ...config,
        toolMode: mode,
        widgets: "changes",
        mcpTransportMode: "stateless",
      },
      accessToken,
    );
    assert.deepEqual(
      withChangesWidget,
      [...expected, ...toolSurfaceBaseline.widgetsChangesAdds].sort(),
      `${mode} changes-widget tool overlay drifted from the v1.0.6 baseline`,
    );

    const withFullWidgets = await listToolNames(
      {
        ...config,
        toolMode: mode,
        widgets: "full",
        mcpTransportMode: "stateless",
      },
      accessToken,
    );
    assert.deepEqual(
      withFullWidgets,
      [...expected, ...toolSurfaceBaseline.widgetsFullAdds].sort(),
      `${mode} full-widget tool overlay drifted from the v1.0.6 baseline`,
    );
  }

  const stateless = await startServer({
    ...config,
    toolMode: "hybrid",
    mcpTransportMode: "stateless",
  });
  try {
    for (const method of ["GET", "DELETE"] as const) {
      const unsupported = await mcpHttpRequest(stateless.baseUrl, accessToken, {
        method,
      });
      assert.equal(unsupported.status, 405);
      assert.equal(unsupported.headers.get("allow"), "POST");
      assert.deepEqual(await unsupported.json(), {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed in stateless mode" },
        id: null,
      });
    }

    const statelessInitialize = await mcpRequest(stateless.baseUrl, accessToken, initializeRequest());
    assert.equal(statelessInitialize.status, 200);
    assert.equal(statelessInitialize.headers.get("mcp-session-id"), null);
    assert.match(statelessInitialize.headers.get("content-type") ?? "", /^application\/json/);
    const initializeResult = await jsonRpcResult(statelessInitialize);
    assert.equal(initializeResult.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal(recordValue(initializeResult.serverInfo, "name"), "localspace");

    const initialized = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      initializedNotification(),
    );
    assert.equal(initialized.status, 202);
    assert.equal(await initialized.text(), "");

    const statelessToolsList = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      toolsListRequest(),
      sessionId,
    );
    assert.equal(statelessToolsList.status, 200);
    assert.equal(statelessToolsList.headers.get("mcp-session-id"), null);
    const toolsListResult = await jsonRpcResult(statelessToolsList);
    const toolNames = arrayValue(toolsListResult.tools).map((tool) => recordValue(tool, "name"));
    assert.ok(toolNames.includes("open_workspace"));
    assert.ok(toolNames.includes("exec_command"));
    assert.ok(toolNames.includes("write_stdin"));

    const concurrentLists = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        mcpRequest(stateless.baseUrl, accessToken, toolsListRequest(100 + index), sessionId),
      ),
    );
    for (const response of concurrentLists) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("mcp-session-id"), null);
      const result = await jsonRpcResult(response);
      assert.ok(arrayValue(result.tools).length > 0);
    }

    const resourcesList = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      resourcesListRequest(),
      sessionId,
    );
    assert.equal(resourcesList.status, 200);
    const resources = arrayValue((await jsonRpcResult(resourcesList)).resources);
    const resourceUri = recordValue(resources[0], "uri");
    assert.equal(typeof resourceUri, "string");

    const resourceRead = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      resourcesReadRequest(String(resourceUri)),
      sessionId,
    );
    assert.equal(resourceRead.status, 200);
    const resourceContents = arrayValue((await jsonRpcResult(resourceRead)).contents);
    assert.match(String(recordValue(resourceContents[0], "text")), /<!doctype html>/i);

    const openWorkspace = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(20, "open_workspace", { path: root }),
      sessionId,
    );
    assert.equal(openWorkspace.status, 200);
    const openWorkspaceResult = await jsonRpcResult(openWorkspace);
    const workspaceId = recordValue(openWorkspaceResult.structuredContent, "workspaceId");
    assert.equal(typeof workspaceId, "string");

    const readActivity = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(23, "read", {
        workspaceId,
        path: "activity.txt",
      }),
      sessionId,
    );
    assert.equal(readActivity.status, 200);
    await jsonRpcResult(readActivity);

    const sessionSummary = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(24, "session_summary", {
        workspaceId,
        limit: 50,
      }),
      sessionId,
    );
    assert.equal(sessionSummary.status, 200);
    const sessionSummaryResult = await jsonRpcResult(sessionSummary);
    const sessionSummaryStructured = recordValue(sessionSummaryResult, "structuredContent");
    assert.equal(recordValue(sessionSummaryStructured, "totalEvents"), 2);
    assert.equal(recordValue(recordValue(sessionSummaryStructured, "tools"), "read"), 1);
    const readStats = recordValue(recordValue(sessionSummaryStructured, "toolStats"), "read");
    assert.ok(Number(recordValue(readStats, "averageOutputBytes")) > 0);
    assert.ok(Number(recordValue(readStats, "averageStructuredOutputBytes")) > 0);
    assert.equal(recordValue(sessionSummaryStructured, "durableAuditEvents"), 1);
    const requestMetrics = recordValue(sessionSummaryStructured, "requestMetrics");
    assert.equal(recordValue(requestMetrics, "totalRequests"), 1);
    assert.equal(recordValue(recordValue(requestMetrics, "tools"), "read"), 1);
    assert.equal(recordValue(requestMetrics, "statelessRequests"), 1);
    const durableAudit = await readFile(config.audit.path, "utf8");
    assert.doesNotMatch(durableAudit, /"tool":"read"/);

    const readMany = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(25, "read_many", {
        workspaceId,
        files: [
          { path: "batch-a.txt" },
          { path: "missing-batch.txt" },
          { path: "batch-b.txt", limit: 1 },
        ],
      }),
      sessionId,
    );
    assert.equal(readMany.status, 200);
    const readManyResult = await jsonRpcResult(readMany);
    const readManyStructured = recordValue(readManyResult, "structuredContent");
    const readManyResults = arrayValue(recordValue(readManyStructured, "results"));
    assert.deepEqual(
      readManyResults.map((result) => recordValue(result, "path")),
      ["batch-a.txt", "missing-batch.txt", "batch-b.txt"],
    );
    assert.equal(recordValue(readManyResults[0], "success"), true);
    assert.equal(recordValue(readManyResults[1], "success"), false);
    assert.equal(recordValue(readManyResults[2], "success"), true);
    const readManySummary = recordValue(readManyStructured, "summary");
    assert.equal(recordValue(readManySummary, "requested"), 3);
    assert.equal(recordValue(readManySummary, "succeeded"), 2);
    assert.equal(recordValue(readManySummary, "failed"), 1);

    const runChecks = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(26, "run_checks", {
        workspaceId,
        checks: ["check:one", "check:two"],
        concurrency: 2,
        yieldTimeMs: 5_000,
      }),
      sessionId,
    );
    assert.equal(runChecks.status, 200);
    const runChecksResult = await jsonRpcResult(runChecks);
    const runChecksStructured = recordValue(runChecksResult, "structuredContent");
    assert.equal(recordValue(runChecksStructured, "running"), false);
    assert.equal(recordValue(recordValue(runChecksStructured, "checkSummary"), "passed"), 2);

    const longChecks = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(27, "run_checks", {
        workspaceId,
        checks: ["check:long"],
        yieldTimeMs: 0,
      }),
      sessionId,
    );
    const longChecksResult = await jsonRpcResult(longChecks);
    const longChecksStructured = recordValue(longChecksResult, "structuredContent");
    assert.equal(recordValue(longChecksStructured, "running"), true);
    const checkSessionId = recordValue(longChecksStructured, "sessionId");
    assert.equal(typeof checkSessionId, "number");
    assert.ok(Number(checkSessionId) < 0);

    const polledChecks = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(28, "write_stdin", {
        workspaceId,
        sessionId: checkSessionId,
        yieldTimeMs: 5_000,
      }),
      sessionId,
    );
    const polledChecksResult = await jsonRpcResult(polledChecks);
    const polledChecksStructured = recordValue(polledChecksResult, "structuredContent");
    assert.equal(recordValue(polledChecksStructured, "running"), false);
    assert.equal(recordValue(recordValue(polledChecksStructured, "checkSummary"), "passed"), 1);
    assert.match(String(recordValue(polledChecksStructured, "result")), /check-long/);

    const blockedChecks = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(29, "run_checks", {
        workspaceId,
        checks: ["check:danger"],
      }),
      sessionId,
    );
    const blockedChecksResult = await jsonRpcResult(blockedChecks);
    const blockedChecksStructured = recordValue(blockedChecksResult, "structuredContent");
    assert.equal(recordValue(blockedChecksStructured, "blocked"), true);
    const approvalRequests = arrayValue(recordValue(blockedChecksStructured, "approvalRequests"));
    const checkApprovalToken = recordValue(approvalRequests[0], "approvalToken");
    assert.equal(typeof checkApprovalToken, "string");

    const approvedChecks = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(30, "run_checks", {
        workspaceId,
        checks: ["check:danger"],
        approvals: [{ check: "check:danger", approvalToken: checkApprovalToken }],
        yieldTimeMs: 5_000,
      }),
      sessionId,
    );
    const approvedChecksResult = await jsonRpcResult(approvedChecks);
    const approvedChecksStructured = recordValue(approvedChecksResult, "structuredContent");
    assert.equal(recordValue(approvedChecksStructured, "commandApproved"), true);
    assert.equal(recordValue(recordValue(approvedChecksStructured, "checkSummary"), "passed"), 1);

    const dangerousCommand = "git reset --hard HEAD";
    const blockedCommand = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(30, "exec_command", {
        workspaceId,
        cmd: dangerousCommand,
      }),
      sessionId,
    );
    assert.equal(blockedCommand.status, 200);
    const blockedCommandResult = await jsonRpcResult(blockedCommand);
    assert.equal(recordValue(blockedCommandResult.structuredContent, "approvalRequired"), true);
    const approvalToken = recordValue(blockedCommandResult.structuredContent, "approvalToken");
    assert.equal(typeof approvalToken, "string");

    const approvedCommand = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(31, "exec_command", {
        workspaceId,
        cmd: dangerousCommand,
        approvalToken,
      }),
      sessionId,
    );
    assert.equal(approvedCommand.status, 200);
    const approvedCommandResult = await jsonRpcResult(approvedCommand);
    assert.equal(recordValue(approvedCommandResult.structuredContent, "commandApproved"), true);
    assert.notEqual(recordValue(approvedCommandResult.structuredContent, "blocked"), true);

    const execCommand = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(21, "exec_command", {
        workspaceId,
        cmd: `node -e "setTimeout(() => console.log('stateless-process-done'), 1000)"`,
        yieldTimeMs: 0,
      }),
      sessionId,
    );
    assert.equal(execCommand.status, 200);
    const execCommandResult = await jsonRpcResult(execCommand);
    const processSessionId = recordValue(execCommandResult.structuredContent, "sessionId");
    assert.equal(typeof processSessionId, "number");
    assert.equal(recordValue(execCommandResult.structuredContent, "running"), true);

    const writeStdin = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(22, "write_stdin", {
        workspaceId,
        sessionId: processSessionId,
        yieldTimeMs: 5000,
      }),
      sessionId,
    );
    assert.equal(writeStdin.status, 200);
    const writeStdinResult = await jsonRpcResult(writeStdin);
    assert.equal(recordValue(writeStdinResult.structuredContent, "running"), false);
    assert.equal(recordValue(writeStdinResult.structuredContent, "exitCode"), 0);
    assert.match(
      String(recordValue(writeStdinResult.structuredContent, "result")),
      /stateless-process-done/,
    );
  } finally {
    await stateless.close();
  }

  const boundedProcesses = await startServer({
    ...config,
    toolMode: "hybrid",
    mcpTransportMode: "stateless",
    concurrency: {
      ...config.concurrency,
      maxConcurrentProcesses: 1,
      maxWorkspaceProcesses: 1,
    },
  });
  try {
    await writeFile(join(root, "concurrent-patch.txt"), "base\n", "utf8");
    const boundedWorkspaceResponse = await mcpRequest(
      boundedProcesses.baseUrl,
      accessToken,
      callToolRequest(40, "open_workspace", { path: root }),
    );
    const boundedWorkspaceResult = await jsonRpcResult(boundedWorkspaceResponse);
    const boundedWorkspaceId = recordValue(boundedWorkspaceResult.structuredContent, "workspaceId");
    assert.equal(typeof boundedWorkspaceId, "string");

    const concurrentPatchResults = await Promise.all([
      mcpRequest(
        boundedProcesses.baseUrl,
        accessToken,
        callToolRequest(43, "apply_patch", {
          workspaceId: boundedWorkspaceId,
          patch: `*** Begin Patch\n*** Update File: concurrent-patch.txt\n@@\n-base\n+first\n*** End Patch`,
        }),
      ),
      mcpRequest(
        boundedProcesses.baseUrl,
        accessToken,
        callToolRequest(44, "apply_patch", {
          workspaceId: boundedWorkspaceId,
          patch: `*** Begin Patch\n*** Update File: concurrent-patch.txt\n@@\n-base\n+second\n*** End Patch`,
        }),
      ),
    ]);
    const concurrentPatchToolResults = await Promise.all(
      concurrentPatchResults.map((response) => jsonRpcResult(response)),
    );
    assert.equal(
      concurrentPatchToolResults.filter((result) => recordValue(result, "isError") === true).length,
      1,
    );
    assert.match(
      await readFile(join(root, "concurrent-patch.txt"), "utf8"),
      /^(first|second)\n$/,
    );

    const firstBoundedProcess = await mcpRequest(
      boundedProcesses.baseUrl,
      accessToken,
      callToolRequest(41, "exec_command", {
        workspaceId: boundedWorkspaceId,
        cmd: `node -e "setTimeout(() => console.log('bounded-first'), 300)"`,
        yieldTimeMs: 0,
      }),
    );
    const firstBoundedResult = await jsonRpcResult(firstBoundedProcess);
    assert.equal(recordValue(firstBoundedResult.structuredContent, "running"), true);

    let secondBoundedResolved = false;
    const secondBoundedPromise = mcpRequest(
      boundedProcesses.baseUrl,
      accessToken,
      callToolRequest(42, "exec_command", {
        workspaceId: boundedWorkspaceId,
        cmd: `node -e "console.log('bounded-second')"`,
        yieldTimeMs: 2_000,
      }),
    ).then((response) => {
      secondBoundedResolved = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondBoundedResolved, false);

    const secondBoundedResponse = await secondBoundedPromise;
    const secondBoundedResult = await jsonRpcResult(secondBoundedResponse);
    assert.equal(recordValue(secondBoundedResult.structuredContent, "running"), false);
    assert.match(
      String(recordValue(secondBoundedResult.structuredContent, "result")),
      /bounded-second/,
    );
    assert.ok(Number(recordValue(secondBoundedResult.structuredContent, "queuedMs")) > 0);
  } finally {
    await boundedProcesses.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

function testConfig(root: string): ServerConfig {
  const stateDir = join(root, "state");
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "test-owner-token-that-is-long-enough",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      scopes: ["localspace"],
      allowedRedirectHosts: ["localhost"],
    },
    allowedRoots: [root],
    allowedHosts: ["*"],
    publicBaseUrl: "http://127.0.0.1:7676",
    toolMode: "minimal",
    widgets: "off",
    mcpTransportMode: "stateful",
    stateDir,
    worktreeRoot: join(root, "worktrees"),
    skillsEnabled: false,
    skillPaths: [],
    agentDir: join(root, ".codex"),
    logging: {
      level: "warn",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
    audit: {
      enabled: true,
      path: join(stateDir, "audit.jsonl"),
      maxMemoryEvents: 10,
    },
    mcpSessions: {
      idleTtlMs: 60_000,
      cleanupIntervalMs: 0,
      maxSessions: 4,
    },
    concurrency: {
      maxConcurrentToolCalls: 8,
      maxConcurrentScans: 2,
      maxConcurrentProcesses: 4,
      maxWorkspaceProcesses: 2,
      queueTimeoutMs: 120_000,
    },
  };
}

function seedOAuthToken(config: ServerConfig, access: string, refresh: string): void {
  const store = new SqliteOAuthStore(config.stateDir);
  try {
    const client = new SqliteOAuthClientsStore(store, config.oauth.allowedRedirectHosts).registerClient({
      redirect_uris: ["http://localhost/callback"],
      client_name: "LocalSpace restart test",
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const saved = store.saveTokenPair({
      accessTokenHash: hashToken(access),
      accessToken: {
        clientId: client.client_id,
        scopes: ["localspace"],
        expiresAt,
        resource: new URL("/mcp", config.publicBaseUrl).href,
      },
      refreshTokenHash: hashToken(refresh),
      refreshToken: {
        clientId: client.client_id,
        scopes: ["localspace"],
        expiresAt,
        resource: new URL("/mcp", config.publicBaseUrl).href,
      },
    });
    assert.equal(saved, true);
  } finally {
    store.close();
  }
}

async function startServer(config: ServerConfig): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const running = createServer(config);
  const httpServer = await listen(running.app.listen(0, config.host));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");

  return {
    baseUrl: `http://${config.host}:${address.port}`,
    close: async () => {
      await running.close();
      await closeHttpServer(httpServer);
    },
  };
}

async function listen(server: Server): Promise<Server> {
  if (server.listening) return server;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function mcpRequest(
  baseUrl: string,
  token: string,
  body: unknown,
  sessionId?: string,
): Promise<Response> {
  return mcpHttpRequest(baseUrl, token, { body, sessionId });
}

async function mcpHttpRequest(
  baseUrl: string,
  token: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    sessionId?: string;
  },
): Promise<Response> {
  const method = options.method ?? "POST";
  return fetch(`${baseUrl}/mcp`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function initializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "localspace-restart-test", version: "1.0.0" },
    },
  };
}

function initializedNotification(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  };
}

function toolsListRequest(id = 2): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {},
  };
}

function resourcesListRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 10,
    method: "resources/list",
    params: {},
  };
}

function resourcesReadRequest(uri: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 11,
    method: "resources/read",
    params: { uri },
  };
}

function callToolRequest(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  };
}

async function jsonRpcResult(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error, undefined);
  assert.ok(body.result && typeof body.result === "object" && !Array.isArray(body.result));
  return body.result as Record<string, unknown>;
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value as Record<string, unknown>[];
}

function recordValue(record: unknown, key: string): unknown {
  assert.ok(record && typeof record === "object" && !Array.isArray(record));
  return (record as Record<string, unknown>)[key];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

interface ToolSurfaceBaseline {
  version: string;
  widgetsOff: Record<"minimal" | "full" | "codex" | "hybrid", string[]>;
  widgetsChangesAdds: string[];
  widgetsFullAdds: string[];
}

interface ToolSurfaceAdditions {
  baseVersion: string;
  widgetsOffAdds: Record<"minimal" | "full" | "codex" | "hybrid", string[]>;
}

async function loadToolSurfaceBaseline(): Promise<ToolSurfaceBaseline> {
  const [baselineContent, additionsContent] = await Promise.all([
    readFile(new URL("../docs/baselines/v1.0.6-tool-surfaces.json", import.meta.url), "utf8"),
    readFile(new URL("../docs/baselines/v1.1-tool-surface-additions.json", import.meta.url), "utf8"),
  ]);
  const baseline = JSON.parse(baselineContent) as ToolSurfaceBaseline;
  const additions = JSON.parse(additionsContent) as ToolSurfaceAdditions;
  assert.equal(baseline.version, "v1.0.6");
  assert.equal(additions.baseVersion, baseline.version);
  return {
    ...baseline,
    widgetsOff: Object.fromEntries(
      Object.entries(baseline.widgetsOff).map(([mode, tools]) => [
        mode,
        [...tools, ...additions.widgetsOffAdds[mode as keyof ToolSurfaceAdditions["widgetsOffAdds"]]],
      ]),
    ) as ToolSurfaceBaseline["widgetsOff"],
  };
}

async function listToolNames(config: ServerConfig, token: string): Promise<string[]> {
  const server = await startServer(config);
  try {
    const initialize = await mcpRequest(server.baseUrl, token, initializeRequest());
    assert.equal(initialize.status, 200);
    await jsonRpcResult(initialize);

    const response = await mcpRequest(server.baseUrl, token, toolsListRequest());
    assert.equal(response.status, 200);
    const result = await jsonRpcResult(response);
    const tools = arrayValue(result.tools);
    for (const tool of tools) {
      const name = String(recordValue(tool, "name")) as ToolName;
      assert.equal(
        recordValue(tool, "description"),
        toolCatalogEntry(name).summary,
        `${config.toolMode}/${config.widgets} description drifted for ${name}`,
      );
    }
    return tools.map((tool) => String(recordValue(tool, "name"))).sort();
  } finally {
    await server.close();
  }
}
