import { join } from "node:path";
import type { LogEntry, ServerMessage } from "@shared/protocol";
import type { Server } from "bun";
import QRCode from "qrcode";
import { Auth, RateLimiter } from "./auth";
import { ensureCert } from "./cert";
import { JobManager } from "./clip-job";
import { ConfigStore } from "./config";
import { Hub, TOPIC_ALL, TOPIC_CAMERAS, TOPIC_CONTROLS, type WSData } from "./hub";
import { addLogSink, logger } from "./log";
import { LogBuffer } from "./log-buffer";
import { buildPages } from "./pages";
import { SerialQueue } from "./queue";
import { type AppContext, createApp } from "./routes";
import { Storage } from "./storage";

const log = logger("server");

/**
 * Composition root: reads env config, wires every singleton together (config, storage, hub,
 * queue, auth, jobs, the HTTP/WS app), then starts one or two `Bun.serve` listeners depending on
 * mode. See the `behindProxy` branch below for the two supported deployment modes.
 *
 * Env vars: DATA_DIR (persisted state root), HTTPS_PORT/HTTP_PORT (LAN mode's dual listeners),
 * BEHIND_PROXY (switches to proxy mode — plain HTTP on PORT, no self-signed cert), PUBLIC_URL
 * (the URL to print/QR-code in proxy mode, since there's no LAN IP to infer it from), HOST_LAN_IP
 * (LAN mode: the IP baked into the cert's SAN and shown in the entry URL). All app config (the
 * required PASSWORD, clip duration, target resolution/fps, retention, ...) also comes from the
 * environment — see `config.ts#ConfigStore.fromEnv` and `.env.example`.
 */
const dataDir = process.env.DATA_DIR ?? "data";
const httpsPort = Number(process.env.HTTPS_PORT ?? 8443);
const httpPort = Number(process.env.HTTP_PORT ?? 8080);
const behindProxy = /^(1|true|yes)$/i.test(process.env.BEHIND_PROXY ?? "");
const publicUrl = process.env.PUBLIC_URL;
const port = Number(process.env.PORT ?? 8080);

const config = ConfigStore.fromEnv();
const storage = new Storage(dataDir);
const hub = new Hub();
const queue = new SerialQueue();

// Log sink wiring: registered as early as possible (before `ensureCert` below, which logs during
// boot) so nothing is missed. `logBuffer` always gets every emitted line regardless of timing;
// `publishLog` starts out null because `server` doesn't exist yet at this point in boot — it's
// assigned further down, right after each branch's `Bun.serve()` call. Boot-time lines emitted
// before that (e.g. cert generation) still land in the console + ring buffer, they just aren't
// WS-published, which is fine: no control page could possibly be connected yet at that point.
const logBuffer = new LogBuffer(200);
let publishLog: ((entry: LogEntry) => void) | null = null;
addLogSink((entry) => {
  logBuffer.push(entry);
  publishLog?.(entry);
});

// `ctx.jobs` is patched in below, right after construction: `AppContext` (read by createApp/
// routes.ts) needs a `jobs: JobManager`, but JobManager's own callbacks need to call
// `server.publish` — and `server` doesn't exist until `Bun.serve()` runs further down, which
// itself needs `createApp(ctx)`. The placeholder cast breaks that ordering knot the same way the
// `server` forward reference below does: it's only ever read after everything is fully wired.
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
});

const app = createApp(ctx);

// `server` is referenced by the publishRecord/onUpdate closures above before it's assigned below —
// safe because those closures only run after Bun.serve() has returned (on an incoming request or
// job event), never during module init.
let server: Server<WSData>;

if (behindProxy) {
  // Proxy mode: the reverse proxy (Caddy/nginx/Cloudflare) terminates TLS and forwards plain HTTP.
  // No self-signed cert, no redirect server — just one plain-HTTP listener on PORT. Doing our own
  // TLS here too would be redundant (the proxy already speaks HTTPS to the outside world) and the
  // common reverse-proxy pattern is plain HTTP on the backend hop, so all of cert.ts's self-signed
  // cert / dual-port dance is skipped entirely in this mode.
  server = Bun.serve({
    port,
    routes: app.routes,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  publishLog = (entry) =>
    server.publish(TOPIC_CONTROLS, JSON.stringify({ type: "log", entry } satisfies ServerMessage));
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
  publishLog = (entry) =>
    server.publish(TOPIC_CONTROLS, JSON.stringify({ type: "log", entry } satisfies ServerMessage));

  // Plain-HTTP listener whose only job is bouncing to HTTPS: a LAN device that typed "http://" or
  // followed a stale bookmark/link would otherwise hit a connection error instead of being routed
  // to the working URL. Preserves the original pathname + query string in the redirect target.
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

// This is where Hub's onStateChanged hook (see hub.ts) resolves into an actual broadcast: Hub
// itself can't call server.publish (no reference to the Server), so it calls this instead.
function publishState(): void {
  const state: ServerMessage = {
    type: "state",
    cameras: hub.cameras(),
    clipDurationSeconds: config.value.clipDurationSeconds,
    audioSourceName: config.value.audioSourceName,
    bufferCycleMinSeconds: config.value.bufferCycleMinSeconds,
    jobs: ctx.jobs.jobs(),
    freeDiskGB: storage.freeDiskGB(),
  };
  server.publish(TOPIC_ALL, JSON.stringify(state));
}
hub.setOnStateChanged(publishState);

log.debug("sweep interval started", { intervalMs: 2_000 });
// Drives hub.ts's offline-detection sweep. Polled every 2s against OFFLINE_AFTER_MS (10s), so an
// unresponsive camera is detected within roughly 10-12s, not instantly but with a bounded delay.
setInterval(() => hub.sweep(Date.now()), 2_000);

function runRetentionCleanup(): void {
  const deleted = storage.cleanupRetention(config.value.retentionDays, Date.now());
  if (deleted.length > 0) {
    log.info("retention cleanup", { removed: deleted.length });
  }
}
runRetentionCleanup(); // catch up immediately on anything missed while the server was down
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

console.log(`\nLocal Replay no ar: ${entryUrl}\n`);
console.log(await QRCode.toString(entryUrl, { type: "terminal", small: true }));
