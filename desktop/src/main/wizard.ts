import { execFile } from "node:child_process";
import type { RuntimePaths } from "./runtime-paths.js";
import type { OwnerTokenResult } from "./config-store.js";

export interface WizardInitInput {
  readonly roots: ReadonlyArray<string>;
  readonly port: number;
  readonly publicBaseUrl: string;
  /** Overwrite an existing configuration (the wizard reconfigure flow). */
  readonly force: boolean;
}

export interface WizardRunResult {
  readonly ok: boolean;
  readonly ownerToken?: string;
  readonly error?: string;
}

/**
 * Pure argument assembly for `localspace init --non-interactive`. Each root is
 * passed as its own --roots flag, so paths containing commas stay intact.
 */
export function buildWizardInitArgs(input: WizardInitInput): ReadonlyArray<string> {
  const rootArgs = input.roots.flatMap((root) => ["--roots", root]);
  return [
    "init",
    "--non-interactive",
    ...(input.force ? ["--force"] : []),
    ...rootArgs,
    "--port",
    String(input.port),
    "--public-base-url",
    input.publicBaseUrl,
  ];
}

export function validateWizardInput(
  input: WizardInitInput,
): { valid: true } | { valid: false; error: string } {
  if (!Array.isArray(input.roots) || input.roots.length === 0) {
    return { valid: false, error: "请至少选择一个项目根目录。" };
  }
  if (input.roots.some((root) => typeof root !== "string" || !root.trim())) {
    return { valid: false, error: "项目根目录路径不能为空。" };
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return { valid: false, error: "端口必须是 1–65535 之间的整数。" };
  }
  if (typeof input.publicBaseUrl !== "string" || !input.publicBaseUrl.trim()) {
    return { valid: false, error: "请填写公网 MCP 地址或选择隧道方案。" };
  }
  try {
    const parsed = new URL(input.publicBaseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { valid: false, error: "公网地址必须是 http(s) URL。" };
    }
    if (input.publicBaseUrl.replace(/\/+$/, "").endsWith("/mcp")) {
      return { valid: false, error: "公网地址只填到根路径即可，不要带 /mcp。" };
    }
  } catch {
    return { valid: false, error: "公网地址格式不正确。" };
  }
  return { valid: true };
}

export async function runWizardInit(
  paths: RuntimePaths,
  input: WizardInitInput,
  readOwnerToken: () => OwnerTokenResult,
): Promise<WizardRunResult> {
  const validation = validateWizardInput(input);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  const exitError = await new Promise<string | null>((resolvePromise) => {
    execFile(
      paths.nodeExecutable,
      [paths.cliScript, ...buildWizardInitArgs(input)],
      { cwd: paths.serverRoot, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        resolvePromise(error ? String(stderr).trim() || error.message : null);
      },
    );
  });

  if (exitError) {
    return { ok: false, error: exitError };
  }

  const auth = readOwnerToken();
  if (auth.error) {
    return { ok: false, error: `配置已写入，但读取密码失败：${auth.error}` };
  }
  return { ok: true, ownerToken: auth.ownerToken ?? undefined };
}
