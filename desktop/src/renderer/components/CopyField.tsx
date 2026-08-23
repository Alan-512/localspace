import { useState } from "react";
import type { DesktopApi } from "../../shared/api.js";
import type { JSX } from "react";

export function CopyRow({
  api,
  label,
  value,
  placeholder,
  mono = true,
}: {
  api: DesktopApi;
  label: string;
  value: string | null;
  placeholder?: string;
  mono?: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const display = value ?? placeholder ?? "—";

  return (
    <div className="copy-row">
      <span className="copy-label">{label}</span>
      <code className={`copy-value ${mono ? "" : "copy-value-prose"} ${value ? "" : "muted"}`}>
        {display}
      </code>
      <button
        type="button"
        className="btn btn-small"
        disabled={!value}
        onClick={async () => {
          if (!value) return;
          const result = await api.copyToClipboard(value);
          if (result.ok) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

/** Password field that only fetches the plaintext while revealed or on copy. */
export function SecretRow({ api, masked }: { api: DesktopApi; masked: string | null }): JSX.Element {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revealOrHide = async () => {
    setError(null);
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    setBusy(true);
    const result = await api.revealOwnerToken();
    setBusy(false);
    if (result.ok) {
      setRevealed(result.data ?? "");
    } else {
      setError(result.error);
    }
  };

  const copySecret = async () => {
    setError(null);
    setBusy(true);
    let token = revealed;
    if (token === null) {
      const reveal = await api.revealOwnerToken();
      if (!reveal.ok) {
        setBusy(false);
        setError(reveal.error);
        return;
      }
      token = reveal.data ?? "";
    }
    const copy = await api.copyToClipboard(token);
    setBusy(false);
    if (!copy.ok) setError(copy.error);
  };

  return (
    <div className="copy-row">
      <span className="copy-label">Owner 密码</span>
      <code className={`copy-value ${revealed ? "" : "secret-masked"}`}>
        {revealed ?? masked ?? "—"}
      </code>
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => void revealOrHide()}>
        {revealed ? "隐藏" : "显示"}
      </button>
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => void copySecret()}>
        复制
      </button>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}
