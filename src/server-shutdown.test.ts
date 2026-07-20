import assert from "node:assert/strict";
import { shutdownHttpServer } from "./server-shutdown.js";

{
  const events: string[] = [];
  let finishHttpClose: (() => void) | undefined;
  let finishApplicationClose: (() => void) | undefined;

  const shutdown = shutdownHttpServer(
    {
      close: (callback) => {
        events.push("http-close-started");
        finishHttpClose = () => {
          events.push("http-close-finished");
          callback();
        };
      },
    },
    async () => {
      events.push("application-close-started");
      await new Promise<void>((resolve) => {
        finishApplicationClose = resolve;
      });
      events.push("application-close-finished");
    },
  );

  assert.deepEqual(events, ["http-close-started", "application-close-started"]);
  finishHttpClose?.();
  await Promise.resolve();
  assert.deepEqual(events, [
    "http-close-started",
    "application-close-started",
    "http-close-finished",
  ]);

  finishApplicationClose?.();
  await shutdown;
  assert.deepEqual(events, [
    "http-close-started",
    "application-close-started",
    "http-close-finished",
    "application-close-finished",
  ]);
}

{
  await assert.rejects(
    () =>
      shutdownHttpServer(
        {
          close: (callback) => callback(new Error("http close failed")),
        },
        async () => undefined,
      ),
    /http close failed/,
  );
}
