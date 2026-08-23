import { useEffect, useState } from "react";
import type { DesktopApi } from "../../shared/api.js";
import type { AppState, DesktopSettings } from "../../shared/types.js";
import type { JSX } from "react";

export function SettingsPage({
  api,
  state,
  onReloadState,
}: {
  api: DesktopApi;
  state: AppState;
  onReloadState: () => void;
}): JSX.Element {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const result = await api.getSettings();
      if (result.ok) setSettings(result.data);
      else setError(result.error);
    })();
  }, [api]);

  const update = async (partial: Partial<DesktopSettings>) => {
    setError(null);
    const result = await api.setSettings(partial);
    if (result.ok) setSettings(result.data);
    else setError(result.error);
  };

  return (
    <div className="page">
      <section className="card">
        <div className="card-head">
          <h2>常规</h2>
        </div>
        {settings && (
          <>
            <label className="setting-row">
              <input
                type="checkbox"
                checked={settings.launchAtStartup}
                onChange={(event) => void update({ launchAtStartup: event.target.checked })}
              />
              <span>
                开机自动启动
                <small>启动后最小化到托盘并自动运行 MCP 服务。</small>
              </span>
            </label>
            <label className="setting-row">
              <input
                type="checkbox"
                checked={settings.closeToTray}
                onChange={(event) => void update({ closeToTray: event.target.checked })}
              />
              <span>
                关闭窗口时驻留托盘<small>关闭按钮只是隐藏窗口，服务保持运行；从托盘菜单可完全退出。</small>
              </span>
            </label>
          </>
        )}
        {error && <p className="field-error">{error}</p>}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>配置文件</h2>
          <button type="button" className="btn btn-small" onClick={() => void api.openConfigFolder()}>
            打开配置目录
          </button>
        </div>
        <p className="hint">
          配置：<code>{state.files?.configPath ?? "—"}</code>
          <br />
          密码：<code>{state.files?.authPath ?? "—"}</code>
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>关于</h2>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              void api.openExternal("https://github.com/Alan-512/localspace");
              onReloadState();
            }}
          >
            项目主页
          </button>
        </div>
        <p className="hint">
          应用版本：{state.appVersion} · LocalSpace 核心：{state.coreVersion ?? "未知"}
        </p>
      </section>
    </div>
  );
}
