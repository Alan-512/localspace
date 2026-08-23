import { app, BrowserWindow, shell } from "electron";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eventChannels } from "../shared/channels.js";
import type { AppState, ConnectionInfo, DesktopSettings } from "../shared/types.js";
import { uiStrings } from "../shared/ui-strings.js";
import {
  localMcpUrl,
  publicMcpUrl,
  readOwnerToken,
  readUserFiles,
  maskOwnerToken,
  defaultLocalPort,
} from "./config-store.js";
import type { DoctorCliReport } from "./doctor-runner.js";
import { runDoctorJson } from "./doctor-runner.js";
import { LogBuffer } from "./logger.js";
import { registerIpcHandlers } from "./ipc.js";
import { resolveRuntimePaths, CoreRuntimeMissingError } from "./runtime-paths.js";
import { loadSettings, saveSettings } from "./settings-store.js";
import { TrayController } from "./tray.js";
import { createMainWindow, type MainWindowHandle } from "./window.js";

// In dev, __dirname is desktop/dist/main; the LocalSpace checkout root sits three levels up.
const devRepoRoot = resolve(__dirname, "..", "..", "..");

let mainWindow: MainWindowHandle | null = null;
let tray: TrayController | null = null;
let logBuffer: LogBuffer | null = null;
let currentSettings: DesktopSettings = { launchAtStartup: false, closeToTray: true };

function createPanel(): MainWindowHandle {
  const handle = createMainWindow({
    preloadPath: join(__dirname, "../preload/preload.js"),
    rendererIndex: join(__dirname, "../renderer/index.html"),
    shouldHideOnClose: () => currentSettings.closeToTray,
  });
  mainWindow = handle;
  handle.load();
  return handle;
}

function showMainWindow(): void {
  const existing = mainWindow?.window;
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  // The panel was closed without close-to-tray; rebuild it on demand.
  createPanel();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      window.show();
      window.focus();
    }
  });

  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  let runtimePaths;
  try {
    runtimePaths = resolveRuntimePaths({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repoRoot: devRepoRoot,
    });
  } catch (error) {
    await fatalStartupError(error);
    return;
  }

  const logs = new LogBuffer();
  logBuffer = logs;

  currentSettings = loadSettings(app.getPath("userData"));
  applyLaunchAtStartup(currentSettings.launchAtStartup);

  // Lazy import keeps the ServiceManager out of early startup failure paths.
  const { ServiceManager } = await import("./service-manager.js");
  const serviceManager = new ServiceManager({
    paths: runtimePaths,
    log: (stream, line) => logs.append(stream, line),
    readPort: () => readUserFiles().files?.config.port ?? defaultLocalPort,
  });
  serviceManager.onStatusChange((status) => {
    tray?.update(status);
    broadcast(eventChannels.serviceStateChanged, status);
  });

  tray = new TrayController({
    onOpenPanel: () => showMainWindow(),
    onStart: () => {
      safeStart(serviceManager).catch(() => undefined);
    },
    onStop: () => {
      safeStop(serviceManager).catch(() => undefined);
    },
    onQuit: () => {
      app.quit();
    },
  });
  tray.ensureCreated();
  tray.update(serviceManager.status);

  createPanel();

  registerIpcHandlers(
    {
      getAppState: async (): Promise<AppState> => {
        const userFiles = readUserFiles();
        return {
          configured: Boolean(userFiles.files?.configExists && userFiles.files?.authExists),
          service: serviceManager.status,
          files: userFiles.files,
          filesError: userFiles.error,
          appVersion: app.getVersion(),
          coreVersion: readCoreVersion(runtimePaths.serverRoot),
          platform: process.platform,
        };
      },
      startService: () => safeStart(serviceManager),
      stopService: () => safeStop(serviceManager),
      restartService: async () => {
        try {
          return await serviceManager.restart();
        } catch (error) {
          throw new Error(toMessage(error));
        }
      },
      getConnectionInfo: async (): Promise<ConnectionInfo> => {
        const snapshot = readUserFiles();
        const config = snapshot.files?.config ?? {};
        const auth = readOwnerToken();
        return {
          localMcpUrl: localMcpUrl(config),
          publicMcpUrl: publicMcpUrl(config),
          maskedOwnerToken: maskOwnerToken(auth.ownerToken),
        };
      },
      revealOwnerToken: async () => readOwnerToken().ownerToken,
      runWizard: async (input) => {
        const { runWizardInit } = await import("./wizard.js");
        const wizardInput = normalizeWizardInput(input);
        return runWizardInit(runtimePaths, wizardInput, () => readOwnerToken());
      },
      runDoctor: async () => {
        const result = await runDoctorJson(runtimePaths);
        if (!result.report) {
          return { ok: false, groups: [], error: result.error ?? "doctor 运行失败" };
        }
        return mapDoctorReport(result.report);
      },
      getSettings: () => currentSettings,
      setSettings: (partial) => {
        currentSettings = {
          launchAtStartup:
            typeof partial.launchAtStartup === "boolean"
              ? partial.launchAtStartup
              : currentSettings.launchAtStartup,
          closeToTray: typeof partial.closeToTray === "boolean" ? partial.closeToTray : currentSettings.closeToTray,
        };
        saveSettings(app.getPath("userData"), currentSettings);
        applyLaunchAtStartup(currentSettings.launchAtStartup);
        return currentSettings;
      },
      openConfigFolder: async () => {
        const snapshot = readUserFiles();
        const dir = snapshot.files?.dir;
        if (!dir) throw new Error("配置目录不存在。");
        const errorMessage = await shell.openPath(dir);
        if (errorMessage) throw new Error(errorMessage);
        return true;
      },
    },
    logs,
  );

  logs.subscribe((entry) => broadcast(eventChannels.logAppended, entry));

  app.on("window-all-closed", () => {
    // Keep running in the tray; quitting happens via tray menu or Cmd+Q.
    if (process.platform === "darwin") return;
  });

  app.on("before-quit", (event) => {
    if (appQuitting) return;
    event.preventDefault();
    appQuitting = true;
    void serviceManager.dispose().finally(() => {
      tray?.destroy();
      app.exit(0);
    });
  });
}

