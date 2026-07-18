import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@server/log";
import type { LogEntry, ServerMessage } from "@shared/protocol";
import { createAppForTest } from "./test-app";

/**
 * Exercises the live log-streaming path end-to-end: a raw WS connection registers as a control
 * (which subscribes it to TOPIC_CONTROLS in hub.ts), a server log line is emitted, and this
 * asserts the connection receives it as a `{type: "log"}` message.
 *
 * The test suite runs with LOG_LEVEL=silent (see package.json's `test` script) precisely so the
 * sink stays quiet and the rest of the suite's console output is pristine — but that also means
 * this file's own emitted line would never reach the sink at the default level. LOG_LEVEL is
 * raised locally for the lifetime of this file only, and restored in `afterAll`, so it doesn't
 * make any other file noisy.
 */

let app: Awaited<ReturnType<typeof createAppForTest>>;
let cookie: string;
let originalLevel: string | undefined;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "replay-logstream-"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ password: "senha-teste" }));
  app = await createAppForTest(dataDir);

  // Login happens before LOG_LEVEL is raised below, so its own "login success" line stays
  // suppressed under the suite's default `silent` — the only incidental console output from this
  // file should be the one line the test itself emits and asserts on.
  const res = await fetch(`${app.base}/api/login`, {
    method: "POST",
    body: JSON.stringify({ password: "senha-teste" }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;

  originalLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "info";
});

afterAll(() => {
  app.stop(); // also disposes this file's log sink (see test-app.ts) — no leak into other files
  if (originalLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLevel;
});

describe("live log streaming over websocket", () => {
  it("delivers an emitted server log line to a registered control connection", async () => {
    const ws = new WebSocket(app.ws, { headers: { cookie } } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "register", role: "control" }));
        resolve();
      };
      ws.onerror = () => reject(new Error("ws error"));
    });

    const received = new Promise<LogEntry>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for log message")), 5000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        if (msg.type === "log" && msg.entry.message === "hello from log-stream test") {
          clearTimeout(timer);
          resolve(msg.entry);
        }
      };
    });

    // Registration subscribes this connection to TOPIC_CONTROLS synchronously server-side, but a
    // control registration (unlike a camera's) gets no ack message to await — so instead of
    // guessing a fixed delay is long enough, retry the emission every 100ms until the message
    // shows up or the 5s timeout above fires. Keeps this deterministic without being flaky on a
    // slow CI box.
    const retry = setInterval(
      () => logger("test").info("hello from log-stream test", { cam: "Fundo" }),
      100,
    );
    try {
      const entry = await received;
      expect(entry.message).toBe("hello from log-stream test");
      expect(entry.level).toBe("info");
      expect(entry.scope).toBe("test");
      expect(entry.fields).toEqual({ cam: "Fundo" });
      expect(typeof entry.seq).toBe("number");
    } finally {
      clearInterval(retry);
      ws.close();
    }
  });
});
