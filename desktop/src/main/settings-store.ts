import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesktopSettings } from "../shared/types.js";

export const defaultSettings: DesktopSettings = {
  launchAtStartup: false,
  closeToTray: true,
};

function settingsFilePath(userDataDir: string): string {
  return join(userDataDir, "localspace-desktop-settings.json");
}

export function loadSettings(userDataDir: string): DesktopSettings {
  const filePath = settingsFilePath(userDataDir);
  if (!existsSync(filePath)) return { ...defaultSettings };
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DesktopSettings>;
    return {
      launchAtStartup: typeof raw.launchAtStartup === "boolean" ? raw.launchAtStartup : defaultSettings.launchAtStartup,
      closeToTray: typeof raw.closeToTray === "boolean" ? raw.closeToTray : defaultSettings.closeToTray,
    };
  } catch {
    // Corrupt settings fall back to defaults instead of blocking startup.
    return { ...defaultSettings };
  }
}

export function saveSettings(userDataDir: string, settings: DesktopSettings): DesktopSettings {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(settingsFilePath(userDataDir), `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}
