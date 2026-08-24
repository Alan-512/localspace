import { resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export interface ParsedInitArgs {
  force: boolean;
  nonInteractive: boolean;
  roots: string[];
  port?: string;
  publicBaseUrl?: string;
}

export interface ResolvedNonInteractiveInit {
  allowedRoots: string[];
  port: number;
  /** null means local-only setup: the core derives http://127.0.0.1:<port>. */
  publicBaseUrl: string | null;
}

export const defaultInitPort = 7676;

export class InitArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitArgsError";
  }
}

export function parseInitArgs(argv: readonly string[]): ParsedInitArgs {
  const parsed: ParsedInitArgs = {
    force: false,
    nonInteractive: false,
    roots: [],
    port: undefined,
    publicBaseUrl: undefined,
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? "";
    index += 1;

    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : arg.slice(separator + 1);

    if (flag === "--force") {
      parsed.force = readBooleanFlagValue(flag, inlineValue);
      continue;
    }
    if (flag === "--non-interactive") {
      parsed.nonInteractive = readBooleanFlagValue(flag, inlineValue);
      continue;
    }

    const value = readFlagValue(argv, flag, inlineValue, () => index);
    if (flag === "--roots") {
      parsed.roots.push(value.value);
      index = value.nextIndex;
      continue;
    }
    if (flag === "--port") {
      parsed.port = value.value;
      index = value.nextIndex;
      continue;
    }
    if (flag === "--public-base-url") {
      parsed.publicBaseUrl = value.value;
      index = value.nextIndex;
      continue;
    }
    throw new InitArgsError(`Unknown init option: ${arg}`);
  }

  return parsed;
}

function readFlagValue(
  argv: readonly string[],
  flag: string,
  inlineValue: string | undefined,
  currentIndex: () => number,
): { value: string; nextIndex: number } {
  if (inlineValue !== undefined) {
    return { value: inlineValue, nextIndex: currentIndex() };
  }
  const next = argv[currentIndex()];
  if (next === undefined || next.startsWith("--")) {
    throw new InitArgsError(`Missing value for ${flag}.`);
  }
  return { value: next, nextIndex: currentIndex() + 1 };
}

function readBooleanFlagValue(flag: string, inlineValue: string | undefined): boolean {
  if (inlineValue === undefined || inlineValue === "true") return true;
  if (inlineValue === "false") return false;
  throw new InitArgsError(`${flag} does not take a value; use ${flag}=true or ${flag}=false.`);
}

export function portValidationError(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

export function publicBaseUrlValidationError(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

export function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function resolveNonInteractiveInit(parsed: ParsedInitArgs): ResolvedNonInteractiveInit {
  const allowedRoots = parsed.roots
    .flatMap((value) => value.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(expandHomePath(entry)));
  if (!allowedRoots.length) {
    throw new InitArgsError(
      'init --non-interactive requires at least one project root: pass --roots "<path1>,<path2>".',
    );
  }

  const requestedPort = parsed.port ?? String(defaultInitPort);
  const portError = portValidationError(requestedPort);
  if (portError) {
    throw new InitArgsError(`Invalid --port "${parsed.port}": ${portError}`);
  }

  const requestedPublicBaseUrl = parsed.publicBaseUrl?.trim() ?? "";
  if (!requestedPublicBaseUrl) {
    // Local-only setup: loadConfig derives http://127.0.0.1:<port> when the
    // persisted publicBaseUrl is absent, so no flag is needed.
    return { allowedRoots, port: Number(requestedPort), publicBaseUrl: null };
  }
  const publicBaseUrlError = publicBaseUrlValidationError(requestedPublicBaseUrl);
  if (publicBaseUrlError) {
    throw new InitArgsError(`Invalid --public-base-url: ${publicBaseUrlError}`);
  }

  return {
    allowedRoots,
    port: Number(requestedPort),
    publicBaseUrl: normalizePublicBaseUrl(requestedPublicBaseUrl),
  };
}
