import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

interface PackageJson {
  name?: string;
  type?: string;
  main?: string;
  module?: string;
  browser?: string | Record<string, string>;
  types?: string;
  typings?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  scripts?: Record<string, string>;
}

interface Candidate {
  path: string;
  reason: string;
}

const COMMON_CONFIG_FILES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "vite.config.ts",
  "vite.config.js",
  "webpack.config.js",
  "rollup.config.js",
  "eslint.config.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  "prettier.config.js",
  ".prettierrc",
  "vitest.config.ts",
  "jest.config.js",
  "playwright.config.ts",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
];

const COMMON_SOURCE_ENTRYPOINTS = [
  "src/cli.ts",
  "src/cli.js",
  "src/server.ts",
  "src/server.js",
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/main.ts",
  "src/main.tsx",
  "src/main.js",
  "src/app.ts",
  "src/app.tsx",
  "src/App.tsx",
];

export async function findEntrypoints(workspaceRoot: string): Promise<string> {
  const packageJson = await readPackageJson(workspaceRoot);
  const [configFiles, candidates] = await Promise.all([
    existingPaths(workspaceRoot, COMMON_CONFIG_FILES),
    collectSourceCandidates(workspaceRoot, packageJson),
  ]);

  const lines = ["Entrypoints", ""];
  formatPackageSection(lines, packageJson);
  formatScriptSection(lines, packageJson);
  formatSourceSection(lines, candidates);
  formatConfigSection(lines, configFiles);
  return lines.join("\n");
}

async function readPackageJson(workspaceRoot: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

function formatPackageSection(lines: string[], packageJson: PackageJson | undefined): void {
  lines.push("Package:");
  if (!packageJson) {
    lines.push("- package.json: not found", "");
    return;
  }

  if (packageJson.name) lines.push(`- name: ${packageJson.name}`);
  if (packageJson.type) lines.push(`- type: ${packageJson.type}`);
  if (packageJson.main) lines.push(`- main: ${packageJson.main}`);
  if (packageJson.module) lines.push(`- module: ${packageJson.module}`);
  if (typeof packageJson.browser === "string") lines.push(`- browser: ${packageJson.browser}`);
  if (packageJson.types ?? packageJson.typings) lines.push(`- types: ${packageJson.types ?? packageJson.typings}`);

  const bins = normalizeBin(packageJson.bin);
  if (bins.length > 0) {
    lines.push("- bin:");
    for (const bin of bins) lines.push(`  - ${bin.name}: ${bin.path}`);
  }

  const exports = formatExports(packageJson.exports);
  if (exports.length > 0) {
    lines.push("- exports:");
    for (const entry of exports.slice(0, 20)) lines.push(`  - ${entry}`);
    if (exports.length > 20) lines.push(`  - ... (${exports.length - 20} more)`);
  }
  lines.push("");
}

function formatScriptSection(lines: string[], packageJson: PackageJson | undefined): void {
  lines.push("Scripts:");
  const scripts = packageJson?.scripts ?? {};
  const names = Object.keys(scripts).sort();
  if (names.length === 0) {
    lines.push("- none", "");
    return;
  }

  const preferred = ["dev", "start", "build", "typecheck", "test", "lint", "clean"];
  const ordered = [...preferred.filter((name) => scripts[name]), ...names.filter((name) => !preferred.includes(name))];
  for (const name of ordered) lines.push(`- ${name}: ${scripts[name]}`);
  lines.push("");

  const verification = ["typecheck", "test", "build", "lint"].filter((name) => scripts[name]);
  if (verification.length > 0) {
    lines.push("Suggested verification:");
    for (const name of verification) lines.push(`- npm run ${name}`);
    lines.push("");
  }
}

function formatSourceSection(lines: string[], candidates: Candidate[]): void {
  lines.push("Likely source entrypoints:");
  if (candidates.length === 0) {
    lines.push("- none detected", "");
    return;
  }

  for (const candidate of candidates) lines.push(`- ${candidate.path} (${candidate.reason})`);
  lines.push("");
}

function formatConfigSection(lines: string[], configFiles: string[]): void {
  lines.push("Config and orientation files:");
  if (configFiles.length === 0) {
    lines.push("- none detected");
    return;
  }

  for (const path of configFiles) lines.push(`- ${path}`);
}

async function collectSourceCandidates(workspaceRoot: string, packageJson: PackageJson | undefined): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const packageFields = packageJson ? packageEntrypointFields(packageJson) : [];

  for (const field of packageFields) {
    for (const candidatePath of sourceCandidatesForPackagePath(field.path)) {
      candidates.push({ path: candidatePath, reason: field.reason });
    }
  }

  for (const path of COMMON_SOURCE_ENTRYPOINTS) {
    candidates.push({ path, reason: "common source entrypoint" });
  }

  const deduped = dedupeCandidates(candidates);
  const existing: Candidate[] = [];
  for (const candidate of deduped) {
    if (await exists(join(workspaceRoot, candidate.path))) existing.push(candidate);
  }
  return existing;
}

