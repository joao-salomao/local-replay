import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import QRCode from "qrcode";
import type { Server, WebSocketHandler } from "bun";
import type { Auth, RateLimiter } from "./auth";
import { tokenFromCookie } from "./auth";
import type { JobManager } from "./clip-job";
import type { ConfigStore } from "./config";
import { Hub, type WSData } from "./hub";
import type { PageAssets, PageName } from "./pages";
import { slugify } from "./pipeline";
import type { Storage } from "./storage";

export type AppContext = {
  dataDir: string;
  config: ConfigStore;
  storage: Storage;
  auth: Auth;
  hub: Hub;
  jobs: JobManager;
  loginLimiter: RateLimiter;
  pages: PageAssets;
};

const CLIP_DURATION_OPTIONS = [10, 20, 30, 45, 60];

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

export function createApp(ctx: AppContext): {
  fetch(req: Request, server: Server<WSData>): Promise<Response | undefined>;
  websocket: WebSocketHandler<WSData>;
} {
  const websocket: WebSocketHandler<WSData> = {
    open: (ws) => ctx.hub.open(ws),
    message: (ws, raw) => ctx.hub.message(ws, raw, Date.now()),
    close: (ws) => ctx.hub.close(ws),
  };

  async function fetchHandler(req: Request, server: Server<WSData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    const authed = ctx.auth.verify(tokenFromCookie(req.headers.get("cookie")), Date.now());

    if (req.method === "GET") {
      if (path === "/") return html(ctx.pages.html("login"));
      if (path === "/camera" || path === "/control" || path === "/clips") {
        if (!authed) return Response.redirect("/", 302);
        return html(ctx.pages.html(path.slice(1) as PageName));
      }
      if (path.startsWith("/assets/")) {
        const file = ctx.pages.assetFile(path.slice("/assets/".length));
        if (!file) return json({ error: "not found" }, 404);
        const type = file.endsWith(".css") ? "text/css" : "application/javascript";
        return new Response(Bun.file(file), { headers: { "content-type": type } });
      }
      if (path === "/cert") {
        const certPath = join(ctx.dataDir, "certs", "cert.pem");
        if (!existsSync(certPath)) return json({ error: "not found" }, 404);
        return new Response(Bun.file(certPath), {
          headers: {
            "content-type": "application/x-x509-ca-cert",
            "content-disposition": 'attachment; filename="replay-local.crt"',
          },
        });
      }
      if (path === "/ws") {
        if (!authed) return json({ error: "unauthorized" }, 401);
        if (server.upgrade(req, { data: {} as WSData })) return undefined;
        return json({ error: "upgrade failed" }, 400);
      }
    }

    if (req.method === "POST" && path === "/api/login") {
      const ip = server.requestIP(req)?.address ?? "unknown";
      if (!ctx.loginLimiter.allow(ip, Date.now())) return json({ error: "muitas tentativas, aguarde" }, 429);
      const body = (await req.json().catch(() => ({}))) as { password?: string };
      const token = ctx.auth.login(body.password ?? "", Date.now());
      if (!token) return json({ error: "senha incorreta" }, 401);
      return json({ ok: true }, 200, { "set-cookie": ctx.auth.cookieFor(token) });
    }

    if (!authed) return json({ error: "unauthorized" }, 401);

    if (req.method === "POST" && path === "/api/record") {
      const result = ctx.jobs.trigger(Date.now());
      if ("error" in result) return json(result, result.error === "cooldown" ? 429 : 409);
      return json(result);
    }

    if (req.method === "POST" && path === "/api/config/clip-duration") {
      const body = (await req.json().catch(() => ({}))) as { seconds?: number };
      if (!CLIP_DURATION_OPTIONS.includes(body.seconds ?? -1)) return json({ error: "invalid seconds" }, 400);
      ctx.config.setClipDuration(body.seconds!);
      ctx.hub.onStateChanged();
      return json({ clipDurationSeconds: ctx.config.value.clipDurationSeconds });
    }

    if (req.method === "GET" && path === "/api/state") {
      return json({
        cameras: ctx.hub.cameras(),
        clipDurationSeconds: ctx.config.value.clipDurationSeconds,
        jobs: ctx.jobs.jobs(),
        freeDiskGB: ctx.storage.freeDiskGB(),
      });
    }

    if (req.method === "GET" && path === "/api/clips") return json(ctx.storage.listClips());

    if (req.method === "GET" && path.startsWith("/files/clips/")) {
      const clipsRoot = resolve(ctx.dataDir, "clips");
      const target = resolve(ctx.dataDir, normalize(path.slice("/files/".length)));
      if (!target.startsWith(clipsRoot + "/") || !existsSync(target)) return json({ error: "not found" }, 404);
      return new Response(Bun.file(target));
    }

    const upload = /^\/api\/clips\/([0-9a-f-]{36})\/upload$/.exec(path);
    if (req.method === "POST" && upload) {
      const jobId = upload[1]!;
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
      const accepted = ctx.jobs.addUpload(jobId, cameraId, { name: angleName, slug, files: saved });
      return accepted ? json({ ok: true }) : json({ error: "job already finalized" }, 404);
    }

    if (req.method === "GET" && path === "/api/qr.svg") {
      const data = url.searchParams.get("data") ?? "";
      if (!data) return json({ error: "missing data" }, 400);
      const svg = await QRCode.toString(data, { type: "svg", margin: 1, width: 240 });
      return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
    }

    return json({ error: "not found" }, 404);
  }

  return { fetch: fetchHandler, websocket };
}

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
