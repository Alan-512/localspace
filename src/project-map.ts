import { opendir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface ProjectMapOptions {
  depth?: number;
  maxEntries?: number;
  includeFiles?: boolean;
  showHidden?: boolean;
}

export const DEFAULT_PROJECT_MAP_DEPTH = 3;
export const MAX_PROJECT_MAP_DEPTH = 8;
export const DEFAULT_PROJECT_MAP_MAX_ENTRIES = 300;
export const MAX_PROJECT_MAP_MAX_ENTRIES = 2_000;

const DEFAULT_SKIPPED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".localspace",
  ".devspace",
]);

interface NormalizedProjectMapOptions {
  depth: number;
  maxEntries: number;
  includeFiles: boolean;
  showHidden: boolean;
}

interface RenderState {
  lines: string[];
  entries: number;
  truncated: boolean;
}

interface MapEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

export async function generateProjectMap(
  workspaceRoot: string,
  startPath: string,
  options: ProjectMapOptions = {},
): Promise<string> {
  assertInsideRoot(workspaceRoot, startPath);
  const normalized = normalizeOptions(options);
  const state: RenderState = {
    lines: [formatRootLabel(workspaceRoot, startPath)],
    entries: 0,
    truncated: false,
  };

  await renderDirectory(startPath, normalized, state, "", 0);

  if (state.truncated) {
    state.lines.push(`... (truncated after ${normalized.maxEntries} entries)`);
  }

  return state.lines.join("\n");
}

function normalizeOptions(options: ProjectMapOptions): NormalizedProjectMapOptions {
  return {
    depth: clampInteger(options.depth, DEFAULT_PROJECT_MAP_DEPTH, 0, MAX_PROJECT_MAP_DEPTH),
    maxEntries: clampInteger(
      options.maxEntries,
      DEFAULT_PROJECT_MAP_MAX_ENTRIES,
      1,
      MAX_PROJECT_MAP_MAX_ENTRIES,
    ),
    includeFiles: options.includeFiles ?? true,
    showHidden: options.showHidden ?? false,
  };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function renderDirectory(
  directory: string,
  options: NormalizedProjectMapOptions,
  state: RenderState,
  prefix: string,
  currentDepth: number,
): Promise<void> {
  if (state.truncated || currentDepth >= options.depth) return;

  const entries = await listEntries(directory, options);

  for (let index = 0; index < entries.length; index += 1) {
    if (state.entries >= options.maxEntries) {
      state.truncated = true;
      return;
    }

    const entry = entries[index];
    const isLast = index === entries.length - 1;
    const connector = isLast ? "└─ " : "├─ ";
    state.lines.push(`${prefix}${connector}${entry.name}${entry.kind === "directory" ? "/" : ""}`);
    state.entries += 1;

    if (entry.kind === "directory") {
      const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;
      await renderDirectory(entry.path, options, state, childPrefix, currentDepth + 1);
    }
  }
}

async function listEntries(
  directory: string,
  options: NormalizedProjectMapOptions,
): Promise<MapEntry[]> {
  const entries: MapEntry[] = [];
  let handle;

  try {
    handle = await opendir(directory);
  } catch {
    return entries;
  }

  for await (const entry of handle) {
    if (!options.showHidden && entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (DEFAULT_SKIPPED_DIRS.has(entry.name)) continue;
      entries.push({
        name: entry.name,
        path: join(directory, entry.name),
        kind: "directory",
      });
      continue;
    }

    if (!options.includeFiles || !entry.isFile()) continue;
    entries.push({
      name: entry.name,
      path: join(directory, entry.name),
      kind: "file",
    });
  }

  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function formatRootLabel(workspaceRoot: string, startPath: string): string {
  const rel = relative(workspaceRoot, startPath);
  if (!rel) return ".";
  return rel.split(sep).join("/");
}

function assertInsideRoot(workspaceRoot: string, targetPath: string): void {
  const rel = relative(workspaceRoot, targetPath);
  if (rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.includes(`..${sep}`))) return;
  throw new Error(`Path is outside workspace root: ${targetPath}`);
}
