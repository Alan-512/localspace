import { BrowserWindow, Menu, app, shell } from "electron";
import { join } from "node:path";

export interface MainWindowOptions {
  readonly preloadPath: string;
  readonly rendererIndex: string;
  /** Returns the current closeToTray setting at close time. */
  readonly shouldHideOnClose: () => boolean;
  readonly onReadyToShow?: () => void;
}

export interface MainWindowHandle {
  readonly window: BrowserWindow;
  load(): void;
}

export function createMainWindow(options: MainWindowOptions): MainWindowHandle {
  // Remove the default menu bar entirely; the app is fully in-page + tray driven.
  Menu.setApplicationMenu(null);

  const window = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: "LocalSpace",
    icon: join(process.resourcesPath ?? "", "icons", "tray.png"),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => {
    if (!app.getLoginItemSettings?.().wasOpenedAsHidden) {
      window.show();
    }
    options.onReadyToShow?.();
  });

  window.on("close", (event) => {
    if (options.shouldHideOnClose() && !(process.platform === "darwin" && window.isDestroyed())) {
      event.preventDefault();
      window.hide();
    }
  });

  // Navigation and popups are denied outright; http(s) links open in the
  // user's browser instead of ever loading inside the privileged window.
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      void shell.openExternal(parsed.toString());
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  return {
    window,
    load: () => {
      void window.loadFile(options.rendererIndex);
    },
  };
}
