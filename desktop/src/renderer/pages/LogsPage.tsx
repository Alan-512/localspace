import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../shared/api.js";
import type { LogEntry } from "../../shared/types.js";
import type { JSX } from "react";

const streamLabels: Record<LogEntry["stream"], string> = {
  stdout: "输出",
  stderr: "错误",
  app: "应用",
};

export function LogsPage({ api }: { api: DesktopApi }): JSX.Element {
  const [entries, setEntries] = useState<ReadonlyArray<LogEntry>>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      const result = await api.getRecentLogs(1000);
      if (result.ok) setEntries(result.data);
    })();
    return api.onLogAppended((entry) => {
      setEntries((current) => [...current.slice(-1999), entry]);
    });
  }, [api]);

  useEffect(() => {
    if (!autoScroll) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, autoScroll]);

  return (
    <div className="page page-full">
      <div className="logs-toolbar">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(event) => setAutoScroll(event.target.checked)}
          />
          自动滚动
        </label>
        <button type="button" className="btn btn-small" onClick={() => void api.clearLogs()}>
          清空
        </button>
      </div>
      <div className="log-view" ref={listRef}>
        {entries.length === 0 && <p className="hint">暂无日志。启动服务后，这里会显示服务的输出。</p>}
        {entries.map((entry, index) => (
          <div key={`${entry.timestamp}-${index}`} className={`log-line log-${entry.stream}`}>
            <span className="log-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
            <span className="log-stream">[{streamLabels[entry.stream]}]</span>
            <span className="log-text">{entry.line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
