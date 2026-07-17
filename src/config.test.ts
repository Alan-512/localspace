import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "localspace-empty-config-test-"));
const baseEnv = {
  LOCALSPACE_CONFIG_DIR: emptyConfigDir,
  LOCALSPACE_ALLOWED_ROOTS: process.cwd(),
  LOCALSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).mcpTransportMode, "stateless");
assert.equal(
  loadConfig({ ...baseEnv, LOCALSPACE_MCP_TRANSPORT_MODE: "stateful" }).mcpTransportMode,
  "stateful",
);
assert.equal(
  loadConfig({ ...baseEnv, LOCALSPACE_MCP_TRANSPORT_MODE: "stateless" }).mcpTransportMode,
  "stateless",
);
assert.equal(loadConfig(baseEnv).toolMode, "hybrid");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_TOOL_MODE: "hybrid" }).toolMode, "hybrid");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_MINIMAL_TOOLS: "1" }).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_SKILLS: "1" }).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).shell, undefined);
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_SHELL: "pwsh" }).shell, "pwsh");
assert.equal(loadConfig(baseEnv).audit.enabled, true);
assert.equal(loadConfig(baseEnv).audit.maxMemoryEvents, 1000);
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_AUDIT_LOG: "0" }).audit.enabled, false);
assert.deepEqual(loadConfig(baseEnv).mcpSessions, {
  idleTtlMs: 14400000,
  cleanupIntervalMs: 60000,
  maxSessions: 128,
});
assert.deepEqual(loadConfig({
  ...baseEnv,
  LOCALSPACE_MCP_SESSION_IDLE_TTL_MS: "120000",
  LOCALSPACE_MCP_SESSION_CLEANUP_INTERVAL_MS: "5000",
  LOCALSPACE_MCP_MAX_SESSIONS: "4",
}).mcpSessions, {
  idleTtlMs: 120000,
  cleanupIntervalMs: 5000,
  maxSessions: 4,
});

assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_WIDGETS: "invalid" }),
  /Invalid LOCALSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_WIDGETS: "minimal" }),
  /Invalid LOCALSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_WIDGETS: "write-only" }),
  /Invalid LOCALSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_TOOL_MODE: "invalid" }),
  /Invalid LOCALSPACE_TOOL_MODE: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_MCP_TRANSPORT_MODE: "invalid" }),
  /Invalid LOCALSPACE_MCP_TRANSPORT_MODE: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_MCP_SESSION_IDLE_TTL_MS: "0" }),
  /Invalid LOCALSPACE_MCP_SESSION_IDLE_TTL_MS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_MCP_MAX_SESSIONS: "0" }),
  /Invalid LOCALSPACE_MCP_MAX_SESSIONS: 0/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, LOCALSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_LOG_LEVEL: "trace" }),
  /Invalid LOCALSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_LOG_FORMAT: "color" }),
  /Invalid LOCALSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["localspace"]);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace" }).oauth.scopes,
  ["localspace"],
);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, LOCALSPACE_OAUTH_SCOPES: "localspace,admin" }).oauth.scopes,
  ["localspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, LOCALSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, LOCALSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, LOCALSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ LOCALSPACE_CONFIG_DIR: emptyConfigDir, LOCALSPACE_ALLOWED_ROOTS: process.cwd() }),
  /LOCALSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /LOCALSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, LOCALSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid LOCALSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, LOCALSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, LOCALSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, LOCALSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "localspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://localspace.example.com",
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ LOCALSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://localspace.example.com");
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "localspace.example.com",
]);

const shellConfigDir = mkdtempSync(join(tmpdir(), "localspace-shell-config-test-"));
writeFileSync(
  join(shellConfigDir, "config.json"),
  JSON.stringify({
    allowedRoots: [process.cwd()],
    shell: "bash",
  }),
);
writeFileSync(
  join(shellConfigDir, "auth.json"),
  JSON.stringify({ ownerToken: "persisted-owner-token-long-enough" }),
);
assert.equal(loadConfig({ LOCALSPACE_CONFIG_DIR: shellConfigDir }).shell, "bash");
assert.equal(loadConfig({ LOCALSPACE_CONFIG_DIR: shellConfigDir, LOCALSPACE_SHELL: "pwsh" }).shell, "pwsh");
