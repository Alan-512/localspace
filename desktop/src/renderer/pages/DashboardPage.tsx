import { useCallback, useEffect, useState } from "react";
import type { DesktopApi } from "../../shared/api.js";
import type { AppState, DoctorReportView } from "../../shared/types.js";
import { CopyRow, SecretRow } from "../components/CopyField.js";
import type { JSX } from "react";

export function DashboardPage({
  api,
  state,
  onReconfigure,
}: {
  api: DesktopApi;
  state: AppState;
  onReconfigure: () => void;
}): JSX.Element {
  const [connection, setConnection] = useState<Awaited<ReturnType<typeof api.getConnectionInfo>> | null>(null);
  const [doctor, setDoctor] = useState<DoctorReportView | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reloadConnection = useCallback(async () => {
    setConnection(await api.getConnectionInfo());
  }, [api]);

  useEffect(() => {
    void reloadConnection();
    return api.onServiceStateChanged(() => {
      void reloadConnection();
    });
  }, [api, reloadConnection]);

  const service = state.service;
  const busy = service.state === "starting" || service.state === "stopping";

  const runAction = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setActionError(null);
    const result = await action();
    if (!result.ok) setActionError(result.error ?? "操作失败");
  };

  const runDoctorNow = async () => {
    setDoctorRunning(true);
    const result = await api.runDoctor();
    setDoctorRunning(false);
    setDoctor(result.ok ? result.data : { ok: false, groups: [], error: result.error });
  };

  return (
    <div className="page">
      <section className="card">
        <div className="card-head">
          <h2>服务</h2>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || service.state === "running"}
              onClick={() => void runAction(api.startService)}
            >
              启动
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || service.state === "stopped"}
              onClick={() => void runAction(api.stopService)}
            >
              停止
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void runAction(api.restartService)}
            >
              重启
            </button>
          </div>
        </div>
        <p className={`state-line state-${service.state}`}>
          {statusLine(service)}
        </p>
        {service.error && <p className="field-error">{service.error}</p>}
        {actionError && <p className="field-error">{actionError}</p>}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>连接信息</h2>
        </div>
        <CopyRow
          api={api}
          label="本地 MCP 地址"
          value={connection?.ok ? connection.data.localMcpUrl : null}
        />
        <CopyRow
          api={api}
          label="公网 MCP 地址"
          value={connection?.ok ? connection.data.publicMcpUrl : null}
          placeholder="未配置公网地址，ChatGPT 将无法远程连接"
        />
        <SecretRow api={api} masked={connection?.ok ? connection.data.maskedOwnerToken : null} />
        {connection?.ok && connection.data.publicMcpUrl ? (
          <p className="hint">
            把公网 MCP 地址填入 ChatGPT / Claude 的 MCP 设置；首次连接时输入 Owner 密码完成授权。
          </p>
        ) : (
          <p className="hint">
            本机模式：把上方本地 MCP 地址填入安装在这台电脑上的 ChatGPT / Claude
            桌面版即可。需要手机或网页远程访问时，点「重新配置」切换为远程模式。
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>诊断</h2>
          <button type="button" className="btn" disabled={doctorRunning} onClick={() => void runDoctorNow()}>
            {doctorRunning ? "检查中…" : "运行诊断"}
          </button>
        </div>
        {doctor && (
          <>
            {doctor.error && <p className="field-error">{doctor.error}</p>}
            <ul className="doctor-list">
              {doctor.groups.map((group) => (
                <li key={group.id} className={group.ok ? "check-ok" : "check-fail"}>
                  <span className="check-dot">{group.ok ? "✓" : "✕"}</span>
                  <span className="check-label">{group.label}</span>
                  <span className="check-detail">{group.detail}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>工作区与配置</h2>
          <div className="btn-row">
            <button type="button" className="btn btn-small" onClick={() => void api.openConfigFolder()}>
              打开配置目录
            </button>
            <button type="button" className="btn btn-small" onClick={onReconfigure}>
              重新配置…
            </button>
          </div>
        </div>
        <ul className="roots-list">
          {(state.files?.config.allowedRoots ?? []).map((root) => (
            <li key={root} className="root-item">
              {root}
            </li>
          ))}
        </ul>
        <p className="hint">允许目录越窄越安全。核心版本：{state.coreVersion ?? "未知"} · 应用版本：{state.appVersion}</p>
      </section>
    </div>
  );
}

function statusLine(service: AppState["service"]): string {
  switch (service.state) {
    case "running":
      return `运行中 · PID ${service.pid ?? "?"} · 端口 ${service.port ?? "?"}`;
    case "starting":
      return "正在启动服务…";
    case "stopping":
      return "正在停止服务…";
    case "error":
      return "服务出错";
    default:
      return "服务未运行";
  }
}
