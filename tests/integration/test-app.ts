import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, RateLimiter } from "../../src/server/auth";
import { JobManager } from "../../src/server/clip-job";
import { ConfigStore } from "../../src/server/config";
import { Hub, TOPIC_ALL, TOPIC_CAMERAS } from "../../src/server/hub";
import { buildPages } from "../../src/server/pages";
import { SerialQueue } from "../../src/server/queue";
import { createApp, type AppContext } from "../../src/server/routes";
import { Storage } from "../../src/server/storage";
import type { ServerMessage } from "../../src/shared/protocol";

export async function createAppForTest(
  dataDir: string,
  jobOverrides: { uploadTimeoutMs?: number; cooldownMs?: number } = {},
  opts: { trustProxy?: boolean; loginLimiter?: RateLimiter } = {},
) {
  const config = ConfigStore.load(dataDir);
  const storage = new Storage(dataDir);
  const hub = new Hub();
  const queue = new SerialQueue();
  const ctx: AppContext = {
    dataDir,
    config,
    storage,
    auth: Auth.load(dataDir, () => config.value.password),
    hub,
    loginLimiter: opts.loginLimiter ?? new RateLimiter(100, 60_000),
    trustProxy: opts.trustProxy ?? false,
    pages: await buildPages("src/web", mkdtempSync(join(tmpdir(), "replay-dist-"))),
    jobs: undefined as unknown as JobManager,
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
  hub.onStateChanged = () =>
    server.publish(
      TOPIC_ALL,
      JSON.stringify({
        type: "state",
        cameras: hub.cameras(),
        clipDurationSeconds: config.value.clipDurationSeconds,
        bufferCycleMinSeconds: config.value.bufferCycleMinSeconds,
        jobs: ctx.jobs.jobs(),
        freeDiskGB: storage.freeDiskGB(),
      } satisfies ServerMessage),
    );
  return {
    base: `http://localhost:${server.port}`,
    ws: `ws://localhost:${server.port}/ws`,
    server,
    ctx,
    stop: () => server.stop(true),
  };
}
