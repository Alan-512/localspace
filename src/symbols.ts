import { opendir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";

export type SymbolKind = "class" | "function" | "interface" | "type" | "enum" | "variable" | "method";

export interface SymbolSearchOptions {
  query?: string;
  kind?: SymbolKind;
  includeNonExported?: boolean;
  maxResults?: number;
  maxFiles?: number;
}

export const DEFAULT_SYMBOL_MAX_RESULTS = 300;
export const MAX_SYMBOL_MAX_RESULTS = 2_000;
export const DEFAULT_SYMBOL_MAX_FILES = 500;
export const MAX_SYMBOL_MAX_FILES = 5_000;

export const SYMBOL_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
export const SKIPPED_SYMBOL_DIRS = new Set([
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

interface NormalizedSymbolSearchOptions {
  query?: string;
  kind?: SymbolKind;
  includeNonExported: boolean;
  maxResults: number;
  maxFiles: number;
}

export interface SymbolEntry {
  file: string;
  line: number;
  kind: SymbolKind;
  name: string;
  exported: boolean;
}

export interface SymbolSearchSummary {
  filesScanned: number;
  truncatedFiles: boolean;
  truncatedResults: boolean;
}

export interface SymbolSearchResult {
  summary: SymbolSearchSummary;
  symbols: SymbolEntry[];
  text: string;
}

export async function findSymbols(
  workspaceRoot: string,
  startPath: string,
  options: SymbolSearchOptions = {},
): Promise<string> {
  return (await findSymbolsData(workspaceRoot, startPath, options)).text;
}

export async function findSymbolsData(
  workspaceRoot: string,
  startPath: string,
  options: SymbolSearchOptions = {},
): Promise<SymbolSearchResult> {
  assertInsideRoot(workspaceRoot, startPath);
  const normalized = normalizeOptions(options);
  const files = await collectSourceFiles(startPath, normalized.maxFiles);
  const symbols: SymbolEntry[] = [];

  for (const file of files) {
    symbols.push(...collectSymbolsFromFile(workspaceRoot, file, normalized));
    if (symbols.length >= normalized.maxResults) break;
  }

  const limited = symbols.slice(0, normalized.maxResults);
  const summary = {
    filesScanned: files.length,
    truncatedFiles: files.length >= normalized.maxFiles,
    truncatedResults: symbols.length > normalized.maxResults,
  };
  return {
    summary,
    symbols: limited,
    text: formatSymbols(limited, summary),
  };
}

function normalizeOptions(options: SymbolSearchOptions): NormalizedSymbolSearchOptions {
  return {
    query: options.query?.trim().toLowerCase() || undefined,
    kind: options.kind,
    includeNonExported: options.includeNonExported ?? true,
    maxResults: clampInteger(options.maxResults, DEFAULT_SYMBOL_MAX_RESULTS, 1, MAX_SYMBOL_MAX_RESULTS),
    maxFiles: clampInteger(options.maxFiles, DEFAULT_SYMBOL_MAX_FILES, 1, MAX_SYMBOL_MAX_FILES),
  };
}

export async function collectSourceFiles(startPath: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  const startStat = await stat(startPath);
  if (startStat.isFile()) {
    if (isSourceFile(startPath)) files.push(startPath);
    return files;
  }
  if (!startStat.isDirectory()) return files;

  await walkDirectory(startPath, files, maxFiles);
  return files.sort((a, b) => a.localeCompare(b));
}

async function walkDirectory(directory: string, files: string[], maxFiles: number): Promise<void> {
  if (files.length >= maxFiles) return;
  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    if (files.length >= maxFiles) return;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_SYMBOL_DIRS.has(entry.name)) await walkDirectory(path, files, maxFiles);
      continue;
    }
    if (entry.isFile() && isSourceFile(entry.name)) files.push(path);
  }
}

