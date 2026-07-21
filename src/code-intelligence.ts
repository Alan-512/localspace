import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

type TypeScriptModule = typeof import("typescript");
type LanguageService = import("typescript").LanguageService;
type CompilerOptions = import("typescript").CompilerOptions;
type ProjectReference = import("typescript").ProjectReference;
type Diagnostic = import("typescript").Diagnostic;
type TextSpan = import("typescript").TextSpan;

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const DEFAULT_MAX_DIAGNOSTICS = 100;
const MAX_DIAGNOSTICS = 500;
const DEFAULT_MAX_LOCATIONS = 200;
const MAX_LOCATIONS = 1_000;
const DEFAULT_MAX_PROJECT_FILES = 5_000;
const DEFAULT_MAX_CACHED_PROJECTS = 32;

export type DiagnosticScope = "all" | "syntactic" | "semantic" | "suggestion";

export interface CodeIntelligenceProject {
  kind: "configured" | "inferred";
  configPath?: string;
  rootFileCount: number;
  projectReferences: string[];
}

export interface CodeIntelligencePosition {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface CodeDiagnostic extends CodeIntelligencePosition {
  category: "warning" | "error" | "suggestion" | "message";
  code: number;
  message: string;
  source?: string;
}

export interface CodeProjectDiagnostic {
  category: "warning" | "error" | "suggestion" | "message";
  code: number;
  message: string;
  source?: string;
}

export interface DiagnosticsResult {
  supported: boolean;
  reason?: string;
  project?: CodeIntelligenceProject;
  summary: {
    files: number;
    diagnostics: number;
    errors: number;
    warnings: number;
    suggestions: number;
    messages: number;
    truncated: boolean;
  };
  diagnostics: CodeDiagnostic[];
  projectDiagnostics: CodeProjectDiagnostic[];
}

export interface CodeLocation extends CodeIntelligencePosition {
  kind: string;
  name: string;
  containerName?: string;
}

export interface LocationsResult {
  supported: boolean;
  reason?: string;
  project?: CodeIntelligenceProject;
  locations: CodeLocation[];
  omittedExternal: number;
  truncated: boolean;
}

export interface RenamePreviewEdit extends CodeIntelligencePosition {
  oldText: string;
  newText: string;
}

export interface RenamePreviewResult {
  supported: boolean;
  canRename: boolean;
  reason?: string;
  displayName?: string;
  fullDisplayName?: string;
  kind?: string;
  project?: CodeIntelligenceProject;
  edits: RenamePreviewEdit[];
  files: number;
  omittedExternal: number;
  truncated: boolean;
}

interface ProjectDescriptor {
  key: string;
  signature: string;
  root: string;
  kind: CodeIntelligenceProject["kind"];
  configPath?: string;
  compilerOptions: CompilerOptions;
  fileNames: string[];
  projectReferences?: readonly ProjectReference[];
  projectReferencePaths: string[];
  configErrors: Diagnostic[];
}

interface CachedProject {
  signature: string;
  project: WorkspaceLanguageProject;
}

export class CodeIntelligenceManager {
  private readonly maxProjectFiles: number;
  private readonly maxCachedProjects: number;
  private readonly loadTypeScript: () => Promise<TypeScriptModule>;
  private readonly projects = new Map<string, CachedProject>();
  private typescriptPromise?: Promise<TypeScriptModule>;

  constructor(options: {
    maxProjectFiles?: number;
    maxCachedProjects?: number;
    loadTypeScript?: () => Promise<TypeScriptModule>;
  } = {}) {
    this.maxProjectFiles = options.maxProjectFiles ?? DEFAULT_MAX_PROJECT_FILES;
    this.maxCachedProjects = boundedInteger(
      options.maxCachedProjects,
      DEFAULT_MAX_CACHED_PROJECTS,
      256,
      "maxCachedProjects",
    );
    this.loadTypeScript = options.loadTypeScript ?? (() => import("typescript"));
  }

