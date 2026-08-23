import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { eventChannels, ipcChannels } from "../shared/channels.js";
import type { DesktopApi } from "../shared/api.js";
import type { LogEntry, ServiceStatus } from "../shared/types.js";

function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, payload) as Promise<T>;
}

const api: DesktopApi = {
  getState: () => invoke(ipcChannels.getState),
  wizardComplete: (input) => invoke(ipcChannels.wizardComplete, input),
  startService: () => invoke(ipcChannels.startService),
  stopService: () => invoke(ipcChannels.stopService),
  restartService: () => invoke(ipcChannels.restartService),
  getConnectionInfo: () => invoke(ipcChannels.getConnectionInfo),
  revealOwnerToken: () => invoke(ipcChannels.revealOwnerToken),
  copyToClipboard: (text) => invoke(ipcChannels.copyToClipboard, text),
  runDoctor: () => invoke(ipcChannels.runDoctor),
  getRecentLogs: (count) => invoke(ipcChannels.getRecentLogs, count),
  clearLogs: () => invoke(ipcChannels.clearLogs),
  getSettings: () => invoke(ipcChannels.getSettings),
  setSettings: (partial) => invoke(ipcChannels.setSettings, partial),
  selectFolders: () => invoke(ipcChannels.selectFolders),
  openConfigFolder: () => invoke(ipcChannels.openConfigFolder),
  openExternal: (url) => invoke(ipcChannels.openExternal, url),
  onServiceStateChanged: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) =>
      listener(payload as ServiceStatus);
    ipcRenderer.on(eventChannels.serviceStateChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(eventChannels.serviceStateChanged, wrapped);
    };
  },
  onLogAppended: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) =>
      listener(payload as LogEntry);
    ipcRenderer.on(eventChannels.logAppended, wrapped);
    return () => {
      ipcRenderer.removeListener(eventChannels.logAppended, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("localspace", api);
