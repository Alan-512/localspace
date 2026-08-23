import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface RuntimePaths {
  /** Absolute path of the Node binary used for the sidecar process. */
  readonly nodeExecutable: string;
  /** Directory containing dist/cli.js plus its node_modules and skills. */
  readonly serverRoot: string;
  readonly cliScript: string;
}

export class CoreRuntimeMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreRuntimeMissingError";
  }
}

export interface ResolveRuntimePathsOptions {
  readonly isPackaged: boolean;
  /** Electron's process.resourcesPath (ignored in dev). */
  readonly resourcesPath: string;
  /** Repo root when running from a checkout; unused when packaged. */
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Dev mode runs `node <repo>/dist/cli.js` with the system Node from PATH.
 * Packaged mode runs the bundled sidecar binary against resources/server,
 * so native modules such as better-sqlite3 keep their standard prebuilds.
 */
export function resolveRuntimePaths(options: ResolveRuntimePathsOptions): RuntimePaths {
  const env = options.env ?? process.env;
  const platformBinary = process.platform === "win32" ? "node.exe" : "node";

  let nodeExecutable: string;
  let serverRoot: string;

  if (options.isPackaged) {
    nodeExecutable = env.LOCALSPACE_DESKTOP_NODE_BIN
      ? resolve(expandHome(env.LOCALSPACE_DESKTOP_NODE_BIN))
      : join(options.resourcesPath, "bin", platformBinary);
    serverRoot = env.LOCALSPACE_DESKTOP_SERVER_ROOT
      ? resolve(expandHome(env.LOCALSPACE_DESKTOP_SERVER_ROOT))
      : join(options.resourcesPath, "server");
  } else {
    nodeExecutable = env.LOCALSPACE_DESKTOP_NODE_BIN
      ? resolve(expandHome(env.LOCALSPACE_DESKTOP_NODE_BIN))
      : "node";
    serverRoot = env.LOCALSPACE_DESKTOP_SERVER_ROOT
      ? resolve(expandHome(env.LOCALSPACE_DESKTOP_SERVER_ROOT))
      : options.repoRoot;
  }

  const cliScript = join(serverRoot, "dist", "cli.js");
  if (!existsSync(cliScript)) {
    throw new CoreRuntimeMissingError(
      options.isPackaged
        ? `LocalSpace core runtime is missing at ${cliScript}. Reinstall the application.`
        : `LocalSpace core is not built; run \`npm run build\` in the repository root first (${cliScript}).`,
    );
  }
  if (nodeExecutable !== "node" && !existsSync(nodeExecutable)) {
    throw new CoreRuntimeMissingError(
      `Configured Node binary does not exist: ${nodeExecutable}. ` +
        "Run desktop/scripts/prepare-server.mjs or set LOCALSPACE_DESKTOP_NODE_BIN.",
    );
  }

  return { nodeExecutable, serverRoot, cliScript };
}

function expandHome(path: string): string {
  if (process.platform === "win32" && /^~[\\/]/.test(path)) {
    return join(process.env.USERPROFILE ?? "", path.slice(2));
  }
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(process.env.HOME ?? "", path.slice(2));
  }
  return path;
}