  async diagnostics(input: {
    root: string;
    path?: string;
    scope?: DiagnosticScope;
    maxResults?: number;
  }): Promise<DiagnosticsResult> {
    if (input.path && !supportedSourcePath(input.path)) {
      return unsupportedDiagnostics(`Unsupported source file type: ${extname(input.path) || "none"}`);
    }
    const maxResults = boundedInteger(
      input.maxResults,
      DEFAULT_MAX_DIAGNOSTICS,
      MAX_DIAGNOSTICS,
      "maxResults",
    );
    let project: WorkspaceLanguageProject;
    try {
      project = await this.project(input.root, input.path);
    } catch (error) {
      return unsupportedDiagnostics(error instanceof Error ? error.message : String(error));
    }
    const scope = input.scope ?? "all";
    const diagnostics: Diagnostic[] = [];
    let truncated = false;
    const append = (items: readonly Diagnostic[]): boolean => {
      for (const item of items) {
        if (diagnostics.length >= maxResults) {
          truncated = true;
          return false;
        }
        diagnostics.push(item);
      }
      return true;
    };

    if (scope === "all") {
      append(project.descriptor.configErrors);
      append(project.service.getCompilerOptionsDiagnostics());
    }
    const files = input.path
      ? [resolve(input.path)]
      : project.descriptor.fileNames.filter((file) => supportedSourcePath(file));
    for (const file of files) {
      if (!appendDiagnostics(project.service, file, scope, append)) break;
    }

    const converted: CodeDiagnostic[] = [];
    const projectDiagnostics: CodeProjectDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
      const fileDiagnostic = convertDiagnostic(project, diagnostic);
      if (fileDiagnostic) converted.push(fileDiagnostic);
      else projectDiagnostics.push(convertProjectDiagnostic(project, diagnostic));
    }
    const allDiagnostics = [...converted, ...projectDiagnostics];
    const summary = {
      files: files.length,
      diagnostics: allDiagnostics.length,
      errors: allDiagnostics.filter((item) => item.category === "error").length,
      warnings: allDiagnostics.filter((item) => item.category === "warning").length,
      suggestions: allDiagnostics.filter((item) => item.category === "suggestion").length,
      messages: allDiagnostics.filter((item) => item.category === "message").length,
      truncated,
    };
    return {
      supported: true,
      project: project.metadata(),
      summary,
      diagnostics: converted,
      projectDiagnostics,
    };
  }

  async definitions(input: {
    root: string;
    path: string;
    line: number;
    column: number;
    maxResults?: number;
  }): Promise<LocationsResult> {
    return this.locations("definition", input);
  }

  async implementations(input: {
    root: string;
    path: string;
    line: number;
    column: number;
    maxResults?: number;
  }): Promise<LocationsResult> {
    return this.locations("implementation", input);
  }

  async renamePreview(input: {
    root: string;
    path: string;
    line: number;
    column: number;
    newName: string;
    maxLocations?: number;
  }): Promise<RenamePreviewResult> {
    if (!supportedSourcePath(input.path)) {
      return unsupportedRename(`Unsupported source file type: ${extname(input.path) || "none"}`);
    }
    validateRenameText(input.newName);
    const maxLocations = boundedInteger(
      input.maxLocations,
      DEFAULT_MAX_LOCATIONS,
      MAX_LOCATIONS,
      "maxLocations",
    );
    const project = await this.project(input.root, input.path);
    if (!project.isIdentifierText(input.newName)) {
      return {
        supported: true,
        canRename: false,
        reason: `newName is not a valid TypeScript/JavaScript identifier: ${input.newName}`,
        project: project.metadata(),
        edits: [],
        files: 0,
        omittedExternal: 0,
        truncated: false,
      };
    }
    const position = project.position(input.path, input.line, input.column);
    const info = project.service.getRenameInfo(input.path, position, {
      allowRenameOfImportPath: false,
      providePrefixAndSuffixTextForRename: true,
    });
    if (!info.canRename) {
      return {
        supported: true,
        canRename: false,
        reason: info.localizedErrorMessage,
        project: project.metadata(),
        edits: [],
        files: 0,
        omittedExternal: 0,
        truncated: false,
      };
    }

    const locations = project.service.findRenameLocations(
      input.path,
      position,
      false,
      false,
      true,
    ) ?? [];
    const edits: RenamePreviewEdit[] = [];
    let omittedExternal = 0;
    let truncated = false;
    for (const location of locations) {
      if (!isPathInside(location.fileName, project.root)) {
        omittedExternal += 1;
        continue;
      }
      if (edits.length >= maxLocations) {
        truncated = true;
        break;
      }
      const text = project.read(location.fileName);
      const positionData = project.span(location.fileName, location.textSpan);
      edits.push({
        ...positionData,
        oldText: text.slice(
          location.textSpan.start,
          location.textSpan.start + location.textSpan.length,
        ),
        newText: `${location.prefixText ?? ""}${input.newName}${location.suffixText ?? ""}`,
      });
    }
    return {
      supported: true,
      canRename: true,
      displayName: info.displayName,
      fullDisplayName: info.fullDisplayName,
      kind: info.kind,
      project: project.metadata(),
      edits,
      files: new Set(edits.map((edit) => edit.path)).size,
      omittedExternal,
      truncated,
    };
  }

