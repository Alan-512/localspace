// Centralized zh-CN UI strings shared by the Electron main process (tray,
// dialogs) and the React renderer. Adding a language later means adding a
// sibling export of this shape, not scattering new literals.
export const uiStrings = {
  appName: "LocalSpace",
  windowTitle: "LocalSpace 控制台",
  tray: {
    openPanel: "打开控制台",
    start: "启动服务",
    stop: "停止服务",
    quit: "退出",
  },
  stateLabels: {
    stopped: "已停止",
    starting: "启动中…",
    running: "运行中",
    stopping: "停止中…",
    error: "出错",
  } as Record<string, string>,
  tabs: {
    dashboard: "主面板",
    logs: "日志",
    settings: "设置",
  },
} as const;

export type UiStrings = typeof uiStrings;
