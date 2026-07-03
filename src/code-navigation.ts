import ts from "typescript";
import { assertInsideRoot, collectSourceFiles, formatRelativePath } from "./symbols.js";

export interface ImportSearchOptions {
  maxFiles?: number;
  maxResults?: number;
}

export interface ReferenceSearchOptions {
  query: string;
  includeDefinitions?: boolean;
  caseSensitive?: boolean;
  maxFiles?: number;
  maxResults?: number;
}

const DEFAULT_NAV_MAX_FILES = 500;
const MAX_NAV_MAX_FILES = 5_000;
const DEFAULT_NAV_MAX_RESULTS = 500;
const MAX_NAV_MAX_RESULTS = 5_000;

export interface ImportExportEntry {
  file: string;
  line: number;
  kind: "import" | "export" | "dynamic-import";
  module?: string;
  names: string[];
}

export interface ReferenceEntry {
  file: string;
  line: number;
  column: number;
  name: string;
  kind: "reference" | "definition";
  context: string;
}

export interface ImportSearchResult {
  summary: {
    filesScanned: number;
    truncatedFiles: boolean;
    truncatedResults: boolean;
  };
  entries: ImportExportEntry[];
  text: string;
}

export interface ReferenceSearchResult {
  summary: {
    query: string;
    filesScanned: number;
    truncatedFiles: boolean;
    truncatedResults: boolean;
  };
  references: ReferenceEntry[];
  text: string;
}

export async function findImports(
  workspaceRoot: string,
  startPath: string,
  options: ImportSearchOptions = {},
): Promise<string> {
  return (await findImportsData(workspaceRoot, startPath, options)).text;
}

export async function findImportsData(
  workspaceRoot: string,
  startPath: string,
  options: ImportSearchOptions = {},
): Promise<ImportSearchResult> {
  assertInsideRoot(workspaceRoot, startPath);
  const maxFiles = clampInteger(options.maxFiles, DEFAULT_NAV_MAX_FILES, 1, MAX_NAV_MAX_FILES);
  const maxResults = clampInteger(options.maxResults, DEFAULT_NAV_MAX_RESULTS, 1, MAX_NAV_MAX_RESULTS);
  const files = await collectSourceFiles(startPath, maxFiles);
  const entries: ImportExportEntry[] = [];

  for (const file of files) {
    entries.push(...collectImportExportEntries(workspaceRoot, file));
    if (entries.length >= maxResults) break;
  }

  const limited = entries.slice(0, maxResults);
  const summary = {
    filesScanned: files.length,
    truncatedFiles: files.length >= maxFiles,
    truncatedResults: entries.length > maxResults,
  };
  return {
    summary,
    entries: limited,
    text: formatImportExportEntries(limited, summary),
  };
}

export async function findReferences(
  workspaceRoot: string,
  startPath: string,
  options: ReferenceSearchOptions,
): Promise<string> {
  return (await findReferencesData(workspaceRoot, startPath, options)).text;
}

export async function findReferencesData(
  workspaceRoot: string,
  startPath: string,
  options: ReferenceSearchOptions,
): Promise<ReferenceSearchResult> {
  assertInsideRoot(workspaceRoot, startPath);
  const query = options.query.trim();
  if (!query) {
    return {
      summary: { query, filesScanned: 0, truncatedFiles: false, truncatedResults: false },
      references: [],
      text: "Query is required.",
    };
  }
  const maxFiles = clampInteger(options.maxFiles, DEFAULT_NAV_MAX_FILES, 1, MAX_NAV_MAX_FILES);
  const maxResults = clampInteger(options.maxResults, DEFAULT_NAV_MAX_RESULTS, 1, MAX_NAV_MAX_RESULTS);
  const files = await collectSourceFiles(startPath, maxFiles);
  const references: ReferenceEntry[] = [];

  for (const file of files) {
    references.push(...collectReferences(workspaceRoot, file, {
      query,
      includeDefinitions: options.includeDefinitions ?? false,
      caseSensitive: options.caseSensitive ?? true,
    }));
    if (references.length >= maxResults) break;
  }

  const limited = references.slice(0, maxResults);
  const summary = {
    query,
    filesScanned: files.length,
    truncatedFiles: files.length >= maxFiles,
    truncatedResults: references.length > maxResults,
  };
  return {
    summary,
    references: limited,
    text: formatReferences(limited, summary),
  };
}

function collectImportExportEntries(workspaceRoot: string, file: string): ImportExportEntry[] {
  const source = ts.sys.readFile(file);
  if (!source) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const entries: ImportExportEntry[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      entries.push({
        file: formatRelativePath(workspaceRoot, file),
        line: lineNumber(sourceFile, statement),
        kind: "import",
        module: stringLiteralText(statement.moduleSpecifier),
        names: importNames(statement),
      });
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      entries.push({
        file: formatRelativePath(workspaceRoot, file),
        line: lineNumber(sourceFile, statement),
        kind: "export",
        module: statement.moduleSpecifier ? stringLiteralText(statement.moduleSpecifier) : undefined,
        names: exportDeclarationNames(statement),
      });
      continue;
    }

    const exportNames = exportedStatementNames(statement);
    if (exportNames.length > 0) {
      entries.push({
        file: formatRelativePath(workspaceRoot, file),
        line: lineNumber(sourceFile, statement),
        kind: "export",
        names: exportNames,
      });
    }
  }

  visitDynamicImports(sourceFile, sourceFile, workspaceRoot, file, entries);
  return entries;
}