function packageEntrypointFields(packageJson: PackageJson): Candidate[] {
  const fields: Candidate[] = [];
  if (packageJson.main) fields.push({ path: packageJson.main, reason: "package main" });
  if (packageJson.module) fields.push({ path: packageJson.module, reason: "package module" });
  if (typeof packageJson.browser === "string") fields.push({ path: packageJson.browser, reason: "package browser" });
  if (packageJson.types) fields.push({ path: packageJson.types, reason: "package types" });
  if (packageJson.typings) fields.push({ path: packageJson.typings, reason: "package typings" });
  for (const bin of normalizeBin(packageJson.bin)) fields.push({ path: bin.path, reason: `package bin ${bin.name}` });
  for (const entry of exportPaths(packageJson.exports)) fields.push({ path: entry, reason: "package exports" });
  return fields;
}

function sourceCandidatesForPackagePath(packagePath: string): string[] {
  const normalized = packagePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const candidates = isGeneratedOutputPath(normalized) ? [] : [normalized];

  const srcCandidate = normalized
    .replace(/^dist\//, "src/")
    .replace(/^build\//, "src/")
    .replace(/^lib\//, "src/")
    .replace(/\.d\.ts$/, ".ts")
    .replace(/\.mjs$/, ".ts")
    .replace(/\.cjs$/, ".ts")
    .replace(/\.js$/, ".ts");
  candidates.push(srcCandidate);

  if (srcCandidate.endsWith(".ts")) {
    candidates.push(srcCandidate.replace(/\.ts$/, ".tsx"));
    candidates.push(srcCandidate.replace(/\.ts$/, ".js"));
  }

  return Array.from(new Set(candidates));
}

function isGeneratedOutputPath(path: string): boolean {
  return /^(dist|build|lib)\//.test(path);
}

function normalizeBin(bin: PackageJson["bin"]): Array<{ name: string; path: string }> {
  if (!bin) return [];
  if (typeof bin === "string") return [{ name: "default", path: bin }];
  return Object.entries(bin).map(([name, path]) => ({ name, path }));
}

function formatExports(exportsField: unknown): string[] {
  if (!exportsField) return [];
  if (typeof exportsField === "string") return [exportsField];
  if (Array.isArray(exportsField)) return exportsField.flatMap(formatExports);
  if (typeof exportsField !== "object") return [];

  const entries: string[] = [];
  for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
    if (typeof value === "string") {
      entries.push(`${key}: ${value}`);
    } else if (value && typeof value === "object") {
      for (const nested of formatExports(value)) entries.push(`${key}: ${nested}`);
    }
  }
  return entries;
}

function exportPaths(exportsField: unknown): string[] {
  if (!exportsField) return [];
  if (typeof exportsField === "string") return [exportsField];
  if (Array.isArray(exportsField)) return exportsField.flatMap(exportPaths);
  if (typeof exportsField !== "object") return [];

  const paths: string[] = [];
  for (const value of Object.values(exportsField as Record<string, unknown>)) {
    paths.push(...exportPaths(value));
  }
  return paths.filter((path) => path.startsWith(".") || path.includes("/"));
}

async function existingPaths(workspaceRoot: string, paths: string[]): Promise<string[]> {
  const output: string[] = [];
  for (const path of paths) {
    if (await exists(join(workspaceRoot, path))) output.push(path);
  }
  return output;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const previous = seen.get(candidate.path);
    if (!previous) {
      seen.set(candidate.path, candidate);
      continue;
    }
    if (!previous.reason.includes(candidate.reason)) {
      previous.reason = `${previous.reason}; ${candidate.reason}`;
    }
  }
  return Array.from(seen.values());
}
