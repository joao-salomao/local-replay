import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, RateLimiter } from "@server/auth";
import { JobManager } from "@server/clip-job";
import { ConfigStore } from "@server/config";
import { Hub, TOPIC_ALL, TOPIC_CAMERAS, TOPIC_CONTROLS } from "@server/hub";
import { addLogSink } from "@server/log";
import { LogBuffer } from "@server/log-buffer";
import { buildPages } from "@server/pages";
import { SerialQueue } from "@server/queue";
import { type AppContext, createApp } from "@server/routes";
import { Storage } from "@server/storage";
import type { LogEntry, ServerMessage } from "@shared/protocol";

export async function createAppForTest(
  dataDir: string,
  jobOverrides: { uploadTimeoutMs?: number; cooldownMs?: number } = {},
  opts: {
    trustProxy?: boolean;
    loginLimiter?: RateLimiter;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const config = ConfigStore.fromEnv(
    opts.env ?? { PASSWORD: "senha-teste", SESSION_SECRET: "test-secret" },
  );
  const storage = new Storage(dataDir);
  const hub = new Hub();
  const queue = new SerialQueue();

  // Mirrors server/index.ts's sink wiring (see its comments for the full rationale): `logBuffer`
  // always gets every emitted line, `publishLog` is filled in once `server` exists below. The
  // disposer is both exposed directly (`disposeLogSink`) and invoked from `stop()`, so every
  // existing call site that already calls `.stop()` gets leak-free cleanup for free — this matters
  // because the log sink registry is a module-level singleton shared across every app instance the
  // test suite builds, and a leaked sink keeps firing (and slowing down) long after its app died.
  const logBuffer = new LogBuffer(200);
  let publishLog: ((entry: LogEntry) => void) | null = null;
  const disposeLogSink = addLogSink((entry) => {
    logBuffer.push(entry);
    publishLog?.(entry);
  });

  const ctx: AppContext = {
    dataDir,
    config,
    storage,
    auth: new Auth(config.value.sessionSecret, () => config.value.password),
    hub,
    loginLimiter: opts.loginLimiter ?? new RateLimiter(100, 60_000),
    trustProxy: opts.trustProxy ?? false,
    pages: await buildPages("src/web", mkdtempSync(join(tmpdir(), "replay-dist-"))),
    jobs: undefined as unknown as JobManager,
    logBuffer,
  };
  ctx.jobs = new JobManager({
    storage,
    config,
    hub,
    queue,
    publishRecord: (jobId, t, windowSec) =>
      server.publish(
        TOPIC_CAMERAS,
        JSON.stringify({ type: "record", jobId, t, windowSec } satisfies ServerMessage),
      ),
    onUpdate: (job) =>
      server.publish(TOPIC_ALL, JSON.stringify({ type: "jobUpdate", job } satisfies ServerMessage)),
    ...jobOverrides,
  });
  const app = createApp(ctx);
  const server = Bun.serve({
    port: 0,
    routes: app.routes,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  publishLog = (entry) =>
    server.publish(TOPIC_CONTROLS, JSON.stringify({ type: "log", entry } satisfies ServerMessage));
  hub.setOnStateChanged(() =>
    server.publish(
      TOPIC_ALL,
      JSON.stringify({
        type: "state",
        cameras: hub.cameras(),
        clipDurationSeconds: config.value.clipDurationSeconds,
        audioSourceName: config.value.audioSourceName,
        bufferCycleMinSeconds: config.value.bufferCycleMinSeconds,
        jobs: ctx.jobs.jobs(),
        freeDiskGB: storage.freeDiskGB(),
      } satisfies ServerMessage),
    ),
  );
  return {
    base: `http://localhost:${server.port}`,
    ws: `ws://localhost:${server.port}/ws`,
    server,
    ctx,
    disposeLogSink,
    // Disposing the log sink here means every existing `afterAll(() => stop())` caller already
    // avoids leaking a sink into the rest of the suite without needing to know this exists; a test
    // that specifically exercises the sink can still call `disposeLogSink()` directly first.
    stop: () => {
      disposeLogSink();
      server.stop(true);
    },
  };
}
