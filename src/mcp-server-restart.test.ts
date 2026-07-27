import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const codeLib = [
    "export interface Runner {",
    "  run(): string;",
    "}",
    "",
    "export function run(): string {",
    '  return "ok";',
    "}",
    "",
  ].join("\n");
  const codeMain = [
    'import { run, type Runner } from "./ci-lib.js";',
    "",
    "export class Implementation implements Runner {",
    "  run(): string {",
    "    return run();",
    "  }",
    "}",
    "",
    "export const broken: string = 123;",
    "",
  ].join("\n");
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext"
    },
    include: ["ci-*.ts"]
  }, null, 2), "utf8");
  await writeFile(join(root, "ci-lib.ts"), codeLib, "utf8");
  await writeFile(join(root, "ci-main.ts"), codeMain, "utf8");
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
  const policyRoot = join(root, "policy-workspace");
  await mkdir(join(policyRoot, ".localspace"), { recursive: true });
  await writeFile(join(policyRoot, "locked.txt"), "locked\n", "utf8");
  await writeFile(join(policyRoot, "free.txt"), "free\n", "utf8");
  await writeFile(join(policyRoot, "other.txt"), "other\n", "utf8");
  await writeFile(join(policyRoot, "package.json"), JSON.stringify({
    name: "policy-workspace",
    scripts: {
      "precheck:allowed": "node -e \"console.log('policy-precheck-allowed')\"",
      "check:allowed": "node -e \"console.log('policy-check-allowed')\"",
      "check:blocked": "node -e \"console.log('policy-check-blocked')\"",
      "precheck:hooked": "node -e \"console.log('policy-precheck-hooked')\"",
      "check:hooked": "node -e \"console.log('policy-check-hooked')\""
    }
  }, null, 2), "utf8");
  await writeFile(join(policyRoot, ".localspace", "policy.json"), JSON.stringify({
    version: 1,
    readOnlyPaths: ["locked.txt"],
    deniedCommandPatterns: ["*blocked-command*"],
    allowedPackageScripts: ["precheck:allowed", "check:allowed", "check:hooked"],
    maxReadManyFiles: 1,
    allowCommands: true,
    allowPty: false,
    requireApprovalTools: ["exec_command", "run_checks"]
  }, null, 2), "utf8");
  const automationRoot = join(root, "automation-workspace");
  await mkdir(join(automationRoot, "src"), { recursive: true });
  await writeFile(join(automationRoot, "src", "index.ts"), "export const answer = 42;\n", "utf8");
  await writeFile(join(automationRoot, "README.md"), "automation fixture\n", "utf8");
  await writeFile(join(automationRoot, "package.json"), JSON.stringify({
    name: "automation-workspace",
    scripts: {
      test: "node -e \"setTimeout(() => console.log('automation-test-pass'), 120)\"",
      ci: "node -e \"setTimeout(() => console.log('automation-ci-pass'), 120)\" -- typecheck",
      "commit:bypass": "git commit -m bypass"
    }
  }, null, 2), "utf8");
  execFileSync("git", ["init"], { cwd: automationRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "automation@localspace.invalid"], { cwd: automationRoot });
  execFileSync("git", ["config", "user.name", "LocalSpace Automation Test"], { cwd: automationRoot });
  execFileSync("git", ["add", "--", "."], { cwd: automationRoot });
  execFileSync("git", ["commit", "-m", "initial automation fixture"], { cwd: automationRoot, stdio: "ignore" });
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

  for (const mode of ["minimal", "full", "codex", "hybrid"] as const) {
    const expected = [
      ...toolSurfaceBaseline.widgetsOff[mode],
      ...toolSurfaceBaseline.toolPackAdds["code-intelligence"],
    ].sort();
    const actual = await listToolNames(
      {
        ...config,
        toolMode: mode,
        toolPacks: ["code-intelligence"],
        widgets: "off",
        mcpTransportMode: "stateless",
      },
      accessToken,
    );
    assert.deepEqual(actual, expected, `${mode} code-intelligence pack drifted`);
  }

  const codeServer = await startServer({
    ...config,
    toolMode: "hybrid",
    toolPacks: ["code-intelligence"],
    widgets: "off",
    mcpTransportMode: "stateless",
  });
  try {
    const initialized = await mcpRequest(codeServer.baseUrl, accessToken, initializeRequest());
    assert.equal(initialized.status, 200);
    await jsonRpcResult(initialized);
    const opened = await mcpRequest(
      codeServer.baseUrl,
      accessToken,
      callToolRequest(501, "open_workspace", { path: root }),
    );
    const codeWorkspaceId = recordValue((await jsonRpcResult(opened)).structuredContent, "workspaceId");
    assert.equal(typeof codeWorkspaceId, "string");

    const diagnosticResponse = await mcpRequest(
      codeServer.baseUrl,
      accessToken,
      callToolRequest(502, "diagnostics", {
        workspaceId: codeWorkspaceId,
        path: "ci-main.ts",
      }),
    );
    const diagnosticResult = await jsonRpcResult(diagnosticResponse);
    assert.equal(recordValue(diagnosticResult.structuredContent, "supported"), true);
    assert.ok(
      arrayValue(recordValue(diagnosticResult.structuredContent, "diagnostics"))
        .some((item) => recordValue(item, "code") === 2322),
    );

    const definitionResponse = await mcpRequest(
      codeServer.baseUrl,
      accessToken,
      callToolRequest(503, "definition", {
        workspaceId: codeWorkspaceId,
        path: "ci-main.ts",
        line: 5,
        column: 12,
      }),
    );
    const definitionResult = await jsonRpcResult(definitionResponse);
    assert.ok(
      arrayValue(recordValue(definitionResult.structuredContent, "locations"))
        .some((item) => recordValue(item, "path") === "ci-lib.ts"),
    );

    const implementationResponse = await mcpRequest(
      codeServer.baseUrl,
      accessToken,
      callToolRequest(504, "implementations", {
        workspaceId: codeWorkspaceId,
        path: "ci-lib.ts",
        line: 1,
        column: 18,
      }),
    );
    const implementationResult = await jsonRpcResult(implementationResponse);
    assert.ok(
      arrayValue(recordValue(implementationResult.structuredContent, "locations"))
        .some((item) => recordValue(item, "path") === "ci-main.ts"),
    );

    const libBeforeRename = await readFile(join(root, "ci-lib.ts"), "utf8");
    const mainBeforeRename = await readFile(join(root, "ci-main.ts"), "utf8");
    const renameResponse = await mcpRequest(
      codeServer.baseUrl,
      accessToken,
      callToolRequest(505, "rename_preview", {
        workspaceId: codeWorkspaceId,
        path: "ci-lib.ts",
        line: 5,
        column: 17,
        newName: "execute",
      }),
    );
    const renameResult = await jsonRpcResult(renameResponse);
    assert.equal(recordValue(renameResult.structuredContent, "canRename"), true);
    assert.ok(arrayValue(recordValue(renameResult.structuredContent, "edits")).length >= 2);
    assert.equal(await readFile(join(root, "ci-lib.ts"), "utf8"), libBeforeRename);
    assert.equal(await readFile(join(root, "ci-main.ts"), "utf8"), mainBeforeRename);
  } finally {
    await codeServer.close();
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
    const serverInstructions = recordValue(initializeResult, "instructions");
    assert.equal(typeof serverInstructions, "string");
    assert.match(String(serverInstructions), /up to 8 tool calls globally/);
    assert.match(String(serverInstructions), /capped at 2 scans/);
    assert.match(String(serverInstructions), /limited to 4 globally and 2 per workspace/);
    assert.match(String(serverInstructions), /Prefer `read_many` for multiple known files/);
    assert.match(String(serverInstructions), /Prefer `run_checks` for independent declared package scripts/);
    assert.match(String(serverInstructions), /same process session must be sequential/);

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
    const advertisedSkills = arrayValue(
      recordValue(openWorkspaceResult.structuredContent, "skills"),
    );
    const advertisedSkillNames = new Set(
      advertisedSkills.map((skill) => String(recordValue(skill, "name"))),
    );
    for (const name of [
      "localspace-debugging",
      "localspace-code-review",
      "localspace-refactoring",
    ]) {
      assert.equal(advertisedSkillNames.has(name), true, `open_workspace did not advertise ${name}`);
    }

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
    assert.equal(recordValue(sessionSummaryStructured, "durableAuditEvents"), 2);
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

    const policyOpen = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(601, "open_workspace", { path: policyRoot }),
      sessionId,
    );
    const policyOpenResult = await jsonRpcResult(policyOpen);
    const policyWorkspaceId = recordValue(policyOpenResult.structuredContent, "workspaceId");
    assert.equal(typeof policyWorkspaceId, "string");
    const policyInfo = recordValue(policyOpenResult.structuredContent, "policy");
    assert.equal(recordValue(policyInfo, "status"), "active");
    assert.equal(recordValue(policyInfo, "valid"), true);
    assert.equal(recordValue(policyInfo, "maxReadManyFiles"), 1);
    assert.equal(recordValue(policyInfo, "allowPty"), false);

    const policyReadMany = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(602, "read_many", {
        workspaceId: policyWorkspaceId,
        files: [{ path: "free.txt" }, { path: "other.txt" }],
      }),
      sessionId,
    );
    const policyReadManyResult = await jsonRpcResult(policyReadMany);
    assert.equal(recordValue(policyReadManyResult, "isError"), true);
    assert.match(toolResultText(policyReadManyResult), /policy maximum is 1/i);

    const policyPatch = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(603, "apply_patch", {
        workspaceId: policyWorkspaceId,
        patch: "*** Begin Patch\n*** Update File: locked.txt\n@@\n-locked\n+changed\n*** End Patch",
      }),
      sessionId,
    );
    const policyPatchResult = await jsonRpcResult(policyPatch);
    assert.equal(recordValue(policyPatchResult, "isError"), true);
    assert.match(toolResultText(policyPatchResult), /read-only policy path locked\.txt/i);
    assert.equal(await readFile(join(policyRoot, "locked.txt"), "utf8"), "locked\n");

    const policyGitAddDirectory = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(6031, "git_add", {
        workspaceId: policyWorkspaceId,
        paths: ["."],
      }),
      sessionId,
    );
    const policyGitAddDirectoryResult = await jsonRpcResult(policyGitAddDirectory);
    assert.equal(recordValue(policyGitAddDirectoryResult, "isError"), true);
    assert.match(toolResultText(policyGitAddDirectoryResult), /requires explicit file paths/i);

    const deniedPolicyCommand = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(604, "exec_command", {
        workspaceId: policyWorkspaceId,
        cmd: "node -e \"console.log('blocked-command')\"",
      }),
      sessionId,
    );
    const deniedPolicyCommandResult = await jsonRpcResult(deniedPolicyCommand);
    assert.equal(recordValue(deniedPolicyCommandResult, "isError"), true);
    assert.match(toolResultText(deniedPolicyCommandResult), /denied pattern/i);

    const policyCommand = "node -e \"console.log('policy-command-ok')\"";
    const approvalPolicyCommand = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(605, "exec_command", {
        workspaceId: policyWorkspaceId,
        cmd: policyCommand,
      }),
      sessionId,
    );
    const approvalPolicyCommandResult = await jsonRpcResult(approvalPolicyCommand);
    assert.equal(recordValue(approvalPolicyCommandResult.structuredContent, "approvalRequired"), true);
    const policyCommandToken = recordValue(
      approvalPolicyCommandResult.structuredContent,
      "approvalToken",
    );
    assert.equal(typeof policyCommandToken, "string");

    const approvedPolicyCommand = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(606, "exec_command", {
        workspaceId: policyWorkspaceId,
        cmd: policyCommand,
        approvalToken: policyCommandToken,
        yieldTimeMs: 5_000,
      }),
      sessionId,
    );
    const approvedPolicyCommandResult = await jsonRpcResult(approvedPolicyCommand);
    assert.equal(recordValue(approvedPolicyCommandResult.structuredContent, "commandApproved"), true);
    assert.match(
      String(recordValue(approvedPolicyCommandResult.structuredContent, "result")),
      /policy-command-ok/,
    );

    const policyBlockedCheck = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(607, "run_checks", {
        workspaceId: policyWorkspaceId,
        checks: ["check:blocked"],
      }),
      sessionId,
    );
    const policyBlockedCheckResult = await jsonRpcResult(policyBlockedCheck);
    assert.equal(recordValue(policyBlockedCheckResult, "isError"), true);
    assert.match(toolResultText(policyBlockedCheckResult), /not allowed: check:blocked/i);

    const policyHookedCheck = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(6071, "run_checks", {
        workspaceId: policyWorkspaceId,
        checks: ["check:hooked"],
      }),
      sessionId,
    );
    const policyHookedCheckResult = await jsonRpcResult(policyHookedCheck);
    assert.equal(recordValue(policyHookedCheckResult, "isError"), true);
    assert.match(toolResultText(policyHookedCheckResult), /precheck:hooked/i);

    const policyAllowedCheck = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(608, "run_checks", {
        workspaceId: policyWorkspaceId,
        checks: ["check:allowed"],
      }),
      sessionId,
    );
    const policyAllowedCheckResult = await jsonRpcResult(policyAllowedCheck);
    assert.equal(recordValue(policyAllowedCheckResult.structuredContent, "approvalRequired"), true);
    const policyApprovalRequests = arrayValue(
      recordValue(policyAllowedCheckResult.structuredContent, "approvalRequests"),
    );
    const policyCheckToken = recordValue(policyApprovalRequests[0], "approvalToken");
    assert.equal(typeof policyCheckToken, "string");

    const policyApprovedCheck = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(609, "run_checks", {
        workspaceId: policyWorkspaceId,
        checks: ["check:allowed"],
        approvals: [{ check: "check:allowed", approvalToken: policyCheckToken }],
        yieldTimeMs: 5_000,
      }),
      sessionId,
    );
    const policyApprovedCheckResult = await jsonRpcResult(policyApprovedCheck);
    assert.equal(recordValue(policyApprovedCheckResult.structuredContent, "commandApproved"), true);
    assert.equal(
      recordValue(recordValue(policyApprovedCheckResult.structuredContent, "checkSummary"), "passed"),
      1,
    );

    const policySummary = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(610, "session_summary", {
        workspaceId: policyWorkspaceId,
        limit: 50,
      }),
      sessionId,
    );
    const policySummaryResult = await jsonRpcResult(policySummary);
    const policySummaryStructured = recordValue(policySummaryResult, "structuredContent");
    const policyAuditEvents = arrayValue(
      recordValue(policySummaryStructured, "recentAuditEvents"),
    );
    assert.ok(
      policyAuditEvents.some((event) =>
        String(recordValue(event, "action")).startsWith("policy_block:")
      ),
    );

    const automationOpen = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(620, "open_workspace", { path: automationRoot }),
      sessionId,
    );
    const automationOpenResult = await jsonRpcResult(automationOpen);
    const automationWorkspaceId = recordValue(automationOpenResult.structuredContent, "workspaceId");
    assert.equal(typeof automationWorkspaceId, "string");

    const directCommitBypass = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(6201, "exec_command", {
        workspaceId: automationWorkspaceId,
        cmd: "git commit -m bypass",
      }),
      sessionId,
    );
    const directCommitBypassResult = await jsonRpcResult(directCommitBypass);
    assert.equal(recordValue(directCommitBypassResult, "isError"), true);
    assert.match(toolResultText(directCommitBypassResult), /use the dedicated git_commit tool/i);

    const packageCommitBypass = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(6202, "run_checks", {
        workspaceId: automationWorkspaceId,
        checks: ["commit:bypass"],
      }),
      sessionId,
    );
    const packageCommitBypassResult = await jsonRpcResult(packageCommitBypass);
    assert.equal(recordValue(packageCommitBypassResult, "isError"), true);
    assert.match(toolResultText(packageCommitBypassResult), /use the dedicated git_commit tool/i);

    const bypassSummary = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(6203, "session_summary", {
        workspaceId: automationWorkspaceId,
        limit: 10,
      }),
      sessionId,
    );
    const bypassSummaryResult = await jsonRpcResult(bypassSummary);
    const bypassAuditEvents = arrayValue(
      recordValue(recordValue(bypassSummaryResult, "structuredContent"), "recentAuditEvents"),
    );
    assert.ok(
      bypassAuditEvents.some((event) =>
        recordValue(event, "action") === "direct_git_commit_block"
      ),
    );

    const firstSourcePatch = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(621, "apply_patch", {
        workspaceId: automationWorkspaceId,
        patch: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-export const answer = 42;\n+export const answer = 43;\n*** End Patch",
      }),
      sessionId,
    );
    assert.equal(recordValue(await jsonRpcResult(firstSourcePatch), "isError"), undefined);

    const firstStage = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(622, "git_add", {
        workspaceId: automationWorkspaceId,
        paths: ["src/index.ts"],
      }),
      sessionId,
    );
    assert.equal(recordValue(await jsonRpcResult(firstStage), "isError"), undefined);

    const blockedCommit = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(623, "git_commit", {
        workspaceId: automationWorkspaceId,
        message: "test: require deterministic preflight",
      }),
      sessionId,
    );
    const blockedCommitResult = await jsonRpcResult(blockedCommit);
    const blockedCommitStructured = recordValue(blockedCommitResult, "structuredContent");
    assert.equal(recordValue(blockedCommitStructured, "blocked"), true);
    assert.equal(recordValue(blockedCommitStructured, "approvalRequired"), true);
    assert.equal(recordValue(blockedCommitStructured, "committed"), false);
    const blockedAutomation = recordValue(blockedCommitStructured, "automation");
    assert.equal(recordValue(blockedAutomation, "validationFreshness"), "unknown");
    assert.equal(recordValue(blockedAutomation, "commitReviewRequired"), true);
    const firstCommitToken = recordValue(blockedCommitStructured, "approvalToken");
    assert.equal(typeof firstCommitToken, "string");

    const changedSourcePatch = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(624, "apply_patch", {
        workspaceId: automationWorkspaceId,
        patch: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-export const answer = 43;\n+export const answer = 44;\n*** End Patch",
      }),
      sessionId,
    );
    assert.equal(recordValue(await jsonRpcResult(changedSourcePatch), "isError"), undefined);
    const changedStage = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(625, "git_add", {
        workspaceId: automationWorkspaceId,
        paths: ["src/index.ts"],
      }),
      sessionId,
    );
    assert.equal(recordValue(await jsonRpcResult(changedStage), "isError"), undefined);

    const mismatchedCommit = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(626, "git_commit", {
        workspaceId: automationWorkspaceId,
        message: "test: require deterministic preflight",
        approvalToken: firstCommitToken,
      }),
      sessionId,
    );
    const mismatchedCommitResult = await jsonRpcResult(mismatchedCommit);
    const mismatchedCommitStructured = recordValue(mismatchedCommitResult, "structuredContent");
    assert.equal(recordValue(mismatchedCommitStructured, "blocked"), true);
    assert.equal(recordValue(mismatchedCommitStructured, "approvalFailureReason"), "mismatch");
    const secondCommitToken = recordValue(mismatchedCommitStructured, "approvalToken");
    assert.equal(typeof secondCommitToken, "string");

    const approvedCommit = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(627, "git_commit", {
        workspaceId: automationWorkspaceId,
        message: "test: require deterministic preflight",
        approvalToken: secondCommitToken,
      }),
      sessionId,
    );
    const approvedCommitResult = await jsonRpcResult(approvedCommit);
    const approvedCommitStructured = recordValue(approvedCommitResult, "structuredContent");
    assert.equal(recordValue(approvedCommitStructured, "committed"), true);
    assert.equal(recordValue(approvedCommitStructured, "commandApproved"), true);

    const docsPatch = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(628, "apply_patch", {
        workspaceId: automationWorkspaceId,
        patch: "*** Begin Patch\n*** Update File: README.md\n@@\n-automation fixture\n+automation fixture updated\n*** End Patch",
      }),
      sessionId,
    );
    assert.equal(recordValue(await jsonRpcResult(docsPatch), "isError"), undefined);
    const docsStage = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(629, "git_add", {
        workspaceId: automationWorkspaceId,
        paths: ["README.md"],
      }),
      sessionId,
    );
    assert.equal(recordValue(await jsonRpcResult(docsStage), "isError"), undefined);
    const docsCommit = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(630, "git_commit", {
        workspaceId: automationWorkspaceId,
        message: "docs: update automation fixture",
      }),
      sessionId,
    );
    const docsCommitResult = await jsonRpcResult(docsCommit);
    const docsCommitStructured = recordValue(docsCommitResult, "structuredContent");
    assert.equal(recordValue(docsCommitStructured, "committed"), true);
    assert.equal(recordValue(docsCommitStructured, "approvalRequired"), undefined);
    assert.equal(
      recordValue(recordValue(docsCommitStructured, "automation"), "validationFreshness"),
      "not-required",
    );

    const validatedSourcePatch = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(631, "apply_patch", {
        workspaceId: automationWorkspaceId,
        patch: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-export const answer = 44;\n+export const answer = 45;\n*** End Patch",
      }),
      sessionId,
    );
    assert.equal(recordValue(await jsonRpcResult(validatedSourcePatch), "isError"), undefined);
    const validationCommand = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(632, "exec_command", {
        workspaceId: automationWorkspaceId,
        cmd: "npm test",
        yieldTimeMs: 0,
      }),
      sessionId,
    );
    const validationCommandResult = await jsonRpcResult(validationCommand);
    assert.equal(recordValue(validationCommandResult.structuredContent, "running"), true);
    const validationSessionId = recordValue(validationCommandResult.structuredContent, "sessionId");
    assert.equal(typeof validationSessionId, "number");
    const validationPoll = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(6321, "write_stdin", {
        workspaceId: automationWorkspaceId,
        sessionId: validationSessionId,
        yieldTimeMs: 5_000,
      }),
      sessionId,
    );
    const validationPollResult = await jsonRpcResult(validationPoll);
    assert.match(
      String(recordValue(validationPollResult.structuredContent, "result")),
      /automation-test-pass/,
    );
    const validatedStage = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(633, "git_add", {
        workspaceId: automationWorkspaceId,
        paths: ["src/index.ts"],
      }),
      sessionId,
    );
    assert.equal(recordValue(await jsonRpcResult(validatedStage), "isError"), undefined);
    const validatedCommit = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(634, "git_commit", {
        workspaceId: automationWorkspaceId,
        message: "test: accept current validation evidence",
      }),
      sessionId,
    );
    const validatedCommitResult = await jsonRpcResult(validatedCommit);
    const validatedCommitStructured = recordValue(validatedCommitResult, "structuredContent");
    assert.equal(recordValue(validatedCommitStructured, "committed"), true);
    assert.equal(recordValue(validatedCommitStructured, "approvalRequired"), undefined);
    assert.equal(
      recordValue(recordValue(validatedCommitStructured, "automation"), "validationFreshness"),
      "current",
    );

    const checkValidatedPatch = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(635, "apply_patch", {
        workspaceId: automationWorkspaceId,
        patch: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-export const answer = 45;\n+export const answer = 46;\n*** End Patch",
      }),
      sessionId,
    );
    assert.equal(recordValue(await jsonRpcResult(checkValidatedPatch), "isError"), undefined);
    const validationCheck = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(636, "run_checks", {
        workspaceId: automationWorkspaceId,
        checks: ["ci"],
        yieldTimeMs: 0,
      }),
      sessionId,
    );
    const validationCheckResult = await jsonRpcResult(validationCheck);
    assert.equal(recordValue(validationCheckResult.structuredContent, "running"), true);
    const validationCheckSessionId = recordValue(validationCheckResult.structuredContent, "sessionId");
    assert.equal(typeof validationCheckSessionId, "number");
    const validationCheckPoll = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(637, "write_stdin", {
        workspaceId: automationWorkspaceId,
        sessionId: validationCheckSessionId,
        yieldTimeMs: 5_000,
      }),
      sessionId,
    );
    const validationCheckPollResult = await jsonRpcResult(validationCheckPoll);
    assert.match(
      String(recordValue(validationCheckPollResult.structuredContent, "result")),
      /automation-ci-pass/,
    );
    const validationCheckResults = arrayValue(
      recordValue(validationCheckPollResult.structuredContent, "checks"),
    );
    assert.equal(recordValue(validationCheckResults[0], "validationAction"), "validation:typecheck");
    const checkValidatedStage = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(638, "git_add", {
        workspaceId: automationWorkspaceId,
        paths: ["src/index.ts"],
      }),
      sessionId,
    );
    assert.equal(recordValue(await jsonRpcResult(checkValidatedStage), "isError"), undefined);
    const checkValidatedCommit = await mcpRequest(
      stateless.baseUrl,
      accessToken,
      callToolRequest(639, "git_commit", {
        workspaceId: automationWorkspaceId,
        message: "test: accept check-session validation evidence",
      }),
      sessionId,
    );
    const checkValidatedCommitResult = await jsonRpcResult(checkValidatedCommit);
    const checkValidatedCommitStructured = recordValue(checkValidatedCommitResult, "structuredContent");
    assert.equal(recordValue(checkValidatedCommitStructured, "committed"), true);
    assert.equal(recordValue(checkValidatedCommitStructured, "approvalRequired"), undefined);
    const checkValidatedAutomation = recordValue(checkValidatedCommitStructured, "automation");
    assert.equal(recordValue(checkValidatedAutomation, "validationFreshness"), "current");
    const checkValidationEvidence = recordValue(checkValidatedAutomation, "validationEvidence");
    assert.ok(Array.isArray(checkValidationEvidence));
    assert.ok(checkValidationEvidence.includes("typecheck"));

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
    toolPacks: [],
    widgets: "off",
    mcpTransportMode: "stateful",
    stateDir,
    worktreeRoot: join(root, "worktrees"),
    skillsEnabled: true,
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

function toolResultText(result: Record<string, unknown>): string {
  const content = arrayValue(recordValue(result, "content"));
  return content.map((block) => String(recordValue(block, "text") ?? "")).join("\n");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

interface ToolSurfaceBaseline {
  version: string;
  widgetsOff: Record<"minimal" | "full" | "codex" | "hybrid", string[]>;
  widgetsChangesAdds: string[];
  widgetsFullAdds: string[];
  toolPackAdds: Record<"code-intelligence", string[]>;
}

interface ToolSurfaceAdditions {
  baseVersion: string;
  widgetsOffAdds: Record<"minimal" | "full" | "codex" | "hybrid", string[]>;
  toolPackAdds: Record<"code-intelligence", string[]>;
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
    toolPackAdds: additions.toolPackAdds,
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
