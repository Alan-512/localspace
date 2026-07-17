import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import type { ServerConfig } from "./config.js";
import { generateDoctorReport, generateDoctorReportData, generateWorkspaceInfo, generateWorkspaceInfoData } from "./diagnostics.js";
import type { Workspace } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "localspace-diagnostics-test-"));

try {
  await mkdir(join(root, "state"));
  await mkdir(join(root, "worktrees"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "diagnostics-fixture",
      version: "1.2.3",
      engines: { node: ">=22" },
      scripts: { test: "echo test", build: "echo build" },
    }, null, 2),
  );

  await git(root, ["init"]);
  await git(root, ["config", "user.email", "localspace@example.com"]);
  await git(root, ["config", "user.name", "LocalSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md", "package.json"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const workspace = testWorkspace(root);
  const info = await generateWorkspaceInfo(workspace);
  assert.match(info, /Workspace info/);
  assert.match(info, /repository: yes/);
  assert.match(info, /status: clean/);
  assert.match(info, /name: diagnostics-fixture/);
  assert.match(info, /test: echo test/);

  const infoData = await generateWorkspaceInfoData(workspace);
  assert.equal(infoData.workspace.id, "ws_test");
  assert.equal(infoData.git.isRepository, true);
  assert.equal(infoData.git.clean, true);
  assert.equal(infoData.package?.name, "diagnostics-fixture");
  assert.equal(infoData.package?.scripts.test, "echo test");

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  const dirtyInfo = await generateWorkspaceInfo(workspace);
  assert.match(dirtyInfo, /status: dirty/);
  assert.match(dirtyInfo, /README\.md/);

  const config = testConfig(root);
  const doctor = await generateDoctorReport(config, { workspace });
  assert.match(doctor, /LocalSpace doctor/);
  assert.match(doctor, /tool mode: hybrid/);
  assert.match(doctor, /MCP transport mode: stateful/);
  assert.match(doctor, /Workspace:/);
  assert.match(doctor, /MCP session idle TTL: 14400000 ms/);
  assert.match(doctor, /MCP max sessions: 128/);
  assert.match(doctor, /OK node:/);
  assert.match(doctor, /OK git:/);
  assert.match(doctor, /Overall:/);

  const doctorData = await generateDoctorReportData(config, { workspace });
  assert.equal(doctorData.configuration.toolMode, "hybrid");
  assert.equal(doctorData.configuration.mcpTransportMode, "stateful");
  assert.equal(doctorData.workspace?.id, "ws_test");
  assert.ok(doctorData.checks.some((check) => check.name === "npm" && check.status === "ok"));
  assert.ok(doctorData.checks.some((check) => check.name === "git" && check.status === "ok"));
  assert.match(doctorData.text, /LocalSpace doctor/);
} finally {
  await rm(root, { recursive: true, force: true });
}

function testWorkspace(root: string): Workspace {
  return {
    id: "ws_test",
    root,
    mode: "checkout",
    skills: [],
    skillDiagnostics: [],
    activatedSkillDirs: new Set(),
  };
}

function testConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "test-owner-token-that-is-long-enough",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      scopes: ["localspace"],
      allowedRedirectHosts: ["chatgpt.com"],
    },
    allowedRoots: [root],
    allowedHosts: ["localhost"],
    publicBaseUrl: "http://127.0.0.1:7676",
    toolMode: "hybrid",
    widgets: "full",
    mcpTransportMode: "stateful",
    stateDir: join(root, "state"),
    worktreeRoot: join(root, "worktrees"),
    skillsEnabled: true,
    skillPaths: [],
    agentDir: join(root, ".codex"),
    logging: {
      level: "info",
      format: "json",
      requests: true,
      assets: false,
      toolCalls: true,
      shellCommands: false,
      trustProxy: false,
    },
    audit: {
      enabled: true,
      path: join(root, "state", "audit.jsonl"),
      maxMemoryEvents: 1000,
    },
    mcpSessions: {
      idleTtlMs: 14400000,
      cleanupIntervalMs: 60000,
      maxSessions: 128,
    },
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
