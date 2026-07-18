import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { LogEntry } from "@shared/protocol";
import type { BunRequest, Server, WebSocketHandler } from "bun";
import QRCode from "qrcode";
import type { Auth, RateLimiter } from "./auth";
import { tokenFromCookie } from "./auth";
import type { JobManager } from "./clip-job";
import type { ConfigStore } from "./config";
import type { Hub, WSData } from "./hub";
import { logger } from "./log";
import type { PageAssets, PageName } from "./pages";
import { slugify } from "./pipeline";
import type { Storage } from "./storage";

const log = logger("http");

/**
 * Builds the HTTP route table and WebSocket handler served by `Bun.serve` (wired up in
 * `server/index.ts`). Owns auth gating, request parsing/validation, and the two path-safety
 * guards in this file (`/assets/:name`'s whitelist lookup via `pages.ts`, and `/files/*`'s
 * traversal guard below) — Hub itself (`hub.ts`) stays unaware of HTTP/auth concerns.
 */

export type AppContext = {
  dataDir: string;
  config: ConfigStore;
  storage: Storage;
  auth: Auth;
  hub: Hub;
  jobs: JobManager;
  loginLimiter: RateLimiter;
  /** true when running behind a reverse proxy (BEHIND_PROXY) — trust X-Forwarded-For for client IP */
  trustProxy: boolean;
  pages: PageAssets;
  /** Recent-history backlog for the control page's live log viewer — see `log-buffer.ts` and the
   * `GET /api/logs` route below. */
  logBuffer: { entries(): LogEntry[] };
};

const CLIP_DURATION_OPTIONS = [10, 20, 30, 45, 60];

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

