import { join } from "node:path";
import QRCode from "qrcode";
import type { Server } from "bun";
import { Auth, RateLimiter } from "./auth";
import { JobManager } from "./clip-job";
import { ConfigStore } from "./config";
import { ensureCert } from "./cert";
import { Hub, TOPIC_ALL, TOPIC_CAMERAS, type WSData } from "./hub";
import { logger } from "./log";
import { buildPages } from "./pages";
import { SerialQueue } from "./queue";
import { createApp, type AppContext } from "./routes";
import { Storage } from "./storage";
import type { ServerMessage } from "../shared/protocol";

const log = logger("server");

const dataDir = process.env.DATA_DIR ?? "data";
const httpsPort = Number(process.env.HTTPS_PORT ?? 8443);
const httpPort = Number(process.env.HTTP_PORT ?? 8080);
const behindProxy = /^(1|true|yes)$/i.test(process.env.BEHIND_PROXY ?? "");
const publicUrl = process.env.PUBLIC_URL;
const port = Number(process.env.PORT ?? 8080);

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
  trustProxy: behindProxy,
  pages: await buildPages("src/web", join(dataDir, "dist")),
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
});

const app = createApp(ctx);

// `server` is referenced by the publishRecord/onUpdate closures above before it's assigned below —
// safe because those closures only run after Bun.serve() has returned (on an incoming request or
// job event), never during module init.
let server: Server<WSData>;

if (behindProxy) {
  // Proxy mode: the reverse proxy (Caddy/nginx/Cloudflare) terminates TLS and forwards plain HTTP.
  // No self-signed cert, no redirect server — just one plain-HTTP listener on PORT.
  server = Bun.serve({
    port,
    routes: app.routes,
    fetch: app.fetch,
    websocket: app.websocket,
  });
} else {
  // LAN mode (default): self-signed HTTPS + HTTP→HTTPS redirect, unchanged.
  const { certPath, keyPath } = await ensureCert(dataDir);
  server = Bun.serve({
    port: httpsPort,
    tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) },
    routes: app.routes,
    fetch: app.fetch,
    websocket: app.websocket,
  });

  Bun.serve({
    port: httpPort,
    fetch(req) {
      const url = new URL(req.url);
      return Response.redirect(
        `https://${url.hostname}:${httpsPort}${url.pathname}${url.search}`,
        301,
      );
    },
  });
}

function publishState(): void {
  const state: ServerMessage = {
    type: "state",
    cameras: hub.cameras(),
    clipDurationSeconds: config.value.clipDurationSeconds,
    bufferCycleMinSeconds: config.value.bufferCycleMinSeconds,
    jobs: ctx.jobs.jobs(),
    freeDiskGB: storage.freeDiskGB(),
  };
  server.publish(TOPIC_ALL, JSON.stringify(state));
}
hub.onStateChanged = publishState;

log.debug("sweep interval started", { intervalMs: 2_000 });
setInterval(() => hub.sweep(Date.now()), 2_000);

function runRetentionCleanup(): void {
  const deleted = storage.cleanupRetention(config.value.retentionDays, Date.now());
  if (deleted.length > 0) {
    log.info(`retention: removed ${deleted.length} day-folder(s)`, { count: deleted.length });
  }
}
runRetentionCleanup();
setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);

let entryUrl: string;
if (behindProxy) {
  if (!publicUrl) {
    console.warn(
      "\nAVISO: BEHIND_PROXY está ativo mas PUBLIC_URL não foi definida — o QR code e a URL " +
        "impressos abaixo vão apontar para localhost e não vão funcionar nos aparelhos dos " +
        "jogadores. Defina PUBLIC_URL=https://seu-dominio.exemplo (o endereço público servido " +
        "pelo proxy) para corrigir.\n",
    );
  }
  entryUrl = publicUrl ?? `http://localhost:${port}`;
} else {
  const host = process.env.HOST_LAN_IP ?? "localhost";
  entryUrl = `https://${host}:${httpsPort}`;
}

log.info(
  "boot",
  behindProxy ? { mode: "proxy", port, entryUrl } : { mode: "lan", httpsPort, httpPort, entryUrl },
);

console.log(`\nReplay Local no ar: ${entryUrl}`);
console.log(`Senha de acesso: ${config.value.password}\n`);
console.log(await QRCode.toString(entryUrl, { type: "terminal", small: true }));
