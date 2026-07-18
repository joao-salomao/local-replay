import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import QRCode from "qrcode";
import type { BunRequest, Server, WebSocketHandler } from "bun";
import type { Auth, RateLimiter } from "./auth";
import { tokenFromCookie } from "./auth";
import type { JobManager } from "./clip-job";
import type { ConfigStore } from "./config";
import { Hub, type WSData } from "./hub";
import { logger } from "./log";
import type { PageAssets, PageName } from "./pages";
import { slugify } from "./pipeline";
import type { Storage } from "./storage";

const log = logger("http");

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
};

const CLIP_DURATION_OPTIONS = [10, 20, 30, 45, 60];

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

export function createApp(ctx: AppContext) {
  const websocket: WebSocketHandler<WSData> = {
    open: (ws) => ctx.hub.open(ws),
    message: (ws, raw) => ctx.hub.message(ws, raw, Date.now()),
    close: (ws) => ctx.hub.close(ws),
  };

  const isAuthed = (req: Request) =>
    ctx.auth.verify(tokenFromCookie(req.headers.get("cookie")), Date.now());
  const requireAuth =
    (
      handler: (
        req: any,
        server: Server<WSData>,
      ) => Response | undefined | Promise<Response | undefined>,
    ) =>
    (req: any, server: Server<WSData>) =>
      isAuthed(req) ? handler(req, server) : json({ error: "unauthorized" }, 401);
  const requireAuthPage =
    (handler: (req: any, server: Server<WSData>) => Response | Promise<Response>) =>
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

    "/cert": {
      GET: () => {
        const certPath = join(ctx.dataDir, "certs", "cert.pem");
        if (!existsSync(certPath)) return json({ error: "not found" }, 404);
        return new Response(Bun.file(certPath), {
          headers: {
            "content-type": "application/x-x509-ca-cert",
            "content-disposition": 'attachment; filename="replay-local.crt"',
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
        // last hop = the fronting proxy's observed peer IP; earlier entries are client-forgeable
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
          log.info("record triggered");
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
        ctx.hub.onStateChanged();
        log.info("clip duration changed", { seconds: ctx.config.value.clipDurationSeconds });
        return json({ clipDurationSeconds: ctx.config.value.clipDurationSeconds });
      }),
    },

    "/api/state": {
      GET: requireAuth(() =>
        json({
          cameras: ctx.hub.cameras(),
          clipDurationSeconds: ctx.config.value.clipDurationSeconds,
          jobs: ctx.jobs.jobs(),
          freeDiskGB: ctx.storage.freeDiskGB(),
        }),
      ),
    },

    "/api/clips": {
      GET: requireAuth(() => json(ctx.storage.listClips())),
    },

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
