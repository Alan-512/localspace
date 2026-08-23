import type { DesktopApi } from "../shared/api.js";

/** Throws a readable error when preload did not run (mispackaged app). */
export function getDesktopApi(): DesktopApi {
  const api = (window as { localspace?: DesktopApi }).localspace;
  if (!api) {
    throw new Error("LocalSpace 桥接未加载，请重新安装应用。");
  }
  return api;
}