function collectSymbolsFromFile(
  workspaceRoot: string,
  file: string,
  options: NormalizedSymbolSearchOptions,
): SymbolEntry[] {
  const source = ts.sys.readFile(file);
  if (!source) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const output: SymbolEntry[] = [];

  for (const statement of sourceFile.statements) {
    collectStatementSymbols(sourceFile, workspaceRoot, statement, options, output);
  }

  return output;
}

function collectStatementSymbols(
  sourceFile: ts.SourceFile,
  workspaceRoot: string,
  statement: ts.Statement,
  options: NormalizedSymbolSearchOptions,
  output: SymbolEntry[],
): void {
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    pushSymbol(sourceFile, workspaceRoot, output, options, statement, "function", statement.name.text, isExported(statement));
    return;
  }

  if (ts.isClassDeclaration(statement) && statement.name) {
    const exported = isExported(statement);
    const className = statement.name.text;
    pushSymbol(sourceFile, workspaceRoot, output, options, statement, "class", className, exported);
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      const methodName = propertyNameText(member.name);
      if (!methodName) continue;
      pushSymbol(sourceFile, workspaceRoot, output, options, member, "method", `${className}.${methodName}`, exported || isExported(member));
    }
    return;
  }

  if (ts.isInterfaceDeclaration(statement)) {
    pushSymbol(sourceFile, workspaceRoot, output, options, statement, "interface", statement.name.text, isExported(statement));
    return;
  }

  if (ts.isTypeAliasDeclaration(statement)) {
    pushSymbol(sourceFile, workspaceRoot, output, options, statement, "type", statement.name.text, isExported(statement));
    return;
  }

  if (ts.isEnumDeclaration(statement)) {
    pushSymbol(sourceFile, workspaceRoot, output, options, statement, "enum", statement.name.text, isExported(statement));
    return;
  }

  if (ts.isVariableStatement(statement)) {
    const exported = isExported(statement);
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      pushSymbol(sourceFile, workspaceRoot, output, options, declaration, "variable", declaration.name.text, exported);
    }
  }
}

function pushSymbol(
  sourceFile: ts.SourceFile,
  workspaceRoot: string,
  output: SymbolEntry[],
  options: NormalizedSymbolSearchOptions,
  node: ts.Node,
  kind: SymbolKind,
  name: string,
  exported: boolean,
): void {
  if (!options.includeNonExported && !exported) return;
  if (options.kind && options.kind !== kind) return;
  if (options.query && !name.toLowerCase().includes(options.query)) return;

  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  output.push({
    file: formatRelativePath(workspaceRoot, sourceFile.fileName),
    line: position.line + 1,
    kind,
    name,
    exported,
  });
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function formatSymbols(
  symbols: SymbolEntry[],
  summary: { filesScanned: number; truncatedFiles: boolean; truncatedResults: boolean },
): string {
  const lines = [`Files scanned: ${summary.filesScanned}`];
  if (summary.truncatedFiles) lines.push("Files truncated: true");
  if (summary.truncatedResults) lines.push("Results truncated: true");
  lines.push("");

  if (symbols.length === 0) {
    lines.push("No symbols found.");
    return lines.join("\n");
  }

  for (const symbol of symbols) {
    const exportLabel = symbol.exported ? " exported" : "";
    lines.push(`${symbol.file}:${symbol.line} ${symbol.kind}${exportLabel} ${symbol.name}`);
  }

  return lines.join("\n");
}

export function isSourceFile(path: string): boolean {
  const lower = path.toLowerCase();
  for (const extension of SYMBOL_EXTENSIONS) {
    if (lower.endsWith(extension)) return true;
  }
  return false;
}

export function formatRelativePath(workspaceRoot: string, path: string): string {
  const rel = relative(workspaceRoot, path);
  return rel.split(sep).join("/");
}

export function assertInsideRoot(workspaceRoot: string, targetPath: string): void {
  const rel = relative(workspaceRoot, targetPath);
  if (rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.includes(`..${sep}`))) return;
  throw new Error(`Path is outside workspace root: ${targetPath}`);
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