let appQuitting = false;

function applyLaunchAtStartup(enabled: boolean): void {
  app.setLoginItemSettings({
    openAsHidden: true,
    args: ["--hidden"],
    enabled,
  });
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

async function safeStart(serviceManager: import("./service-manager.js").ServiceManager) {
  try {
    return await serviceManager.start();
  } catch (error) {
    logBuffer?.append("app", `启动失败：${toMessage(error)}`);
    throw new Error(toMessage(error));
  }
}

async function safeStop(serviceManager: import("./service-manager.js").ServiceManager) {
  try {
    return await serviceManager.stop();
  } catch (error) {
    logBuffer?.append("app", `停止失败：${toMessage(error)}`);
    throw new Error(toMessage(error));
  }
}

async function fatalStartupError(error: unknown): Promise<void> {
  const message =
    error instanceof CoreRuntimeMissingError
      ? error.message
      : `启动失败：${error instanceof Error ? error.message : String(error)}`;
  const { dialog } = await import("electron");
  await dialog.showErrorBox(uiStrings.appName, message);
  app.exit(1);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCoreVersion(serverRoot: string): string | null {
  try {
    const packageJson = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}

function normalizeWizardInput(input: unknown): import("./wizard.js").WizardInitInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("向导输入格式不正确。");
  }
  const raw = input as Record<string, unknown>;
  const roots = Array.isArray(raw.roots) ? raw.roots.map(String) : [];
  const port = Number(raw.port);
  const publicBaseUrl = String(raw.publicBaseUrl ?? "");
  return { roots, port, publicBaseUrl, force: raw.force === true };
}

interface DoctorViewGroup {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

function mapDoctorReport(report: DoctorCliReport): {
  ok: boolean;
  groups: ReadonlyArray<DoctorViewGroup>;
} {
  const groups: DoctorViewGroup[] = [];
  let overall = true;

  const push = (id: string, label: string, ok: boolean, detail: string) => {
    if (!ok) overall = false;
    groups.push({ id, label, ok, detail });
  };

  const runtime = report.runtime ?? {};
  push(
    "node",
    "Node 运行时",
    runtime.nodeSupported === true,
    `${runtime.node ?? "?"}（要求 ${runtime.supportedRange ?? "?"}）`,
  );
  push(
    "sqlite",
    "SQLite 原生依赖",
    report.sqliteNative?.ok !== false,
    report.sqliteNative?.ok ? "正常加载" : report.sqliteNative?.error ?? "未知错误",
  );
  push("git", "Git", report.git?.available === true, report.git?.detail ?? "不可用");
  push("shell", "Shell", report.bashShell?.available === true, report.bashShell?.detail ?? "不可用");
  push(
    "config",
    "配置文件",
    (report.config?.exists ?? false) && (report.auth?.exists ?? false),
    `${report.config?.path ?? "?"}${report.configError ? `（${report.configError}）` : ""}`,
  );

  return { ok: overall, groups };
}
