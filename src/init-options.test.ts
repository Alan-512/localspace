import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  InitArgsError,
  normalizePublicBaseUrl,
  parseInitArgs,
  portValidationError,
  publicBaseUrlValidationError,
  resolveNonInteractiveInit,
} from "./init-options.js";

// parseInitArgs: flags without values
{
  const parsed = parseInitArgs([]);
  assert.deepEqual(parsed, {
    force: false,
    nonInteractive: false,
    roots: [],
    port: undefined,
    publicBaseUrl: undefined,
  });
}

{
  const parsed = parseInitArgs(["--force", "--non-interactive"]);
  assert.equal(parsed.force, true);
  assert.equal(parsed.nonInteractive, true);
}

// parseInitArgs: space-separated and inline values
{
  const parsed = parseInitArgs([
    "--roots",
    "C:/work,C:/personal",
    "--port=7777",
    "--public-base-url",
    "https://demo.example.com/",
  ]);
  assert.deepEqual(parsed.roots, ["C:/work,C:/personal"]);
  assert.equal(parsed.port, "7777");
  assert.equal(parsed.publicBaseUrl, "https://demo.example.com/");
}

// parseInitArgs: boolean flags accept explicit =true/=false inline values
{
  assert.equal(parseInitArgs(["--force=false"]).force, false);
  assert.equal(parseInitArgs(["--force=true"]).force, true);
  assert.throws(() => parseInitArgs(["--force=maybe"]), InitArgsError);
}

// parseInitArgs: repeated --roots flags accumulate
assert.deepEqual(parseInitArgs(["--roots", "a", "--roots", "b,c"]).roots, ["a", "b,c"]);

// parseInitArgs: missing value for a flag
assert.throws(() => parseInitArgs(["--port"]), InitArgsError);
assert.throws(() => parseInitArgs(["--port", "--force"]), InitArgsError);

// parseInitArgs: unknown option is rejected to catch typos
assert.throws(() => parseInitArgs(["--root", "x"]), InitArgsError);
assert.throws(() => parseInitArgs(["--unexpected"]), InitArgsError);

// resolveNonInteractiveInit: defaults port, expands ~, resolves paths
{
  const parsed = parseInitArgs([
    "--non-interactive",
    "--roots",
    "~/projects,d:/repo",
    "--public-base-url",
    "https://demo.example.com",
  ]);
  const resolved = resolveNonInteractiveInit(parsed);
  assert.deepEqual(resolved.allowedRoots, [
    resolve(homedir(), "projects"),
    resolve("d:/repo"),
  ]);
  assert.equal(resolved.port, 7676);
  assert.equal(resolved.publicBaseUrl, "https://demo.example.com");
}

// resolveNonInteractiveInit: local-only setup omits the public base URL
{
  const resolved = resolveNonInteractiveInit(
    parseInitArgs(["--non-interactive", "--roots", "~/projects", "--port", "7788"]),
  );
  assert.equal(resolved.publicBaseUrl, null);
  assert.equal(resolved.port, 7788);
}

// resolveNonInteractiveInit: normalizes trailing slashes on the public URL
{
  const resolved = resolveNonInteractiveInit(
    parseInitArgs(["--roots", "x", "--public-base-url", "https://demo.example.com/"]),
  );
  assert.equal(resolved.publicBaseUrl, "https://demo.example.com");
}

// resolveNonInteractiveInit: rejects missing roots
assert.throws(() => resolveNonInteractiveInit(parseInitArgs([])), /at least one project root/);

// resolveNonInteractiveInit: rejects invalid ports
for (const badPort of ["0", "65536", "abc"]) {
  assert.throws(
    () => resolveNonInteractiveInit(parseInitArgs(["--roots", "x", "--port", badPort])),
    /Invalid --port/,
  );
}
assert.equal(portValidationError("1"), undefined);
assert.equal(portValidationError("65535"), undefined);

// resolveNonInteractiveInit: rejects invalid public base URLs (empty means local-only)
for (const badUrl of ["https://demo.example.com/mcp", "ftp://demo.example.com", "not a url"]) {
  assert.throws(
    () => resolveNonInteractiveInit(parseInitArgs(["--roots", "x", "--public-base-url", badUrl])),
    /Invalid --public-base-url/,
  );
}
assert.equal(publicBaseUrlValidationError("https://ok.example.com"), undefined);
assert.equal(publicBaseUrlValidationError("http://192.168.1.10:7676"), undefined);
assert.ok(publicBaseUrlValidationError(undefined));

// normalizePublicBaseUrl strips query, hash, and trailing slash
assert.equal(normalizePublicBaseUrl("https://demo.example.com/a/?q=1#frag"), "https://demo.example.com/a");
assert.equal(normalizePublicBaseUrl("https://demo.example.com/"), "https://demo.example.com");
