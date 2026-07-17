import { join } from "node:path";
import QRCode from "qrcode";
import { Auth, RateLimiter } from "./auth";
import { JobManager } from "./clip-job";
import { ConfigStore } from "./config";
import { ensureCert } from "./cert";
import { Hub, TOPIC_ALL, TOPIC_CAMERAS } from "./hub";
import { buildPages } from "./pages";
import { SerialQueue } from "./queue";
import { createApp, type AppContext } from "./routes";
import { Storage } from "./storage";
import type { ServerMessage } from "../shared/protocol";

const dataDir = process.env.DATA_DIR ?? "data";
const httpsPort = Number(process.env.HTTPS_PORT ?? 8443);
const httpPort = Number(process.env.HTTP_PORT ?? 8080);

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
  loginLimiter: new RateLimiter(5, 60_000),
  pages: await buildPages("src/web", join(dataDir, "dist")),
  jobs: undefined as unknown as JobManager,
};
ctx.jobs = new JobManager({
  storage, config, hub, queue,
  publishRecord: (jobId, t, windowSec) =>
    server.publish(TOPIC_CAMERAS, JSON.stringify({ type: "record", jobId, t, windowSec } satisfies ServerMessage)),
  onUpdate: () => publishState(),
});

const { certPath, keyPath } = await ensureCert(dataDir);
const app = createApp(ctx);
const server = Bun.serve({
  port: httpsPort,
  tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) },
  fetch: app.fetch,
  websocket: app.websocket,
});

function publishState(): void {
  const state: ServerMessage = {
    type: "state",
    cameras: hub.cameras(),
    clipDurationSeconds: config.value.clipDurationSeconds,
    jobs: ctx.jobs.jobs(),
  };
  server.publish(TOPIC_ALL, JSON.stringify(state));
}
hub.onStateChanged = publishState;

Bun.serve({
  port: httpPort,
  fetch(req) {
    const url = new URL(req.url);
    return Response.redirect(`https://${url.hostname}:${httpsPort}${url.pathname}`, 301);
  },
});

setInterval(() => hub.sweep(Date.now()), 2_000);
storage.cleanupRetention(config.value.retentionDays, Date.now());
setInterval(() => storage.cleanupRetention(config.value.retentionDays, Date.now()), 24 * 60 * 60 * 1000);

const host = process.env.HOST_LAN_IP ?? "localhost";
const entryUrl = `https://${host}:${httpsPort}`;
console.log(`\nReplay Local no ar: ${entryUrl}`);
console.log(`Senha de acesso: ${config.value.password}\n`);
console.log(await QRCode.toString(entryUrl, { type: "terminal", small: true }));
