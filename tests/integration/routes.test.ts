import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter } from "../../src/server/auth";
import type { LogBuffer } from "../../src/server/log-buffer";
import type { LogEntry } from "../../src/shared/protocol";
import { createAppForTest } from "./test-app";

let base: string;
let dataDirRef: string;
let stop: () => void;
let app: Awaited<ReturnType<typeof createAppForTest>>;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "replay-routes-"));
  dataDirRef = dataDir;
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ password: "senha-teste" }));
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
    pushed.forEach((e) => (app.ctx.logBuffer as LogBuffer).push(e));

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
    const fakeWs = { data: {} as any, send() {}, subscribe() {} } as any;
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

    app.ctx.hub.close(fakeWs); // return the shared hub to zero cameras for other tests
  });

  it("keys the login rate limiter off X-Forwarded-For when behind a proxy", async () => {
    // dedicated instance: trustProxy on + a tight limiter, so the test is deterministic and
    // isolated from the shared `app` above (which uses a permissive 100/min limiter)
    const dataDir = mkdtempSync(join(tmpdir(), "replay-routes-proxy-"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ password: "senha-teste" }));
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
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ password: "senha-teste" }));
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
});
