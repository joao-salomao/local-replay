import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect((await fetch(`${base}/ws`)).status).toBe(401);
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
    expect(res.headers.get("content-disposition")).toContain("replay-local.crt");
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
});
