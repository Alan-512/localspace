import { useCallback, useEffect, useState } from "react";
import type { DesktopApi } from "../shared/api.js";
import type { AppState, ServiceStatus } from "../shared/types.js";
import { uiStrings } from "../shared/ui-strings.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { LogsPage } from "./pages/LogsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { WizardPage } from "./pages/WizardPage.js";
import type { JSX } from "react";

export type Tab = "dashboard" | "logs" | "settings";

export function App({ api }: { api: DesktopApi }): JSX.Element {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [reconfiguring, setReconfiguring] = useState(false);

  const reload = useCallback(async () => {
    const result = await api.getState();
    if (result.ok) {
      setState(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.error);
    }
  }, [api]);

  useEffect(() => {
    void reload();
    return api.onServiceStateChanged((status: ServiceStatus) => {
      setState((current) => (current ? { ...current, service: status } : current));
    });
  }, [api, reload]);

  if (loadError) {
    return <FatalError message={loadError} onRetry={() => void reload()} />;
  }
  if (!state) {
    return <div className="splash">正在加载…</div>;
  }

  const configured = state.configured && !reconfiguring;
  if (!configured) {
    return (
      <WizardPage
        api={api}
        existing={state.files?.config ?? null}
        force={reconfiguring}
        onFinished={() => {
          setReconfiguring(false);
          void reload();
        }}
        onCancel={reconfiguring ? () => setReconfiguring(false) : undefined}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="brand-mark">›</span>
          <h1>{uiStrings.windowTitle}</h1>
          <span className={`state-pill state-${state.service.state}`}>
            {uiStrings.stateLabels[state.service.state] ?? state.service.state}
          </span>
        </div>
        <nav className="tabs">
          {(["dashboard", "logs", "settings"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`tab ${tab === key ? "active" : ""}`}
              onClick={() => setTab(key)}
            >
              {uiStrings.tabs[key]}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {tab === "dashboard" && (
          <DashboardPage api={api} state={state} onReconfigure={() => setReconfiguring(true)} />
        )}
        {tab === "logs" && <LogsPage api={api} />}
        {tab === "settings" && <SettingsPage api={api} state={state} onReloadState={() => void reload()} />}
      </main>
    </div>
  );
}

function FatalError({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="splash error-splash">
      <p>{message}</p>
      <button type="button" className="btn" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}
