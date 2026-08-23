import { Menu, nativeImage, Tray } from "electron";
import { trayIcons } from "./tray-icon.js";
import type { ServiceStatus } from "../shared/types.js";
import { uiStrings } from "../shared/ui-strings.js";

export interface TrayCallbacks {
  readonly onOpenPanel: () => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onQuit: () => void;
}

function loadTrayIcon(): Electron.NativeImage | null {
  for (const entry of [...trayIcons].reverse()) {
    try {
      const image = nativeImage.createFromBuffer(Buffer.from(entry.base64, "base64"));
      if (!image.isEmpty()) return image;
    } catch {
      // Try the next size.
    }
  }
  return null;
}

export class TrayController {
  private tray: Electron.Tray | null = null;

  constructor(private readonly callbacks: TrayCallbacks) {}

  ensureCreated(): void {
    if (this.tray) return;
    const icon = loadTrayIcon();
    if (!icon) return;
    this.tray = new Tray(icon);
    this.tray.on("double-click", this.callbacks.onOpenPanel);
    this.update({ state: "stopped" });
  }

  update(status: ServiceStatus): void {
    if (!this.tray) return;
    const stateLabel = uiStrings.stateLabels[status.state] ?? status.state;
    this.tray.setToolTip(`${uiStrings.appName}: ${stateLabel}`);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `${uiStrings.appName}: ${stateLabel}`, enabled: false },
        { type: "separator" },
        { label: uiStrings.tray.openPanel, click: this.callbacks.onOpenPanel },
        { label: uiStrings.tray.start, click: this.callbacks.onStart, enabled: status.state !== "running" && status.state !== "starting" },
        { label: uiStrings.tray.stop, click: this.callbacks.onStop, enabled: status.state === "running" || status.state === "starting" },
        { type: "separator" },
        { label: uiStrings.tray.quit, click: this.callbacks.onQuit },
      ]),
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
