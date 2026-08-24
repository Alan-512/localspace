import type {
  AppState,
  ConnectionInfo,
  DesktopSettings,
  DoctorReportView,
  FolderPickResult,
  LogEntry,
  ServiceStatus,
  WizardInput,
  WizardResult,
} from "./types.js";

/** Uniform envelope for every IPC round trip so the renderer can render errors consistently. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * The only surface the renderer can touch. Implemented by preload.ts over the
 * whitelisted channels in channels.ts.
 */
export interface DesktopApi {
  getState(): Promise<IpcResult<AppState>>;
  wizardComplete(
    input: WizardInput & { force?: boolean; localOnly?: boolean },
  ): Promise<IpcResult<WizardResult>>;
  startService(): Promise<IpcResult<ServiceStatus>>;
  stopService(): Promise<IpcResult<ServiceStatus>>;
  restartService(): Promise<IpcResult<ServiceStatus>>;
  getConnectionInfo(): Promise<IpcResult<ConnectionInfo>>;
  revealOwnerToken(): Promise<IpcResult<string | null>>;
  copyToClipboard(text: string): Promise<IpcResult<boolean>>;
  runDoctor(): Promise<IpcResult<DoctorReportView>>;
  getRecentLogs(count?: number): Promise<IpcResult<ReadonlyArray<LogEntry>>>;
  clearLogs(): Promise<IpcResult<boolean>>;
  getSettings(): Promise<IpcResult<DesktopSettings>>;
  setSettings(partial: Partial<DesktopSettings>): Promise<IpcResult<DesktopSettings>>;
  selectFolders(): Promise<IpcResult<FolderPickResult>>;
  openConfigFolder(): Promise<IpcResult<boolean>>;
  openExternal(url: string): Promise<IpcResult<boolean>>;
  onServiceStateChanged(listener: (status: ServiceStatus) => void): () => void;
  onLogAppended(listener: (entry: LogEntry) => void): () => void;
}
