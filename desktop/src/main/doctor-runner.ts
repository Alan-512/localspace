import { execFile } from "node:child_process";
import type { RuntimePaths } from "./runtime-paths.js";

/** Mirrors the JSON emitted by `localspace doctor --json` in the core CLI. */
export interface DoctorCliReport {
  configDir?: string;
  config?: { path?: string; exists?: boolean };
  auth?: { path?: string; exists?: boolean };
  runtime?: {
    node?: string;
    nodeAbi?: string;
    platform?: string;
    arch?: string;
    supportedRange?: string;
    nodeSupported?: boolean;
  };
  git?: { available?: boolean; detail?: string };
  bashShell?: { available?: boolean; detail?: string };
  sqliteNative?: { ok?: boolean; error?: string };
  server?: {
    localMcpUrl?: string;
    publicMcpUrl?: string;
    allowedRoots?: ReadonlyArray<string>;
    allowedHosts?: ReadonlyArray<string>;
    mcpTransportMode?: string;
  };
  configError?: string;
}

export interface DoctorRunResult {
  readonly report: DoctorCliReport | null;
  readonly error?: string;
}

export function runDoctorJson(paths: RuntimePaths, env: NodeJS.ProcessEnv = process.env): Promise<DoctorRunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      paths.nodeExecutable,
      [paths.cliScript, "doctor", "--json"],
      { cwd: paths.serverRoot, env: { ...env }, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolvePromise({
            report: null,
            error: String(stderr).trim() || error.message,
          });
          return;
        }
        try {
          resolvePromise({ report: JSON.parse(String(stdout)) as DoctorCliReport });
        } catch (parseError) {
          resolvePromise({
            report: null,
            error: `doctor --json produced unparseable output: ${
              parseError instanceof Error ? parseError.message : String(parseError)
            }`,
          });
        }
      },
    );
  });
}
