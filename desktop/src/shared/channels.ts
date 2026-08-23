// Single source of truth for IPC channel names. preload.ts only exposes these
// channels; ipc.ts only registers these channels. Anything not listed here is
// unreachable from the renderer.
export const ipcChannels = {
  getState: "app:get-state",
  wizardComplete: "app:wizard-complete",
  startService: "service:start",
  stopService: "service:stop",
  restartService: "service:restart",
  getConnectionInfo: "app:get-connection-info",
  revealOwnerToken: "app:reveal-owner-token",
  copyToClipboard: "app:copy-to-clipboard",
  runDoctor: "app:run-doctor",
  getRecentLogs: "logs:get-recent",
  clearLogs: "logs:clear",
  getSettings: "settings:get",
  setSettings: "settings:set",
  selectFolders: "dialog:select-folders",
  openConfigFolder: "shell:open-config-folder",
  openExternal: "shell:open-external",
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

export const eventChannels = {
  serviceStateChanged: "event:service-state-changed",
  logAppended: "event:log-appended",
} as const;

export type EventChannel = (typeof eventChannels)[keyof typeof eventChannels];
