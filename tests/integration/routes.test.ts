import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter } from "@server/auth";
import type { WSData } from "@server/hub";
import type { LogBuffer } from "@server/log-buffer";
import type { LogEntry } from "@shared/protocol";
import type { ServerWebSocket } from "bun";
import { createAppForTest } from "./test-app";

let base: string;
let dataDirRef: string;
let stop: () => void;
let app: Awaited<ReturnType<typeof createAppForTest>>;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "replay-routes-"));
  dataDirRef = dataDir;
  app = await createAppForTest(dataDir);
  base = app.base;
  stop = app.stop;
});
afterAll(() => stop());

const login = async (): Promise<string> => {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    body: JSON.stringify({ password: "senha-teste" }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
};

describe("routes", () => {
  it("serves the login page publicly and guards role pages", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    const guarded = await fetch(`${base}/camera`, { redirect: "manual" });
    expect(guarded.status).toBe(302);
    const cookie = await login();
    expect((await fetch(`${base}/camera`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/assets/camera.js`)).status).toBe(200);
  });

  it("serves the control and clips pages once authed (otherwise the e2e-only Playwright specs are the only thing that ever fetches them)", async () => {
    const guardedControl = await fetch(`${base}/control`, { redirect: "manual" });
    expect(guardedControl.status).toBe(302);
    const guardedClips = await fetch(`${base}/clips`, { redirect: "manual" });
    expect(guardedClips.status).toBe(302);
    const cookie = await login();
    expect((await fetch(`${base}/control`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/clips`, { headers: { cookie } })).status).toBe(200);
  });

  it("tolerates a non-JSON login body (falls back to an empty body, fails auth rather than 500ing)", async () => {
    // req.json() rejects on a non-JSON body; the route's `.catch(() => ({}))` fallback is what's
    // under test here — a distinct code path from the "wrong password" 401 below, which sends a
    // perfectly valid JSON body with the wrong value.
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      body: "not json at all",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBeTruthy();
  });

  it("rejects wrong passwords and rate limits logins", async () => {
    expect(
      (
        await fetch(`${base}/api/login`, {
          method: "POST",
          body: JSON.stringify({ password: "nope" }),
        })
      ).status,
    ).toBe(401);
  });

  it("refuses to record without cameras and validates clip duration", async () => {
    const cookie = await login();
    expect(
      (await fetch(`${base}/api/record`, { method: "POST", headers: { cookie } })).status,
    ).toBe(409);
    const bad = await fetch(`${base}/api/config/clip-duration`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ seconds: 25 }),
    });
    expect(bad.status).toBe(400);
    // Non-JSON body: req.json() rejects and the route's `.catch(() => ({}))` fallback kicks in,
    // leaving `seconds` undefined — a distinct path from the "valid JSON, invalid value" case
    // just above.
    const nonJson = await fetch(`${base}/api/config/clip-duration`, {
      method: "POST",
      headers: { cookie },
      body: "not json at all",
    });
    expect(nonJson.status).toBe(400);
    expect((await nonJson.json()).error).toBe("invalid seconds");
    const ok = await fetch(`${base}/api/config/clip-duration`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ seconds: 30 }),
    });
    expect((await ok.json()).clipDurationSeconds).toBe(30);
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    expect(state.clipDurationSeconds).toBe(30);
    expect(state.cameras).toEqual([]);
  });

  it("sets, clears, and validates the combined-audio source camera", async () => {
    const cookie = await login();
    const set = await fetch(`${base}/api/config/audio-source`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "Fundo" }),
    });
    expect((await set.json()).audioSourceName).toBe("Fundo");
    let state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    expect(state.audioSourceName).toBe("Fundo");
    // null clears it back to automatic (first angle)
    const clear = await fetch(`${base}/api/config/audio-source`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: null }),
    });
    expect((await clear.json()).audioSourceName).toBeNull();
    // whitespace-only name is rejected and leaves the value unchanged
    const bad = await fetch(`${base}/api/config/audio-source`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "   " }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid name");
    // Non-JSON body: req.json() rejects and the route's `.catch(() => ({}))` fallback leaves name
    // undefined, treated as null (automatic) — exercises that fallback arrow.
    const nonJson = await fetch(`${base}/api/config/audio-source`, {
      method: "POST",
      headers: { cookie },
      body: "not json at all",
    });
    expect((await nonJson.json()).audioSourceName).toBeNull();
    state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    expect(state.audioSourceName).toBeNull();
  });

  it("blocks path traversal on /files", async () => {
    const cookie = await login();
    expect(
      (await fetch(`${base}/files/clips/../config.json`, { headers: { cookie } })).status,
    ).toBe(404);
    expect((await fetch(`${base}/files/clips/nope/x.mp4`, { headers: { cookie } })).status).toBe(
      404,
    );
  });

  it("requires auth on the api and on /ws", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/clips`)).status).toBe(401);
    expect((await fetch(`${base}/api/logs`)).status).toBe(401);
    expect((await fetch(`${base}/ws`)).status).toBe(401);
  });

  it("returns 400 when an authed /ws request isn't an actual WebSocket upgrade", async () => {
    // A plain fetch() carries none of the Sec-WebSocket-* handshake headers, so server.upgrade()
    // itself fails (returns false) even though auth passes — a distinct failure mode from the
    // 401-without-a-cookie case above.
    const cookie = await login();
    const res = await fetch(`${base}/ws`, { headers: { cookie } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it("returns the buffered log backlog", async () => {
    const cookie = await login();
    const before = (await (
      await fetch(`${base}/api/logs`, { headers: { cookie } })
    ).json()) as LogEntry[];

    const pushed: LogEntry[] = [
      { seq: 900_001, ts: new Date().toISOString(), level: "info", scope: "test", message: "a" },
      {
        seq: 900_002,
        ts: new Date().toISOString(),
        level: "warn",
        scope: "test",
        message: "b",
        fields: { cam: "Fundo" },
      },
    ];
    // AppContext narrows logBuffer to just `{ entries() }` (all routes.ts itself ever needs) — the
    // test reaches for the concrete `LogBuffer.push` to seed the backlog directly and
    // deterministically, without going through the logger/sink machinery.
    pushed.forEach((e) => {
      (app.ctx.logBuffer as LogBuffer).push(e);
    });

    const res = await fetch(`${base}/api/logs`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const after = (await res.json()) as LogEntry[];
    expect(after).toEqual([...before, ...pushed]);
  });

  it("serves a qr svg", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/qr.svg?data=https://example.local`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("svg");
    expect(await res.text()).toContain("<svg");
  });

  it("serves the certificate publicly for manual install (iOS)", async () => {
    mkdirSync(join(dataDirRef, "certs"), { recursive: true });
    writeFileSync(join(dataDirRef, "certs", "cert.pem"), "FAKE PEM");
    const res = await fetch(`${base}/cert`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("local-replay.crt");
    expect(await res.text()).toBe("FAKE PEM");
  });

  it("rejects malformed filesMeta items with 400, not 500", async () => {
    const cookie = await login();
    // put one camera online via the hub, then trigger a real capturing job
    const fakeWs = {
      data: {} as WSData,
      send() {},
      subscribe() {},
    } as unknown as ServerWebSocket<WSData>;
    app.ctx.hub.open(fakeWs);
    app.ctx.hub.message(
      fakeWs,
      JSON.stringify({ type: "register", role: "camera", name: "T" }),
      Date.now(),
    );
    const trig = app.ctx.jobs.trigger(Date.now()) as { jobId: string };
    expect(trig.jobId).toBeTruthy();

    const form = new FormData();
    form.append("cameraId", "cam-x");
    form.append("angleName", "Fundo");
    form.append("filesMeta", JSON.stringify([{ startMs: 1 }])); // missing mimeType
    form.append("file0", new Blob(["x"]), "part0");
    const res = await fetch(`${base}/api/clips/${trig.jobId}/upload`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();

    // filesMeta isn't valid JSON at all: hits the JSON.parse catch (a different 400 than the
    // "every" field-shape check exercised just above, which only runs once parsing succeeds).
    const badJsonForm = new FormData();
    badJsonForm.append("cameraId", "cam-x");
    badJsonForm.append("angleName", "Fundo");
    badJsonForm.append("filesMeta", "{not valid json");
    badJsonForm.append("file0", new Blob(["x"]), "part0");
    const badJsonRes = await fetch(`${base}/api/clips/${trig.jobId}/upload`, {
      method: "POST",
      headers: { cookie },
      body: badJsonForm,
    });
    expect(badJsonRes.status).toBe(400);
    expect((await badJsonRes.json()).error).toBe("bad filesMeta");

    // filesMeta parses fine but is an empty array: hits the "missing fields" check specifically
    // (distinct from both the parse catch above and the "every" shape check, which only runs on
    // a non-empty array).
    const emptyForm = new FormData();
    emptyForm.append("cameraId", "cam-x");
    emptyForm.append("angleName", "Fundo");
    emptyForm.append("filesMeta", JSON.stringify([]));
    const emptyRes = await fetch(`${base}/api/clips/${trig.jobId}/upload`, {
      method: "POST",
      headers: { cookie },
      body: emptyForm,
    });
    expect(emptyRes.status).toBe(400);
    expect((await emptyRes.json()).error).toBe("missing fields");

    // A body that isn't multipart/form-data at all makes req.formData() itself reject, hitting
    // the route's `.catch(() => null)` fallback — a distinct 400 from every filesMeta-shaped
    // check above, which all assume formData() already parsed successfully.
    const malformedFormRes = await fetch(`${base}/api/clips/${trig.jobId}/upload`, {
      method: "POST",
      headers: { cookie, "content-type": "text/plain" },
      body: "not a multipart form body",
    });
    expect(malformedFormRes.status).toBe(400);
    expect((await malformedFormRes.json()).error).toBe("malformed form");

    app.ctx.hub.close(fakeWs); // return the shared hub to zero cameras for other tests
  });

  it("removes a connected camera by id and 404s an unknown one", async () => {
    const cookie = await login();
    const fakeWs = {
      data: {} as WSData,
      send() {},
      subscribe() {},
      close() {},
    } as unknown as ServerWebSocket<WSData>;
    app.ctx.hub.open(fakeWs);
    app.ctx.hub.message(
      fakeWs,
      JSON.stringify({ type: "register", role: "camera", name: "Kickable" }),
      Date.now(),
    );
    const id = app.ctx.hub.cameras().find((c) => c.name === "Kickable")!.id;

    const unknown = await fetch(`${base}/api/cameras/does-not-exist/remove`, {
      method: "POST",
      headers: { cookie },
    });
    expect(unknown.status).toBe(404);

    const ok = await fetch(`${base}/api/cameras/${id}/remove`, {
      method: "POST",
      headers: { cookie },
    });
    expect(ok.status).toBe(200);
    expect(app.ctx.hub.cameras().some((c) => c.id === id)).toBe(false); // gone from the registry
  });

  it("keys the login rate limiter off X-Forwarded-For when behind a proxy", async () => {
    // dedicated instance: trustProxy on + a tight limiter, so the test is deterministic and
    // isolated from the shared `app` above (which uses a permissive 100/min limiter)
    const dataDir = mkdtempSync(join(tmpdir(), "replay-routes-proxy-"));
    const proxyApp = await createAppForTest(
      dataDir,
      {},
      { trustProxy: true, loginLimiter: new RateLimiter(5, 60_000) },
    );
    try {
      const attempt = (forwardedFor: string) =>
        fetch(`${proxyApp.base}/api/login`, {
          method: "POST",
          headers: { "x-forwarded-for": forwardedFor },
          body: JSON.stringify({ password: "nope" }),
        });

      // 5 wrong-password attempts from the same forwarded IP are each let through the limiter
      for (let i = 0; i < 5; i++) {
        expect((await attempt("9.9.9.9")).status).toBe(401);
      }
      // the 6th attempt from that same forwarded IP is rate limited
      expect((await attempt("9.9.9.9")).status).toBe(429);

      // a different forwarded IP has its own bucket — proves the limiter keys off
      // X-Forwarded-For, not the shared loopback socket every request in this test arrives on
      expect((await attempt("1.2.3.4")).status).toBe(401);
    } finally {
      proxyApp.stop();
    }
  });

  it("ignores X-Forwarded-For and rate limits by socket when not behind a proxy", async () => {
    // mirrors the proxy test above but with the default trustProxy=false: a spoofed XFF must be
    // IGNORED and the limiter must key off the shared socket instead
    const dataDir = mkdtempSync(join(tmpdir(), "replay-routes-noproxy-"));
    const noProxyApp = await createAppForTest(
      dataDir,
      {},
      { trustProxy: false, loginLimiter: new RateLimiter(5, 60_000) },
    );
    try {
      const attempt = (forwardedFor: string) =>
        fetch(`${noProxyApp.base}/api/login`, {
          method: "POST",
          headers: { "x-forwarded-for": forwardedFor },
          body: JSON.stringify({ password: "nope" }),
        });

      // 5 wrong-password attempts, each carrying a DIFFERENT spoofed X-Forwarded-For, all over
      // the same loopback socket, are each let through the limiter
      const forgedIps = ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"];
      for (const forged of forgedIps) {
        expect((await attempt(forged)).status).toBe(401);
      }
      // the 6th attempt, with yet another distinct forged IP, is still rate limited — proving
      // the different forged XFF values did NOT create fresh buckets (socket-keyed, XFF ignored)
      expect((await attempt("6.6.6.6")).status).toBe(429);
    } finally {
      noProxyApp.stop();
    }
  });

  it("falls back to a 404 for a route matching nothing in the route table", async () => {
    const res = await fetch(`${base}/this-route-does-not-exist-anywhere`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });

  it("closing a real websocket connection is observed server-side (the camera drops out of the registry)", async () => {
    // Unlike hub.test.ts's fake ws (which calls Hub.close() directly), this goes through a real
    // WebSocket + the actual Bun.serve `websocket.close` adapter in routes.ts, proving that wiring
    // fires for real: the only thing that removes a camera from the registry is Hub.close(), so
    // observing the removal proves the server-side close handler actually ran.
    const cookie = await login();
    const ws = new WebSocket(app.ws, { headers: { cookie } } as unknown as string[]);
    const cameraId = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "register", role: "camera", name: "WsCloseTest" }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "registered") resolve(msg.cameraId);
      };
      ws.onerror = () => reject(new Error("ws error"));
    });
    expect(app.ctx.hub.cameras().some((c) => c.id === cameraId)).toBe(true);

    ws.close();
    const deadline = Date.now() + 5000;
    while (app.ctx.hub.cameras().some((c) => c.id === cameraId)) {
      if (Date.now() > deadline) throw new Error("camera was not removed after ws close");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(app.ctx.hub.cameras().some((c) => c.id === cameraId)).toBe(false);
  });
});