  dispose(): void {
    for (const cached of this.projects.values()) cached.project.dispose();
    this.projects.clear();
  }

  private async locations(
    kind: "definition" | "implementation",
    input: {
      root: string;
      path: string;
      line: number;
      column: number;
      maxResults?: number;
    },
  ): Promise<LocationsResult> {
    if (!supportedSourcePath(input.path)) {
      return {
        supported: false,
        reason: `Unsupported source file type: ${extname(input.path) || "none"}`,
        locations: [],
        omittedExternal: 0,
        truncated: false,
      };
    }
    const maxResults = boundedInteger(
      input.maxResults,
      DEFAULT_MAX_LOCATIONS,
      MAX_LOCATIONS,
      "maxResults",
    );
    const project = await this.project(input.root, input.path);
    const position = project.position(input.path, input.line, input.column);
    const semanticDefinitions = kind === "definition"
      ? project.symbolDefinitions(input.path, position)
      : [];
    if (semanticDefinitions.length > 0) {
      const locations = semanticDefinitions.slice(0, maxResults);
      return {
        supported: true,
        project: project.metadata(),
        locations,
        omittedExternal: 0,
        truncated: semanticDefinitions.length > maxResults,
      };
    }
    const raw = kind === "definition"
      ? expandDefinitionAliases(
          project.service,
          project.service.getDefinitionAndBoundSpan(input.path, position)?.definitions ?? [],
        )
      : project.service.getImplementationAtPosition(input.path, position) ?? [];
    const locations: CodeLocation[] = [];
    let omittedExternal = 0;
    let truncated = false;
    for (const item of raw) {
      if (!isPathInside(item.fileName, project.root)) {
        omittedExternal += 1;
        continue;
      }
      if (locations.length >= maxResults) {
        truncated = true;
        break;
      }
      locations.push({
        ...project.span(item.fileName, item.textSpan),
        kind: item.kind,
        name: "name" in item
          ? item.name
          : project.displayParts(item.displayParts),
        containerName: "containerName" in item ? item.containerName : undefined,
      });
    }
    return {
      supported: true,
      project: project.metadata(),
      locations,
      omittedExternal,
      truncated,
    };
  }

  private async project(root: string, targetPath?: string): Promise<WorkspaceLanguageProject> {
    const ts = await this.typescript();
    const descriptor = createProjectDescriptor(
      ts,
      resolve(root),
      targetPath ? resolve(targetPath) : undefined,
      this.maxProjectFiles,
    );
    const cached = this.projects.get(descriptor.key);
    if (cached?.signature === descriptor.signature) {
      this.projects.delete(descriptor.key);
      this.projects.set(descriptor.key, cached);
      return cached.project;
    }
    cached?.project.dispose();
    this.projects.delete(descriptor.key);
    const project = new WorkspaceLanguageProject(ts, descriptor);
    this.projects.set(descriptor.key, { signature: descriptor.signature, project });
    while (this.projects.size > this.maxCachedProjects) {
      const oldestKey = this.projects.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.projects.get(oldestKey);
      this.projects.delete(oldestKey);
      oldest?.project.dispose();
    }
    return project;
  }

