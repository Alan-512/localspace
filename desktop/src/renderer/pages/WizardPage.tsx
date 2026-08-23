import { useState } from "react";
import type { DesktopApi } from "../../shared/api.js";
import type { LocalspaceConfigSnapshot } from "../../shared/types.js";
import type { JSX } from "react";

interface WizardProps {
  api: DesktopApi;
  existing: LocalspaceConfigSnapshot | null;
  /** True when re-configuring an already set up installation. */
  force: boolean;
  onFinished: () => void;
  onCancel?: () => void;
}

export function WizardPage({ api, existing, force, onFinished, onCancel }: WizardProps): JSX.Element {
  const [roots, setRoots] = useState<ReadonlyArray<string>>(existing?.allowedRoots ?? []);
  const [manualRoot, setManualRoot] = useState("");
  const [port, setPort] = useState(String(existing?.port ?? 7676));
  const [publicBaseUrl, setPublicBaseUrl] = useState(
    typeof existing?.publicBaseUrl === "string" ? existing.publicBaseUrl : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneToken, setDoneToken] = useState<string | null>(null);

  const addManualRoot = () => {
    const trimmed = manualRoot.trim();
    if (!trimmed) return;
    if (!roots.includes(trimmed)) setRoots([...roots, trimmed]);
    setManualRoot("");
  };

  const pickFolders = async () => {
    const result = await api.selectFolders();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.data.canceled) return;
    setRoots((current) => {
      const merged = [...current];
      for (const path of result.data.paths) {
        if (!merged.includes(path)) merged.push(path);
      }
      return merged;
    });
  };

  const submit = async () => {
    setError(null);

    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError("端口必须是 1–65535 之间的整数。");
      return;
    }
    if (roots.length === 0) {
      setError("请至少添加一个项目目录。");
      return;
    }
    const trimmedUrl = publicBaseUrl.trim().replace(/\/+$/, "");
    if (trimmedUrl.endsWith("/mcp")) {
      setError("公网地址只填到根路径即可，不要带 /mcp。");
      return;
    }

    setSubmitting(true);
    const result = await api.wizardComplete({
      roots,
      port: parsedPort,
      publicBaseUrl: publicBaseUrl.trim(),
      force,
    });
    setSubmitting(false);

    if (result.ok && result.data.ok) {
      setDoneToken(result.data.ownerToken ?? null);
    } else {
      setError((result.ok ? result.data.error : result.error) ?? "配置失败");
    }
  };

  if (doneToken !== null) {
    return (
      <div className="wizard">
        <h1>配置完成 🎉</h1>
        <section className="card">
          <p>
            请妥善保存你的 Owner 密码（也随时可以在主面板查看）。它只存储在本机
            <code> ~/.localspace/auth.json</code>。
          </p>
          <div className="secret-reveal">
            <code className="secret-value">{doneToken}</code>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void api.copyToClipboard(doneToken)}
            >
              复制密码
            </button>
          </div>
        </section>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={onFinished}>
            完成
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard">
      <h1>{force ? "重新配置 LocalSpace" : "欢迎使用 LocalSpace"}</h1>
      <p className="wizard-intro">
        三步完成：选择允许访问的项目目录 → 设置本地端口 → 填入公网地址。数据始终保留在你的电脑上。
      </p>

      <section className="card">
        <h2>1 · 允许访问的项目目录</h2>
        <p className="hint">目录越窄越安全，建议选择具体项目文件夹而不是整个磁盘或用户主目录。</p>
        <ul className="roots-edit-list">
          {roots.map((root) => (
            <li key={root} className="root-item">
              <span>{root}</span>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setRoots(roots.filter((entry) => entry !== root))}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => void pickFolders()}>
            选择文件夹…
          </button>
        </div>
        <div className="inline-input">
          <input
            type="text"
            placeholder="或手动输入完整路径后回车"
            value={manualRoot}
            onChange={(event) => setManualRoot(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addManualRoot();
            }}
          />
          <button type="button" className="btn" onClick={addManualRoot}>
            添加
          </button>
        </div>
      </section>

      <section className="card">
        <h2>2 · 本地端口</h2>
        <div className="inline-input">
          <label htmlFor="wizard-port">端口</label>
          <input
            id="wizard-port"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(event) => setPort(event.target.value)}
          />
        </div>
      </section>

      <section className="card">
        <h2>3 · 公网接入地址</h2>
        <p className="hint">
          ChatGPT / Claude 需要通过 HTTPS 访问本机。当前版本请粘贴你已有的隧道地址
          （Cloudflare Tunnel、ngrok、cpolar 等的公网 origin，不带 /mcp）。
          一键隧道将在后续版本内置。
        </p>
        <input
          className="wide-input"
          type="url"
          placeholder="https://your-tunnel.example.com"
          value={publicBaseUrl}
          onChange={(event) => setPublicBaseUrl(event.target.value)}
        />
      </section>

      {error && <p className="field-error">{error}</p>}
      <div className="btn-row">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
            取消
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={submitting} onClick={() => void submit()}>
          {submitting ? "正在写入配置…" : force ? "保存新配置" : "完成配置"}
        </button>
      </div>
    </div>
  );
}