function visitDynamicImports(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  workspaceRoot: string,
  file: string,
  entries: ImportExportEntry[],
): void {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
    entries.push({
      file: formatRelativePath(workspaceRoot, file),
      line: lineNumber(sourceFile, node),
      kind: "dynamic-import",
      module: stringLiteralText(node.arguments[0]),
      names: [],
    });
  }
  ts.forEachChild(node, (child) => visitDynamicImports(sourceFile, child, workspaceRoot, file, entries));
}

function collectReferences(
  workspaceRoot: string,
  file: string,
  options: { query: string; includeDefinitions: boolean; caseSensitive: boolean },
): ReferenceEntry[] {
  const source = ts.sys.readFile(file);
  if (!source) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines = source.split(/\r?\n/);
  const output: ReferenceEntry[] = [];
  const wanted = options.caseSensitive ? options.query : options.query.toLowerCase();

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      const comparable = options.caseSensitive ? name : name.toLowerCase();
      if (comparable === wanted) {
        const definition = isDefinitionIdentifier(node);
        if (options.includeDefinitions || !definition) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          output.push({
            file: formatRelativePath(workspaceRoot, file),
            line: position.line + 1,
            column: position.character + 1,
            name,
            kind: definition ? "definition" : "reference",
            context: (lines[position.line] ?? "").trim(),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return output;
}

function importNames(statement: ts.ImportDeclaration): string[] {
  const clause = statement.importClause;
  if (!clause) return ["side-effect"];
  const names: string[] = [];
  if (clause.name) names.push(`default:${clause.name.text}`);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(`namespace:${bindings.name.text}`);
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) names.push(importExportSpecifierName(element));
  }
  return names;
}

function exportDeclarationNames(statement: ts.ExportDeclaration): string[] {
  const clause = statement.exportClause;
  if (!clause) return statement.moduleSpecifier ? ["*"] : [];
  if (ts.isNamespaceExport(clause)) return [`namespace:${clause.name.text}`];
  return clause.elements.map(importExportSpecifierName);
}

function exportedStatementNames(statement: ts.Statement): string[] {
  if (!isExported(statement)) return [];
  if (ts.isFunctionDeclaration(statement) && statement.name) return [statement.name.text];
  if (ts.isClassDeclaration(statement) && statement.name) return [statement.name.text];
  if (ts.isInterfaceDeclaration(statement)) return [statement.name.text];
  if (ts.isTypeAliasDeclaration(statement)) return [statement.name.text];
  if (ts.isEnumDeclaration(statement)) return [statement.name.text];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (ts.isExportAssignment(statement)) return [statement.isExportEquals ? "export=" : "default"];
  return [];
}

function importExportSpecifierName(element: ts.ImportSpecifier | ts.ExportSpecifier): string {
  return element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text;
}

function isDefinitionIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  if (ts.isExportSpecifier(parent)) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return true;
  if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return true;
  if (ts.isEnumDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  return false;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function lineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function formatImportExportEntries(
  entries: ImportExportEntry[],
  summary: { filesScanned: number; truncatedFiles: boolean; truncatedResults: boolean },
): string {
  const lines = [`Files scanned: ${summary.filesScanned}`];
  if (summary.truncatedFiles) lines.push("Files truncated: true");
  if (summary.truncatedResults) lines.push("Results truncated: true");
  lines.push("");

  if (entries.length === 0) {
    lines.push("No imports or exports found.");
    return lines.join("\n");
  }

  for (const entry of entries) {
    const moduleLabel = entry.module ? ` from ${entry.module}` : "";
    const names = entry.names.length > 0 ? ` { ${entry.names.join(", ")} }` : "";
    lines.push(`${entry.file}:${entry.line} ${entry.kind}${moduleLabel}${names}`);
  }
  return lines.join("\n");
}

function formatReferences(
  references: ReferenceEntry[],
  summary: { query: string; filesScanned: number; truncatedFiles: boolean; truncatedResults: boolean },
): string {
  const lines = [`Query: ${summary.query}`, `Files scanned: ${summary.filesScanned}`];
  if (summary.truncatedFiles) lines.push("Files truncated: true");
  if (summary.truncatedResults) lines.push("Results truncated: true");
  lines.push("");

  if (references.length === 0) {
    lines.push("No references found.");
    return lines.join("\n");
  }

  for (const ref of references) {
    lines.push(`${ref.file}:${ref.line}:${ref.column} ${ref.kind} ${ref.name} — ${ref.context}`);
  }
  return lines.join("\n");
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
