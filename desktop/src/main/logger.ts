import type { LogEntry } from "../shared/types.js";

const maxEntries = 2000;

/** In-memory ring buffer of service and app log lines, streamed to the renderer. */
export class LogBuffer {
  private entries: LogEntry[] = [];
  private listeners = new Set<(entry: LogEntry) => void>();

  append(stream: LogEntry["stream"], line: string): void {
    const entry: LogEntry = { timestamp: Date.now(), stream, line };
    this.entries.push(entry);
    if (this.entries.length > maxEntries) {
      this.entries.splice(0, this.entries.length - maxEntries);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(entry);
      } catch {
        // A failing subscriber must never break logging.
      }
    }
  }

  recent(count?: number): ReadonlyArray<LogEntry> {
    if (count === undefined || count >= this.entries.length) return [...this.entries];
    const start = this.entries.length - count;
    return this.entries.slice(start >= 0 ? start : 0);
  }

  clear(): void {
    this.entries = [];
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Splits a raw stdout/stderr chunk into complete lines, keeping the remainder. */
export class LineSplitter {
  private remainder = "";

  push(chunk: string): ReadonlyArray<string> {
    const combined = this.remainder + chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = combined.split("\n");
    this.remainder = parts.pop() ?? "";
    return parts.filter((line) => line.trim().length > 0);
  }
}
