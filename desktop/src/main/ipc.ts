import { clipboard, dialog, ipcMain, shell } from "electron";
import { ipcChannels } from "../shared/channels.js";
import type { IpcResult } from "../shared/api.js";
import type {
  AppState,
  ConnectionInfo,
  DesktopSettings,
  DoctorReportView,
  FolderPickResult,
  LogEntry,
  ServiceStatus,
  WizardResult,
} from "../shared/types.js";
import type { LogBuffer } from "./logger.js";

export interface AppHandlers {
  readonly getAppState: () => Promise<AppState>;
  readonly startService: () => Promise<ServiceStatus>;
  readonly stopService: () => Promise<ServiceStatus>;
  readonly restartService: () => Promise<ServiceStatus>;
  readonly getConnectionInfo: () => Promise<ConnectionInfo>;
  readonly revealOwnerToken: () => Promise<string | null>;
  readonly runWizard: (input: unknown) => Promise<WizardResult>;
  readonly runDoctor: () => Promise<DoctorReportView>;
  readonly getSettings: () => DesktopSettings;
  readonly setSettings: (input: Partial<DesktopSettings>) => DesktopSettings;
  readonly openConfigFolder: () => Promise<boolean>;
}

const maxClipboardLength = 10_000;
const maxLogRequestSize = 5000;

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function register<T>(channel: string, handler: (payload: unknown) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, payload: unknown): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await handler(payload) };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });
}

export function registerIpcHandlers(handlers: AppHandlers, logs: LogBuffer): void {
  register(ipcChannels.getState, () => handlers.getAppState());
  register(ipcChannels.startService, () => handlers.startService());
  register(ipcChannels.stopService, () => handlers.stopService());
  register(ipcChannels.restartService, () => handlers.restartService());
  register(ipcChannels.getConnectionInfo, () => handlers.getConnectionInfo());
  register(ipcChannels.revealOwnerToken, () => handlers.revealOwnerToken());
  register(ipcChannels.wizardComplete, (input) => handlers.runWizard(input));
  register(ipcChannels.runDoctor, () => handlers.runDoctor());

  register(ipcChannels.copyToClipboard, (payload) => {
    const text = typeof payload === "string" ? payload : "";
    if (!text || text.length > maxClipboardLength) {
      throw new Error("剪贴板内容为空或超出长度限制。");
    }
    clipboard.writeText(text);
    return true;
  });

  register(ipcChannels.getRecentLogs, (payload) => {
    const requested = typeof payload === "number" ? payload : undefined;
    const count = requested === undefined ? undefined : Math.min(Math.max(Math.floor(requested), 1), maxLogRequestSize);
    const entries: ReadonlyArray<LogEntry> = logs.recent(count);
    return entries;
  });

  register(ipcChannels.clearLogs, () => {
    logs.clear();
    return true;
  });

  register(ipcChannels.getSettings, () => handlers.getSettings());

  register(ipcChannels.setSettings, (payload) => {
    if (typeof payload !== "object" || payload === null) {
      throw new Error("设置内容格式不正确。");
    }
    return handlers.setSettings(payload as Partial<DesktopSettings>);
  });

  register(ipcChannels.selectFolders, async (): Promise<FolderPickResult> => {
    const result = await dialog.showOpenDialog({
      title: "选择允许 LocalSpace 访问的项目目录",
      properties: ["openDirectory", "multiSelections", "dontAddToRecent"],
    });
    return { canceled: result.canceled, paths: result.filePaths };
  });

  register(ipcChannels.openConfigFolder, () => handlers.openConfigFolder());

  register(ipcChannels.openExternal, async (payload) => {
    const url = typeof payload === "string" ? payload : "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("无效的链接。");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("只允许打开 http(s) 链接。");
    }
    await shell.openExternal(parsed.toString());
    return true;
  });
}
