import { homedir, platform } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";

export type SensitivePathLevel = "none" | "sensitive" | "protected";

export interface SensitivePathFinding {
  level: Exclude<SensitivePathLevel, "none">;
  category: string;
  message: string;
}

export interface SensitivePathAnalysis {
  level: SensitivePathLevel;
  findings: SensitivePathFinding[];
}

export class SensitivePathError extends Error {
  constructor(
    readonly path: string,
    readonly analysis: SensitivePathAnalysis,
  ) {
    super(formatSensitivePathBlock(path, analysis));
    this.name = "SensitivePathError";
  }
}

export interface SensitivePathContext {
  workspaceRoot: string;
  config: Pick<ServerConfig, "stateDir" | "agentDir" | "worktreeRoot">;
}

const LEVEL_SCORE: Record<SensitivePathLevel, number> = {
  none: 0,
  sensitive: 1,
  protected: 2,
};

export function analyzeSensitivePath(path: string, context: SensitivePathContext): SensitivePathAnalysis {
  const absolutePath = resolve(path);
  const workspaceRoot = resolve(context.workspaceRoot);
  const findings: SensitivePathFinding[] = [];
  const relativeToWorkspace = normalizeRelativePath(relative(workspaceRoot, absolutePath));
  const fileName = basename(absolutePath).toLowerCase();

  if (isWorkspaceGitSensitivePath(relativeToWorkspace)) {
    findings.push({
      level: "protected",
      category: "git",
      message: "Protects Git configuration and hooks from tool-driven modification.",
    });
  }

  if (isEnvFile(fileName)) {
    findings.push({
      level: "protected",
      category: "environment",
      message: "Environment files often contain secrets or deployment credentials.",
    });
  }

  if (isSecretLikeFileName(fileName)) {
    findings.push({
      level: "protected",
      category: "secret",
      message: "Filename looks like it may contain secrets, tokens, credentials, or private keys.",
    });
  }

  for (const protectedRoot of configProtectedRoots(context.config)) {
    if (isSameOrInside(absolutePath, protectedRoot)) {
      findings.push({
        level: "protected",
        category: "localspace-config",
        message: "Protects LocalSpace state, agent configuration, or managed worktree storage.",
      });
    }
  }

  if (isSystemProtectedPath(absolutePath)) {
    findings.push({
      level: "protected",
      category: "system",
      message: "Protects operating system directories and filesystem roots.",
    });
  }

  if (isHomeRoot(absolutePath)) {
    findings.push({
      level: "protected",
      category: "home",
      message: "Protects the user home directory root from direct modification.",
    });
  }

  return {
    level: findings.reduce<SensitivePathLevel>(
      (current, finding) => LEVEL_SCORE[finding.level] > LEVEL_SCORE[current] ? finding.level : current,
      "none",
    ),
    findings: dedupeFindings(findings),
  };
}

export function assertWritablePath(path: string, context: SensitivePathContext): void {
  const analysis = analyzeSensitivePath(path, context);
  if (analysis.level !== "none") throw new SensitivePathError(path, analysis);
}

export function assertWritablePaths(paths: string[], context: SensitivePathContext): void {
  for (const path of paths) assertWritablePath(path, context);
}

export function formatSensitivePathBlock(path: string, analysis: SensitivePathAnalysis): string {
  const lines = [`Sensitive path blocked: ${path}`, `Sensitivity: ${analysis.level.toUpperCase()}`];
  for (const finding of analysis.findings) {
    lines.push(`- ${finding.level.toUpperCase()} ${finding.category}: ${finding.message}`);
  }
  return lines.join("\n");
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function isWorkspaceGitSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  return normalized === ".git/config" || normalized.startsWith(".git/hooks/");
}

function isEnvFile(fileName: string): boolean {
  return fileName === ".env" || fileName.startsWith(".env.");
}

function isSecretLikeFileName(fileName: string): boolean {
  if (["auth.json", ".npmrc", ".pypirc", "id_rsa", "id_ed25519"].includes(fileName)) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(fileName)) return true;
  if (fileName.includes("secret") || fileName.includes("token") || fileName.includes("credential")) return true;
  return fileName.includes("private") && fileName.includes("key");
}

function configProtectedRoots(config: Pick<ServerConfig, "stateDir" | "agentDir" | "worktreeRoot">): string[] {
  return [config.stateDir, config.agentDir, config.worktreeRoot].filter(Boolean).map((entry) => resolve(entry));
}

function isSameOrInside(path: string, root: string): boolean {
  const target = resolve(path);
  const base = resolve(root);
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isHomeRoot(path: string): boolean {
  return resolve(path) === resolve(homedir());
}

function isSystemProtectedPath(path: string): boolean {
  const target = resolve(path);
  const parsedPlatform = platform();
  if (parsedPlatform === "win32") {
    const lower = target.toLowerCase();
    const systemRoots = [
      process.env.SystemRoot,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
    ].filter(Boolean).map((entry) => resolve(entry as string).toLowerCase());
    return /^[a-z]:\\?$/i.test(target) || systemRoots.some((root) => lower === root || lower.startsWith(`${root.toLowerCase()}\\`));
  }

  const systemRoots = ["/", "/bin", "/sbin", "/etc", "/usr/bin", "/usr/sbin", "/System", "/Library"];
  return systemRoots.some((root) => target === root || (root !== "/" && target.startsWith(`${root}/`)));
}

function dedupeFindings(findings: SensitivePathFinding[]): SensitivePathFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.level}:${finding.category}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
