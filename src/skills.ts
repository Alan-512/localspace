import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export interface SkillSourceInfo {
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
}

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourceInfo: SkillSourceInfo;
  disableModelInvocation: boolean;
}

export interface SkillDiagnostic {
  type: "collision" | "invalid" | "load-error";
  message: string;
  path?: string;
  name?: string;
}

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

export function builtInSkillPaths(): string[] {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const skillsDirectory = resolve(moduleDirectory, "..", "skills");

  return existsSync(skillsDirectory) ? [skillsDirectory] : [];
}

export function effectiveSkillPaths(config: ServerConfig, cwd: string): string[] {
  const defaultPaths = [
    ...builtInSkillPaths(),
    join(homedir(), ".agents", "skills"),
    resolve(cwd, ".agents", "skills"),
    join(config.agentDir, "skills"),
  ].filter((path) => existsSync(path));

  const seen = new Set<string>();
  return [...defaultPaths, ...config.skillPaths]
    .map((path) => resolveSkillPath(path, cwd))
    .filter((path) => {
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function resolveSkillPath(path: string, cwd: string): string {
  return resolve(cwd, expandHomePath(path));
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };
  return loadSkillsFromPaths(effectiveSkillPaths(config, cwd), cwd);
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const absolutePath = resolve(expandHomePath(inputPath));

  for (const skill of skills) {
    const skillFilePath = resolve(skill.filePath);
    if (absolutePath === skillFilePath) {
      return { absolutePath, skill, isSkillFile: true };
    }
  }

  for (const skill of skills) {
    const baseDir = resolve(skill.baseDir);
    if (!activatedSkillDirs.has(baseDir)) continue;
    if (!isPathInsideRoot(absolutePath, baseDir)) continue;

    return { absolutePath, skill, isSkillFile: false };
  }

  return undefined;
}

export function markSkillActivated(
  activatedSkillDirs: Set<string>,
  skill: Skill,
): void {
  activatedSkillDirs.add(resolve(skill.baseDir));
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}

function loadSkillsFromPaths(paths: string[], cwd: string): LoadedSkills {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const names = new Map<string, Skill>();

  for (const configuredPath of paths) {
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(configuredPath);
    } catch (error) {
      diagnostics.push({
        type: "load-error",
        path: configuredPath,
        message: `Could not load Skill path ${configuredPath}: ${errorMessage(error)}`,
      });
      continue;
    }

    const candidates = discoverSkillFiles(resolvedPath, diagnostics);
    for (const candidate of candidates) {
      const skill = loadSkillFile(candidate, resolvedPath, configuredPath, cwd, diagnostics);
      if (!skill) continue;
      const key = skill.name.toLowerCase();
      const existing = names.get(key);
      if (existing) {
        diagnostics.push({
          type: "collision",
          name: skill.name,
          path: skill.filePath,
          message: `Skill name collision: ${skill.name}. Keeping ${existing.filePath}; ignoring ${skill.filePath}.`,
        });
        continue;
      }
      names.set(key, skill);
      skills.push(skill);
    }
  }

  return { skills, diagnostics };
}

function discoverSkillFiles(path: string, diagnostics: SkillDiagnostic[]): string[] {
  try {
    const info = statSync(path);
    if (info.isFile()) return extname(path).toLowerCase() === ".md" ? [path] : [];
    if (!info.isDirectory()) return [];
  } catch (error) {
    diagnostics.push({
      type: "load-error",
      path,
      message: `Could not inspect Skill path ${path}: ${errorMessage(error)}`,
    });
    return [];
  }

  const files: string[] = [];
  scanSkillDirectory(path, true, files, diagnostics);
  return files;
}

function scanSkillDirectory(
  directory: string,
  includeDirectMarkdown: boolean,
  files: string[],
  diagnostics: SkillDiagnostic[],
): void {
  const skillFile = join(directory, "SKILL.md");
  if (existsSync(skillFile)) {
    files.push(skillFile);
    return;
  }

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    diagnostics.push({
      type: "load-error",
      path: directory,
      message: `Could not scan Skill directory ${directory}: ${errorMessage(error)}`,
    });
    return;
  }

  if (includeDirectMarkdown) {
    for (const entry of entries) {
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        files.push(join(directory, entry.name));
      }
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
    scanSkillDirectory(join(directory, entry.name), false, files, diagnostics);
  }
}

function loadSkillFile(
  filePath: string,
  sourceRoot: string,
  sourcePath: string,
  cwd: string,
  diagnostics: SkillDiagnostic[],
): Skill | undefined {
  let content: string;
  let resolvedFile: string;
  try {
    resolvedFile = realpathSync(filePath);
    const sourceInfo = statSync(sourceRoot);
    const allowed = sourceInfo.isDirectory()
      ? isPathInsideRoot(resolvedFile, sourceRoot)
      : samePath(resolvedFile, sourceRoot);
    if (!allowed) {
      diagnostics.push({
        type: "invalid",
        path: filePath,
        message: `Skill path resolves outside its configured source: ${filePath}`,
      });
      return undefined;
    }
    content = readFileSync(resolvedFile, "utf8");
  } catch (error) {
    diagnostics.push({
      type: "load-error",
      path: filePath,
      message: `Could not read Skill file ${filePath}: ${errorMessage(error)}`,
    });
    return undefined;
  }

  const frontmatter = parseFrontmatter(content);
  const baseDir = dirname(resolvedFile);
  const fallbackName = basename(resolvedFile).toLowerCase() === "skill.md"
    ? basename(baseDir)
    : basename(resolvedFile, extname(resolvedFile));
  const name = stringValue(frontmatter.name) || fallbackName;
  const description = stringValue(frontmatter.description);
  if (!name || !description) {
    diagnostics.push({
      type: "invalid",
      name: name || undefined,
      path: resolvedFile,
      message: `Skill ${resolvedFile} requires non-empty name and description frontmatter.`,
    });
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    diagnostics.push({
      type: "invalid",
      name,
      path: resolvedFile,
      message: `Skill name contains unsupported characters: ${name}`,
    });
    return undefined;
  }

  return {
    name,
    description,
    filePath: resolvedFile,
    baseDir,
    sourceInfo: {
      path: resolvedFile,
      source: sourcePath,
      scope: isPathInsideRoot(resolvedFile, cwd) ? "project" : "user",
      origin: "top-level",
      baseDir,
    },
    disableModelInvocation: booleanValue(frontmatter["disable-model-invocation"]),
  };
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return {};
  const result: Record<string, unknown> = {};

  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    const raw = match[2] ?? "";
    if (raw === "|" || raw === ">") {
      const values: string[] = [];
      while (index + 1 < end && /^\s+/.test(lines[index + 1] ?? "")) {
        index += 1;
        values.push((lines[index] ?? "").replace(/^\s+/, ""));
      }
      result[key] = raw === ">" ? values.join(" ").trim() : values.join("\n");
      continue;
    }
    result[key] = parseScalar(raw);
  }
  return result;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  return trimmed;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
