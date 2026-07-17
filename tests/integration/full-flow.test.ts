import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe, runFfmpeg } from "../../src/server/ffmpeg";
import type { ClipMeta } from "../../src/server/storage";
import { CameraSimulator } from "../helpers/camera-simulator";
import { createAppForTest } from "./test-app";

setDefaultTimeout(240_000);

let app: Awaited<ReturnType<typeof createAppForTest>>;
let cookie: string;
let raw: string;
const sims: CameraSimulator[] = [];

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "replay-flow-"));
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({ password: "senha", clipDurationSeconds: 10 }),
  );
  app = await createAppForTest(dataDir, { cooldownMs: 0 });
  raw = join(mkdtempSync(join(tmpdir(), "replay-flow-raw-")), "raw.mp4");
  await runFfmpeg([
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30:duration=12",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    raw,
  ]);
  const res = await fetch(`${app.base}/api/login`, {
    method: "POST",
    body: JSON.stringify({ password: "senha" }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(() => {
  sims.forEach((s) => s.close());
  app.stop();
});

describe("full flow", () => {
  it("two simulated cameras + trigger produce a ready combined clip", async () => {
    for (const name of ["Fundo", "Lateral"]) {
      const sim = new CameraSimulator({
        httpBase: app.base,
        wsUrl: app.ws,
        cookie,
        name,
        rawFile: raw,
        rawDurationMs: 12_000,
      });
      await sim.connect();
      sims.push(sim);
    }
    await new Promise((r) => setTimeout(r, 300)); // registration settles
    expect(app.ctx.hub.onlineCameraIds().length).toBe(2);

    const trigger = await fetch(`${app.base}/api/record`, { method: "POST", headers: { cookie } });
    expect(trigger.status).toBe(200);

    const deadline = Date.now() + 200_000;
    let clips: (ClipMeta & { dir: string })[] = [];
    while (Date.now() < deadline) {
      clips = (await (
        await fetch(`${app.base}/api/clips`, { headers: { cookie } })
      ).json()) as (ClipMeta & { dir: string })[];
      if (clips.length > 0 && clips[0]!.state !== "processing") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(clips[0]!.state).toBe("ready");
    expect(clips[0]!.cameras.length).toBe(2);
    expect(clips[0]!.outputs.combined).toBe("combined.mp4");
    expect(sims.every((s) => s.uploads === 1)).toBe(true);

    const filePath = join(app.ctx.dataDir, clips[0]!.dir, "combined.mp4");
    const info = await probe(filePath);
    expect(info.width).toBe(1920);
    expect(info.durationSec).toBeGreaterThan(17); // 2 angles × ~10s sequential
    expect(info.durationSec).toBeLessThan(22);

    const served = await fetch(`${app.base}/files/${clips[0]!.dir}/combined.mp4`, {
      headers: { cookie },
    });
    expect(served.status).toBe(200);
  });
});
