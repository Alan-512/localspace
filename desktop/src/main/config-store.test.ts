import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localMcpUrl,
  localspaceConfigDir,
  maskOwnerToken,
  publicMcpUrl,
  readOwnerToken,
  readUserFiles,
} from "./config-store.js";

// localspaceConfigDir honors LOCALSPACE_CONFIG_DIR
{
  const dir = mkdtempSync(join(tmpdir(), "localspace-desktop-config-"));
  assert.equal(localspaceConfigDir({ LOCALSPACE_CONFIG_DIR: dir }), join(dir, ""));
}

// readUserFiles: missing files report exists=false with defaults
{
  const dir = mkdtempSync(join(tmpdir(), "localspace-desktop-empty-"));
  const result = readUserFiles({ LOCALSPACE_CONFIG_DIR: dir });
  assert.ok(result.files);
  assert.equal(result.files.configExists, false);
  assert.equal(result.files.authExists, false);
  assert.equal(result.error, undefined);
}

// readUserFiles: parses config and reports both files present
{
  const dir = mkdtempSync(join(tmpdir(), "localspace-desktop-full-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ host: "127.0.0.1", port: 7788, allowedRoots: ["d:/work"], publicBaseUrl: "https://demo.example.com/" }),
  );
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ ownerToken: "abcd1234-wxyz-very-long-token-value" }));

  const result = readUserFiles({ LOCALSPACE_CONFIG_DIR: dir });
  assert.ok(result.files);
  assert.equal(result.files.configExists, true);
  assert.equal(result.files.authExists, true);
  assert.deepEqual(result.files.config.allowedRoots, ["d:/work"]);

  // URL derivation
  assert.equal(localMcpUrl(result.files.config), "http://127.0.0.1:7788/mcp");
  assert.equal(publicMcpUrl(result.files.config), "https://demo.example.com/mcp");
  assert.equal(localMcpUrl({}), "http://127.0.0.1:7676/mcp");
  assert.equal(publicMcpUrl({ publicBaseUrl: null }), null);
  assert.equal(publicMcpUrl({ publicBaseUrl: "not a url" }), null);

  // token reading + masking
  const auth = readOwnerToken({ LOCALSPACE_CONFIG_DIR: dir });
  assert.equal(auth.error, undefined);
  assert.ok(auth.ownerToken?.startsWith("abcd"));
  assert.equal(maskOwnerToken(auth.ownerToken), "abcd…alue");
  assert.equal(maskOwnerToken("short"), "•••••");
  assert.equal(maskOwnerToken(null), null);
}

// readUserFiles: malformed JSON surfaces an error instead of throwing
{
  const dir = mkdtempSync(join(tmpdir(), "localspace-desktop-broken-"));
  writeFileSync(join(dir, "config.json"), "{not json");
  const result = readUserFiles({ LOCALSPACE_CONFIG_DIR: dir });
  assert.equal(result.files, null);
  assert.match(result.error ?? "", /Unable to read/);
}
