import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LocalspaceConfigSnapshot, UserFilesSnapshot } from "../shared/types.js";

// This module mirrors the on-disk storage contract of the LocalSpace core
// (src/user-config.ts): config.json + auth.json inside ~/.localspace with a
// legacy ~/.devspace fallback. It intentionally READS only — every write goes
// through `localspace init/config` so validation stays single-sourced in the CLI.

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

export function localspaceConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const defaultDir = join(homedir(), ".localspace");
  const fallbackDir = join(homedir(), ".devspace");
  const configured = env.LOCALSPACE_CONFIG_DIR ?? env.DEVSPACE_CONFIG_DIR;
  const dir = configured ? resolve(expandHomePath(configured)) : defaultDir;
  if (dir === defaultDir && !existsSync(defaultDir) && existsSync(fallbackDir)) {
    return fallbackDir;
  }
  return dir;
}

export interface ReadUserFilesResult {
  readonly files: UserFilesSnapshot | null;
  readonly error?: string;
}

export function readUserFiles(env: NodeJS.ProcessEnv = process.env): ReadUserFilesResult {
  try {
    const dir = localspaceConfigDir(env);
    const configPath = join(dir, "config.json");
    const authPath = join(dir, "auth.json");
    const configExists = existsSync(configPath);
    const authExists = existsSync(authPath);
    const config = configExists ? readJson<LocalspaceConfigSnapshot>(configPath) : {};

    return {
      files: { dir, configPath, authPath, configExists, authExists, config },
    };
  } catch (error) {
    return { files: null, error: errorMessage(error) };
  }
}

export interface OwnerTokenResult {
  readonly ownerToken: string | null;
  readonly error?: string;
}

export function readOwnerToken(env: NodeJS.ProcessEnv = process.env): OwnerTokenResult {
  try {
    const authPath = join(localspaceConfigDir(env), "auth.json");
    if (!existsSync(authPath)) return { ownerToken: null };
    const auth = readJson<{ ownerToken?: string }>(authPath);
    return { ownerToken: typeof auth.ownerToken === "string" ? auth.ownerToken : null };
  } catch (error) {
    return { ownerToken: null, error: errorMessage(error) };
  }
}

/** Never expose the full token by accident: keep a recognizable prefix/suffix only. */
export function maskOwnerToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 8) return "•".repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export const defaultLocalPort = 7676;

export function localMcpUrl(config: LocalspaceConfigSnapshot): string {
  const host = config.host || "127.0.0.1";
  const port = typeof config.port === "number" && config.port > 0 ? config.port : defaultLocalPort;
  return `http://${host}:${port}/mcp`;
}

export function publicMcpUrl(config: LocalspaceConfigSnapshot): string | null {
  if (typeof config.publicBaseUrl !== "string" || !config.publicBaseUrl.trim()) return null;
  try {
    return new URL("/mcp", config.publicBaseUrl).toString();
  } catch {
    return null;
  }
}

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
