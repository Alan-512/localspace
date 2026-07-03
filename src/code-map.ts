import { join } from "node:path";
import { findImports } from "./code-navigation.js";
import { findEntrypoints } from "./entrypoints.js";
import { generateProjectMap } from "./project-map.js";
import { findSymbols } from "./symbols.js";

export interface CodeMapOptions {
  path?: string;
  depth?: number;
  maxEntries?: number;
  maxSymbols?: number;
  maxImports?: number;
}

export async function generateCodeMap(
  workspaceRoot: string,
  startPath: string,
  options: CodeMapOptions = {},
): Promise<string> {
  const depth = clampInteger(options.depth, 2, 0, 6);
  const maxEntries = clampInteger(options.maxEntries, 120, 1, 1_000);
  const maxSymbols = clampInteger(options.maxSymbols, 80, 1, 500);
  const maxImports = clampInteger(options.maxImports, 80, 1, 500);

  const [entrypoints, projectMap, symbols, imports] = await Promise.all([
    findEntrypoints(workspaceRoot),
    generateProjectMap(workspaceRoot, startPath, { depth, maxEntries, includeFiles: true, showHidden: false }),
    findSymbols(workspaceRoot, startPath, { includeNonExported: false, maxResults: maxSymbols, maxFiles: 300 }),
    findImports(workspaceRoot, startPath, { maxResults: maxImports, maxFiles: 300 }),
  ]);

  return [
    "Code map",
    "",
    `Scope: ${scopeLabel(workspaceRoot, startPath)}`,
    "",
    "## Entrypoints",
    trimSection(dropLeadingTitle(entrypoints, "Entrypoints"), 80),
    "",
    "## Project structure",
    projectMap,
    "",
    "## Exported symbols",
    trimSection(symbols, maxSymbols + 8),
    "",
    "## Imports and exports",
    trimSection(imports, maxImports + 8),
  ].join("\n");
}

function scopeLabel(workspaceRoot: string, startPath: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/");
  const normalizedStart = startPath.replace(/\\/g, "/");
  if (normalizedRoot === normalizedStart) return ".";
  return normalizedStart.startsWith(`${normalizedRoot}/`)
    ? normalizedStart.slice(normalizedRoot.length + 1)
    : join(".", normalizedStart);
}

function trimSection(section: string, maxLines: number): string {
  const lines = section.split(/\r?\n/).map((line) => truncateLine(line, 240));
  if (lines.length <= maxLines) return lines.join("\n");
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join("\n");
}

function truncateLine(line: string, maxCharacters: number): string {
  if (line.length <= maxCharacters) return line;
  return `${line.slice(0, maxCharacters - 20)} ... (${line.length - maxCharacters + 20} more chars)`;
}

function dropLeadingTitle(section: string, title: string): string {
  const lines = section.split(/\r?\n/);
  if (lines[0] !== title) return section;
  const rest = lines.slice(1);
  if (rest[0] === "") rest.shift();
  return rest.join("\n");
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
