import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  analyzeCommandSafety,
  type CommandSafetyAnalysis,
} from "./command-safety.js";

export const MAX_PACKAGE_CHECKS = 8;
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/;

export interface PreparedPackageCheck {
  name: string;
  script: string;
  scriptNames: string[];
  scripts: Array<{
    name: string;
    script: string;
  }>;
  validationAction?: string;
  command: string;
  approvalCommand: string;
  safety: CommandSafetyAnalysis;
}

export interface PreparedPackageChecks {
  packageName?: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  checks: PreparedPackageCheck[];
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, unknown>;
}

export async function preparePackageChecks(
  root: string,
  checkNames: readonly string[],
): Promise<PreparedPackageChecks> {
  if (checkNames.length < 1 || checkNames.length > MAX_PACKAGE_CHECKS) {
    throw new Error(`run_checks requires between 1 and ${MAX_PACKAGE_CHECKS} checks.`);
  }
  const unique = new Set(checkNames);
  if (unique.size !== checkNames.length) {
    throw new Error("run_checks does not allow duplicate check names.");
  }
  for (const name of checkNames) {
    if (!SAFE_SCRIPT_NAME.test(name)) {
      throw new Error(`Unsafe package script name: ${name}`);
    }
  }

  const packageJsonPath = join(root, "package.json");
  let packageJson: PackageJson;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson;
  } catch (error) {
    throw new Error(
      `Unable to read package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const scripts = packageJson.scripts ?? {};
  const missing = checkNames.filter((name) => typeof scripts[name] !== "string");
  if (missing.length > 0) {
    throw new Error(`Package scripts not found: ${missing.join(", ")}`);
  }

  const packageManager = await detectPackageManager(root, packageJson.packageManager);
  const checks = checkNames.map((name) => {
    const script = String(scripts[name]);
    const lifecycleScripts = [`pre${name}`, name, `post${name}`]
      .filter((scriptName) => typeof scripts[scriptName] === "string")
      .map((scriptName) => ({
        name: scriptName,
        script: String(scripts[scriptName]),
      }));
    const analyzedScript = lifecycleScripts
      .map((entry) => `[${entry.name}] ${entry.script}`)
      .join("\n");
    const command = `${packageManager} run ${name}`;
    return {
      name,
      script,
      scriptNames: lifecycleScripts.map((entry) => entry.name),
      scripts: lifecycleScripts,
      command,
      approvalCommand: `run_checks:${name}\n${analyzedScript}`,
      safety: analyzeCommandSafety(analyzedScript),
    };
  });
  return { packageName: packageJson.name, packageManager, checks };
}

async function detectPackageManager(
  root: string,
  declared: string | undefined,
): Promise<PreparedPackageChecks["packageManager"]> {
  const declaredName = declared?.split("@")[0];
  if (declaredName === "pnpm" || declaredName === "yarn" || declaredName === "bun" || declaredName === "npm") {
    return declaredName;
  }
  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
  ] as const) {
    try {
      await access(join(root, file));
      return manager;
    } catch {
      // Continue to the next package-manager marker.
    }
  }
  return "npm";
}