  private typescript(): Promise<TypeScriptModule> {
    this.typescriptPromise ??= this.loadTypeScript().catch((error) => {
      throw new Error(
        `TypeScript code intelligence is unavailable. Install the optional typescript dependency: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.typescriptPromise;
  }
}

class WorkspaceLanguageProject {
  readonly root: string;
  readonly service: LanguageService;
  readonly descriptor: ProjectDescriptor;
  private readonly ts: TypeScriptModule;
  private readonly libRoot: string;

  constructor(ts: TypeScriptModule, descriptor: ProjectDescriptor) {
    this.ts = ts;
    this.root = descriptor.root;
    this.descriptor = descriptor;
    this.libRoot = dirname(ts.getDefaultLibFilePath(descriptor.compilerOptions));
    const host: import("typescript").LanguageServiceHost = {
      getCompilationSettings: () => descriptor.compilerOptions,
      getScriptFileNames: () => descriptor.fileNames,
      getScriptVersion: (fileName) => fileVersion(fileName),
      getScriptSnapshot: (fileName) => {
        if (!this.allowed(fileName) || !existsSync(fileName)) return undefined;
        return ts.ScriptSnapshot.fromString(readFileSync(fileName, "utf8"));
      },
      getCurrentDirectory: () => descriptor.configPath
        ? dirname(descriptor.configPath)
        : descriptor.root,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (fileName) => this.allowed(fileName) && ts.sys.fileExists(fileName),
      readFile: (fileName, encoding) => this.allowed(fileName)
        ? ts.sys.readFile(fileName, encoding)
        : undefined,
      readDirectory: (path, extensions, exclude, include, depth) => {
        if (!this.allowed(path)) return [];
        return ts.sys
          .readDirectory(path, extensions, exclude, include, depth)
          .filter((fileName) => this.allowed(fileName));
      },
      directoryExists: (path) => this.allowed(path) && (ts.sys.directoryExists?.(path) ?? false),
      getDirectories: (path) => this.allowed(path)
        ? (ts.sys.getDirectories?.(path) ?? []).filter((directory) => this.allowed(directory))
        : [],
      realpath: (path) => this.safeRealpath(path),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine,
    };
    this.service = ts.createLanguageService(
      host,
      ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, descriptor.root),
    );
  }

  metadata(): CodeIntelligenceProject {
    return {
      kind: this.descriptor.kind,
      configPath: this.descriptor.configPath
        ? workspacePath(this.root, this.descriptor.configPath)
        : undefined,
      rootFileCount: this.descriptor.fileNames.length,
      projectReferences: this.descriptor.projectReferencePaths.map((path) =>
        workspacePath(this.root, path)
      ),
    };
  }

  position(path: string, line: number, column: number): number {
    const fileName = resolve(path);
    const source = this.sourceFile(fileName);
    if (!Number.isInteger(line) || line < 1 || line > source.getLineStarts().length) {
      throw new Error(`line must be between 1 and ${source.getLineStarts().length}.`);
    }
    const lineStart = source.getLineStarts()[line - 1] ?? 0;
    const lineEnd = line < source.getLineStarts().length
      ? (source.getLineStarts()[line] ?? source.getEnd())
      : source.getEnd();
    const maxColumn = Math.max(1, lineEnd - lineStart + 1);
    if (!Number.isInteger(column) || column < 1 || column > maxColumn) {
      throw new Error(`column must be between 1 and ${maxColumn} for line ${line}.`);
    }
    return lineStart + column - 1;
  }

  span(fileName: string, span: TextSpan): CodeIntelligencePosition {
    const source = this.sourceFile(fileName);
    const start = source.getLineAndCharacterOfPosition(span.start);
    const end = source.getLineAndCharacterOfPosition(span.start + span.length);
    return {
      path: workspacePath(this.root, fileName),
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
    };
  }

  read(fileName: string): string {
    if (!isPathInside(fileName, this.root)) {
      throw new Error(`Code intelligence path is outside the workspace: ${fileName}`);
    }
    return readFileSync(fileName, "utf8");
  }

  displayParts(parts: readonly import("typescript").SymbolDisplayPart[]): string {
    return this.ts.displayPartsToString([...parts]);
  }

  diagnosticMessage(diagnostic: Diagnostic): string {
    return formatDiagnosticMessage(this.ts, diagnostic);
  }

  diagnosticCategory(
    category: import("typescript").DiagnosticCategory,
  ): CodeDiagnostic["category"] {
    if (category === this.ts.DiagnosticCategory.Error) return "error";
    if (category === this.ts.DiagnosticCategory.Warning) return "warning";
    if (category === this.ts.DiagnosticCategory.Suggestion) return "suggestion";
    return "message";
  }

  isIdentifierText(value: string): boolean {
    const scanner = this.ts.createScanner(
      this.ts.ScriptTarget.Latest,
      false,
      this.ts.LanguageVariant.Standard,
      value,
    );
    return scanner.scan() === this.ts.SyntaxKind.Identifier
      && scanner.getTokenText() === value
      && scanner.scan() === this.ts.SyntaxKind.EndOfFileToken;
  }

  symbolDefinitions(fileName: string, position: number): CodeLocation[] {
    const program = this.service.getProgram();
    const source = program?.getSourceFile(fileName);
    if (!program || !source) return [];
    const node = smallestNodeAtPosition(source, position);
    if (!node) return [];
    const checker = program.getTypeChecker();
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol && node.parent) symbol = checker.getSymbolAtLocation(node.parent);
    if (!symbol) return [];
    if ((symbol.flags & this.ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    const declarations = symbol.getDeclarations() ?? [];
    const locations: CodeLocation[] = [];
    for (const declaration of declarations) {
      const declarationFile = declaration.getSourceFile().fileName;
      if (!isPathInside(declarationFile, this.root)) continue;
      const named = declaration as import("typescript").Declaration & {
        name?: import("typescript").DeclarationName;
      };
      const locationNode = named.name ?? declaration;
      locations.push({
        ...this.span(declarationFile, {
          start: locationNode.getStart(),
          length: locationNode.getWidth(),
        }),
        kind: this.ts.SyntaxKind[declaration.kind] ?? "declaration",
        name: symbol.getName(),
      });
    }
    return dedupeCodeLocations(locations);
  }

  dispose(): void {
    this.service.dispose();
  }

  private sourceFile(fileName: string): import("typescript").SourceFile {
    this.service.getSyntacticDiagnostics(fileName);
    const source = this.service.getProgram()?.getSourceFile(fileName);
    if (source) return source;
    const text = this.read(fileName);
    return this.ts.createSourceFile(
      fileName,
      text,
      this.ts.ScriptTarget.Latest,
      true,
      scriptKind(this.ts, fileName),
    );
  }

  private allowed(path: string): boolean {
    const absolute = resolve(path);
    return isPathInside(absolute, this.root) || isPathInside(absolute, this.libRoot);
  }

  private safeRealpath(path: string): string {
    if (!this.allowed(path)) return path;
    try {
      const real = realpathSync.native(path);
      return this.allowed(real) ? real : path;
    } catch {
      return path;
    }
  }
}

function createProjectDescriptor(
  ts: TypeScriptModule,
  root: string,
  targetPath: string | undefined,
  maxProjectFiles: number,
): ProjectDescriptor {
  if (targetPath && !isPathInside(targetPath, root)) {
    throw new Error(`Code intelligence target is outside the workspace: ${targetPath}`);
  }
  const configPath = findProjectConfig(root, targetPath);
  if (!configPath) {
    if (!targetPath) {
      throw new Error("No tsconfig.json or jsconfig.json was found for project diagnostics.");
    }
    const compilerOptions: CompilerOptions = {
      allowJs: true,
      checkJs: true,
      allowNonTsExtensions: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.Preserve,
    };
    return {
      key: `inferred:${root}:${targetPath}`,
      signature: `inferred:${fileVersion(targetPath)}`,
      root,
      kind: "inferred",
      compilerOptions,
      fileNames: [targetPath],
      projectReferencePaths: [],
      configErrors: [],
    };
  }

  const parsed = parseConfiguredProject(ts, root, configPath);
  const referencedProjects = collectReferencedProjects(
    ts,
    root,
    parsed.projectReferences ?? [],
  );
  const fileNames = [...new Set([
    ...parsed.fileNames.map((fileName) => resolve(fileName)),
    ...referencedProjects.fileNames,
  ])];
  if (targetPath && supportedSourcePath(targetPath) && !fileNames.includes(targetPath)) {
    fileNames.push(targetPath);
  }
  if (fileNames.length > maxProjectFiles) {
    throw new Error(
      `Code intelligence project contains ${fileNames.length} root files; maximum is ${maxProjectFiles}.`,
    );
  }
  for (const fileName of fileNames) {
    if (!isPathInside(fileName, root)) {
      throw new Error(`Project source file is outside the workspace: ${fileName}`);
    }
  }
  const projectReferencePaths = (parsed.projectReferences ?? []).map((reference) =>
    resolveProjectReferenceConfigPath(reference.path)
  );
  for (const referencePath of projectReferencePaths) {
    if (!isPathInside(referencePath, root)) {
      throw new Error(`Project reference is outside the workspace: ${referencePath}`);
    }
  }
  const signature = createHash("sha256")
    .update(readFileSync(configPath))
    .update("\0")
    .update(fileNames.slice().sort().join("\0"))
    .update("\0")
    .update(
      referencedProjects.configPaths
        .slice()
        .sort()
        .map((path) => `${path}:${fileVersion(path)}`)
        .join("\0"),
    )
    .digest("base64url");
  return {
    key: `configured:${configPath}`,
    signature,
    root,
    kind: "configured",
    configPath,
    compilerOptions: parsed.options,
    fileNames,
    projectReferences: parsed.projectReferences,
    projectReferencePaths,
    configErrors: parsed.errors,
  };
}

function collectReferencedProjects(
  ts: TypeScriptModule,
  root: string,
  references: readonly ProjectReference[],
): { fileNames: string[]; configPaths: string[] } {
  const fileNames = new Set<string>();
  const configPaths = new Set<string>();
  const visit = (projectReferences: readonly ProjectReference[]): void => {
    for (const reference of projectReferences) {
      const configPath = resolveProjectReferenceConfigPath(reference.path);
      if (configPaths.has(configPath)) continue;
      if (!isPathInside(configPath, root)) {
        throw new Error(`Project reference is outside the workspace: ${configPath}`);
      }
      configPaths.add(configPath);
      if (!existsSync(configPath)) continue;
      const parsed = parseConfiguredProject(ts, root, configPath);
      for (const fileName of parsed.fileNames) fileNames.add(resolve(fileName));
      visit(parsed.projectReferences ?? []);
    }
  };
  visit(references);
  return {
    fileNames: [...fileNames],
    configPaths: [...configPaths],
  };
}

function parseConfiguredProject(
  ts: TypeScriptModule,
  root: string,
  configPath: string,
): import("typescript").ParsedCommandLine {
  const read = ts.readConfigFile(configPath, (fileName) =>
    isPathInside(fileName, root) ? ts.sys.readFile(fileName) : undefined
  );
  if (read.error) throw new Error(formatDiagnosticMessage(ts, read.error));
  const host: import("typescript").ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (fileName) => isPathInside(fileName, root) && ts.sys.fileExists(fileName),
    readFile: (fileName) => isPathInside(fileName, root) ? ts.sys.readFile(fileName) : undefined,
    readDirectory: (path, extensions, exclude, include, depth) => {
      if (!isPathInside(path, root)) return [];
      return ts.sys
        .readDirectory(path, extensions, exclude, include, depth)
        .filter((fileName) => isPathInside(fileName, root));
    },
    trace: () => undefined,
  };
  return ts.parseJsonConfigFileContent(
    read.config,
    host,
    dirname(configPath),
    undefined,
    configPath,
  );
}

function findProjectConfig(root: string, targetPath?: string): string | undefined {
  let directory = targetPath ? dirname(targetPath) : root;
  while (isPathInside(directory, root)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function appendDiagnostics(
  service: LanguageService,
  fileName: string,
  scope: DiagnosticScope,
  append: (diagnostics: readonly Diagnostic[]) => boolean,
): boolean {
  if ((scope === "all" || scope === "syntactic") && !append(service.getSyntacticDiagnostics(fileName))) {
    return false;
  }
  if ((scope === "all" || scope === "semantic") && !append(service.getSemanticDiagnostics(fileName))) {
    return false;
  }
  if ((scope === "all" || scope === "suggestion") && !append(service.getSuggestionDiagnostics(fileName))) {
    return false;
  }
  return true;
}

function smallestNodeAtPosition(
  source: import("typescript").SourceFile,
  position: number,
): import("typescript").Node | undefined {
  let match: import("typescript").Node | undefined;
  const visit = (node: import("typescript").Node): void => {
    if (position < node.getFullStart() || position >= node.getEnd()) return;
    match = node;
    node.forEachChild(visit);
  };
  visit(source);
  return match;
}

function dedupeCodeLocations(locations: CodeLocation[]): CodeLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.path}:${location.line}:${location.column}:${location.endLine}:${location.endColumn}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function expandDefinitionAliases(
  service: LanguageService,
  definitions: readonly import("typescript").DefinitionInfo[],
): readonly import("typescript").DefinitionInfo[] {
  let current = [...definitions];
  const seen = new Set<string>();
  for (let depth = 0; depth < 4; depth += 1) {
    const expanded: import("typescript").DefinitionInfo[] = [];
    let followedAlias = false;
    for (const definition of current) {
      const key = `${definition.fileName}:${definition.textSpan.start}:${definition.textSpan.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (definition.kind !== "alias") {
        expanded.push(definition);
        continue;
      }
      const candidatePositions = [
        definition.textSpan.start,
        definition.textSpan.start + Math.max(0, Math.floor(definition.textSpan.length / 2)),
      ];
      const targets = candidatePositions.flatMap((position) =>
        service.getDefinitionAndBoundSpan(definition.fileName, position)?.definitions ?? []
      );
      const unseenTargets = targets.filter((target) => {
        const targetKey = `${target.fileName}:${target.textSpan.start}:${target.textSpan.length}`;
        return targetKey !== key && !seen.has(targetKey);
      });
      if (unseenTargets.length === 0) {
        expanded.push(definition);
        continue;
      }
      followedAlias = true;
      expanded.push(...unseenTargets);
    }
    current = expanded;
    if (!followedAlias) break;
  }
  return current;
}

function convertDiagnostic(
  project: WorkspaceLanguageProject,
  diagnostic: Diagnostic,
): CodeDiagnostic | undefined {
  if (!diagnostic.file || diagnostic.start === undefined) return undefined;
  if (!supportedSourcePath(diagnostic.file.fileName)) return undefined;
  if (!isPathInside(diagnostic.file.fileName, project.root)) return undefined;
  return {
    ...project.span(diagnostic.file.fileName, {
      start: diagnostic.start,
      length: diagnostic.length ?? 0,
    }),
    category: project.diagnosticCategory(diagnostic.category),
    code: diagnostic.code,
    message: project.diagnosticMessage(diagnostic),
    source: diagnostic.source,
  };
}

function convertProjectDiagnostic(
  project: WorkspaceLanguageProject,
  diagnostic: Diagnostic,
): CodeProjectDiagnostic {
  return {
    category: project.diagnosticCategory(diagnostic.category),
    code: diagnostic.code,
    message: project.diagnosticMessage(diagnostic),
    source: diagnostic.source,
  };
}

function formatDiagnosticMessage(ts: TypeScriptModule, diagnostic: Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function unsupportedDiagnostics(reason: string): DiagnosticsResult {
  return {
    supported: false,
    reason,
    summary: {
      files: 0,
      diagnostics: 0,
      errors: 0,
      warnings: 0,
      suggestions: 0,
      messages: 0,
      truncated: false,
    },
    diagnostics: [],
    projectDiagnostics: [],
  };
}

function unsupportedRename(reason: string): RenamePreviewResult {
  return {
    supported: false,
    canRename: false,
    reason,
    edits: [],
    files: 0,
    omittedExternal: 0,
    truncated: false,
  };
}

function supportedSourcePath(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase());
}

function validateRenameText(value: string): void {
  if (!value || value.length > 200 || /[\r\n\0]/.test(value)) {
    throw new Error("newName must contain 1 to 200 characters without line breaks or NUL bytes.");
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function workspacePath(root: string, path: string): string {
  return relative(root, resolve(path)).replaceAll("\\", "/") || ".";
}

function isPathInside(path: string, root: string): boolean {
  const candidate = relative(resolve(root), resolve(path));
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function fileVersion(path: string): string {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  } catch {
    return "missing";
  }
}

function resolveProjectReferenceConfigPath(path: string): string {
  const absolute = resolve(path);
  try {
    return statSync(absolute).isDirectory() ? join(absolute, "tsconfig.json") : absolute;
  } catch {
    return absolute.endsWith(".json") ? absolute : join(absolute, "tsconfig.json");
  }
}

function scriptKind(ts: TypeScriptModule, fileName: string): import("typescript").ScriptKind {
  switch (extname(fileName).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}