/** Builds the `{ routes, fetch, websocket }` triple passed straight to `Bun.serve`. */
export function createApp(ctx: AppContext) {
  // Thin adapter: routes.ts owns the Bun-specific WS wiring, Hub owns the protocol logic.
  const websocket: WebSocketHandler<WSData> = {
    open: (ws) => ctx.hub.open(ws),
    message: (ws, raw) => ctx.hub.message(ws, raw, Date.now()),
    close: (ws) => ctx.hub.close(ws),
  };

  const isAuthed = (req: Request) =>
    ctx.auth.verify(tokenFromCookie(req.headers.get("cookie")), Date.now());
  // Two guards, two different "not authed" behaviors: JSON API routes need a 401 JSON body a
  // fetch()-based caller can read and show an error for; page routes need a redirect to "/" so an
  // unauthenticated browser landing on e.g. /camera ends up back at the login page, not staring
  // at raw JSON.
  const requireAuth =
    (
      handler: (
        // biome-ignore lint/suspicious/noExplicitAny: Bun's route handler generics are awkward to thread through this HOF.
        req: any,
        server: Server<WSData>,
      ) => Response | undefined | Promise<Response | undefined>,
    ) =>
    // biome-ignore lint/suspicious/noExplicitAny: same HOF-generics tradeoff as above.
    (req: any, server: Server<WSData>) =>
      isAuthed(req) ? handler(req, server) : json({ error: "unauthorized" }, 401);
  const requireAuthPage =
    // biome-ignore lint/suspicious/noExplicitAny: same HOF-generics tradeoff as above.
      (handler: (req: any, server: Server<WSData>) => Response | Promise<Response>) =>
      // biome-ignore lint/suspicious/noExplicitAny: same HOF-generics tradeoff as above.
      (req: any, server: Server<WSData>) =>
        isAuthed(req) ? handler(req, server) : Response.redirect("/", 302);

  const pageRoute = (name: PageName) => ({
    GET: requireAuthPage(() => html(ctx.pages.html(name))),
  });

  const routes = {
    "/": { GET: () => html(ctx.pages.html("login")) },
    "/camera": pageRoute("camera"),
    "/control": pageRoute("control"),
    "/clips": pageRoute("clips"),

    "/assets/:name": {
      GET: (req: BunRequest<"/assets/:name">) => {
        const file = ctx.pages.assetFile(req.params.name);
        if (!file) return json({ error: "not found" }, 404);
        const type = file.endsWith(".css") ? "text/css" : "application/javascript";
        return new Response(Bun.file(file), { headers: { "content-type": type } });
      },
    },

    // Intentionally NOT requireAuth-gated: a device needs to download and trust this cert BEFORE
    // it can complete a working HTTPS connection to reach the login page at all (chicken-and-egg).
    "/cert": {
      GET: () => {
        const certPath = join(ctx.dataDir, "certs", "cert.pem");
        if (!existsSync(certPath)) return json({ error: "not found" }, 404);
        return new Response(Bun.file(certPath), {
          headers: {
            "content-type": "application/x-x509-ca-cert",
            "content-disposition": 'attachment; filename="local-replay.crt"',
          },
        });
      },
    },

    "/ws": {
      GET: requireAuth((req, server) =>
        server.upgrade(req, { data: {} as WSData })
          ? undefined
          : json({ error: "upgrade failed" }, 400),
      ),
    },

    "/api/login": {
      POST: async (req: Request, server: Server<WSData>) => {
        // X-Forwarded-For is a comma-separated list each proxy hop APPENDS to. The first entry is
        // whatever the original request claimed and is trivially spoofable by the client; only
        // the LAST entry — appended by the proxy Bun's own TCP connection actually came from — is
        // something an attacker can't forge. Only trusted at all under trustProxy (BEHIND_PROXY);
        // in LAN mode there's no trusted intermediary, so the real TCP peer IP is used instead.
        // Getting this wrong breaks the login rate limiter below: trusting a spoofable header
        // makes it bypassable, trusting the wrong hop makes it lump every client behind the proxy
        // into one bucket.
        const ip = ctx.trustProxy
          ? req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() || "unknown"
          : (server.requestIP(req)?.address ?? "unknown");

        if (!ctx.loginLimiter.allow(ip, Date.now())) {
          log.warn("rate limit hit", { ip });
          return json({ error: "muitas tentativas, aguarde" }, 429);
        }

        const body = (await req.json().catch(() => ({}))) as { password?: string };
        const token = ctx.auth.login(body.password ?? "", Date.now());

        if (!token) {
          log.warn("login failed", { ip });
          return json({ error: "senha incorreta" }, 401);
        }

        log.info("login success", { ip });
        return json({ ok: true }, 200, { "set-cookie": ctx.auth.cookieFor(token) });
      },
    },

    "/api/record": {
      POST: requireAuth(() => {
        const result = ctx.jobs.trigger(Date.now());
        if ("error" in result) {
          log.warn("record rejected", { reason: result.error });
          return json(result, result.error === "cooldown" ? 429 : 409);
        }
        log.info("record triggered", { jobId: result.jobId });
        return json(result);
      }),
    },

    "/api/config/clip-duration": {
      POST: requireAuth(async (req) => {
        const body = (await req.json().catch(() => ({}))) as { seconds?: number };
        if (!CLIP_DURATION_OPTIONS.includes(body.seconds ?? -1))
          return json({ error: "invalid seconds" }, 400);
        ctx.config.setClipDuration(body.seconds!);
        // Config changes aren't something Hub can detect on its own (they don't flow through any
        // WS message) — routes.ts has to explicitly ask for a state broadcast here.
        ctx.hub.notifyStateChanged();
        log.info("clip duration changed", { seconds: ctx.config.value.clipDurationSeconds });
        return json({ clipDurationSeconds: ctx.config.value.clipDurationSeconds });
      }),
    },

    "/api/config/audio-source": {
      POST: requireAuth(async (req) => {
        const body = (await req.json().catch(() => ({}))) as { name?: string | null };
        try {
          ctx.config.setAudioSource(body.name ?? null);
        } catch {
          return json({ error: "invalid name" }, 400);
        }
        // Like clip-duration: a config change doesn't flow through any WS message, so ask Hub to
        // rebroadcast state explicitly (see the note on the clip-duration handler above).
        ctx.hub.notifyStateChanged();
        log.info("audio source changed", {
          audioSourceName: ctx.config.value.audioSourceName ?? "(auto)",
        });
        return json({ audioSourceName: ctx.config.value.audioSourceName });
      }),
    },

    // Control removes a connected camera by id: the camera's own page gets a `removed` message and
    // redirects back to the role picker (see `hub.ts#removeCamera` and `web/camera/camera.ts`).
    "/api/cameras/:id/remove": {
      POST: requireAuth((req) =>
        ctx.hub.removeCamera(req.params.id)
          ? json({ ok: true })
          : json({ error: "unknown camera" }, 404),
      ),
    },

    "/api/state": {
      GET: requireAuth(() =>
        json({
          cameras: ctx.hub.cameras(),
          clipDurationSeconds: ctx.config.value.clipDurationSeconds,
          audioSourceName: ctx.config.value.audioSourceName,
          jobs: ctx.jobs.jobs(),
          freeDiskGB: ctx.storage.freeDiskGB(),
        }),
      ),
    },

    "/api/clips": {
      GET: requireAuth(() => json(ctx.storage.listClips())),
    },

    // Backlog for the control page's live log viewer (`web/control/control.ts`) — fetched once
    // when the viewer is first opened, then kept current over the WS `log` stream (see hub.ts's
    // TOPIC_CONTROLS and server/index.ts's sink wiring).
    "/api/logs": {
      GET: requireAuth(() => json(ctx.logBuffer.entries())),
    },

    // Validates every field defensively before writing anything to disk; `addUpload` itself is
    // idempotent per camera (see clip-job.ts), so a client-side retry of a request that actually
    // succeeded server-side is safe to resubmit here.
    "/api/clips/:jobId/upload": {
      POST: requireAuth(async (req) => {
        const jobId = req.params.jobId;
        const dir = ctx.jobs.uploadDir(jobId);
        if (!dir) return json({ error: "unknown or finalized job" }, 404);
        const form = await req.formData().catch(() => null);
        if (!form) return json({ error: "malformed form" }, 400);
        const cameraId = String(form.get("cameraId") ?? "");
        const angleName = String(form.get("angleName") ?? "");
        let filesMeta: { startMs: number; mimeType: string }[];
        try {
          filesMeta = JSON.parse(String(form.get("filesMeta")));
        } catch {
          return json({ error: "bad filesMeta" }, 400);
        }
        if (!cameraId || !angleName || !Array.isArray(filesMeta) || filesMeta.length === 0) {
          return json({ error: "missing fields" }, 400);
        }
        if (
          !filesMeta.every(
            (m) => m && typeof m.mimeType === "string" && typeof m.startMs === "number",
          )
        ) {
          return json({ error: "bad filesMeta" }, 400);
        }
        const slug = slugify(angleName);
        const saved: { path: string; startMs: number }[] = [];
        for (let i = 0; i < filesMeta.length; i++) {
          const part = form.get(`file${i}`);
          if (!(part instanceof Blob)) return json({ error: `missing file${i}` }, 400);
          const ext = filesMeta[i]!.mimeType.includes("mp4") ? "mp4" : "webm";
          const filePath = join(dir, "raw", `${slug}-${i}.${ext}`);
          await Bun.write(filePath, part);
          saved.push({ path: filePath, startMs: filesMeta[i]!.startMs });
        }
        const accepted = ctx.jobs.addUpload(jobId, cameraId, {
          name: angleName,
          slug,
          files: saved,
        });
        if (accepted) log.info("upload received", { jobId, angleName, fileCount: saved.length });
        return accepted ? json({ ok: true }) : json({ error: "job already finalized" }, 404);
      }),
    },

    "/api/qr.svg": {
      GET: requireAuth(async (req) => {
        const data = new URL(req.url).searchParams.get("data") ?? "";
        if (!data) return json({ error: "missing data" }, 400);
        const svg = await QRCode.toString(data, { type: "svg", margin: 1, width: 240 });
        return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
      }),
    },

    // Path-traversal guard: `normalize` collapses any `..`/`.` segments in the user-supplied
    // suffix before `resolve` anchors it to an absolute path, so `target` can never be a raw
    // ".."-laden string when it's checked below — checking the prefix on a non-normalized path
    // would be trivially bypassable (e.g. a target that literally starts with the clipsRoot
    // string while ".." segments later escape outside it). The check itself compares against
    // `clipsRoot + "/"`, not just `clipsRoot` — without the trailing slash, a sibling directory
    // that merely shares the string prefix (e.g. "<dataDir>/clips-backup") would wrongly pass.
    // Both failure modes (escaped the root, or simply missing) return the same 404 so the
    // response never leaks which case occurred.
    "/files/*": {
      GET: requireAuth((req) => {
        const path = new URL(req.url).pathname;
        const clipsRoot = resolve(ctx.dataDir, "clips");
        const target = resolve(ctx.dataDir, normalize(path.slice("/files/".length)));
        if (!target.startsWith(`${clipsRoot}/`) || !existsSync(target))
          return json({ error: "not found" }, 404);
        return new Response(Bun.file(target));
      }),
    },
  };

  const notFound = (): Response => json({ error: "not found" }, 404);

  return { routes, fetch: notFound, websocket };
}
