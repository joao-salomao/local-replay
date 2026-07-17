import { beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../../src/server/config";
import { probe, runFfmpeg } from "../../src/server/ffmpeg";
import { processClip } from "../../src/server/pipeline";

setDefaultTimeout(180_000);

const config: Config = { password: "x", ...DEFAULT_CONFIG };
let rawA0: string, rawA1: string, rawB0: string;

async function synth(path: string, seconds: number): Promise<void> {
  await runFfmpeg([
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `testsrc=size=1280x720:rate=30:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path,
  ]);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-raw-"));
  rawA0 = join(dir, "a0.mp4");
  rawA1 = join(dir, "a1.mp4");
  rawB0 = join(dir, "b0.mp4");
  await Promise.all([synth(rawA0, 8), synth(rawA1, 8), synth(rawB0, 12)]);
});

describe("processClip", () => {
  it("cuts across a cycle boundary, normalizes, and builds a sequential combined clip", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const t = 100_000;
    const result = await processClip({
      clipDir, t, windowSec: 10, config,
      angles: [
        // angle A: two 8s files with a 200ms gap; window [90s,100s] spans both
        { name: "Fundo", slug: "fundo", files: [{ path: rawA0, startMs: 84_000 }, { path: rawA1, startMs: 92_200 }] },
        // angle B: one 12s file covering the window
        { name: "Lateral rede", slug: "lateral-rede", files: [{ path: rawB0, startMs: 89_000 }] },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.outputs.angles).sort()).toEqual(["fundo", "lateral-rede"]);
    expect(result.outputs.combined).toBe("combined.mp4");

    const fundo = await probe(join(clipDir, "angle-fundo.mp4"));
    expect(fundo.width).toBe(1920);
    expect(fundo.height).toBe(1080);
    expect(Math.round(fundo.fps)).toBe(60);
    expect(fundo.hasAudio).toBe(true); // silent track injected
    expect(fundo.durationSec).toBeGreaterThan(9);
    expect(fundo.durationSec).toBeLessThan(10.5);

    const combined = await probe(join(clipDir, "combined.mp4"));
    expect(combined.durationSec).toBeGreaterThan(18.5);
    expect(combined.durationSec).toBeLessThan(21);
  }, 180_000);

  it("side-by-side layout stacks the first two angles", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const result = await processClip({
      clipDir, t: 100_000, windowSec: 5, config: { ...config, layout: "side-by-side" },
      angles: [
        { name: "A", slug: "a", files: [{ path: rawB0, startMs: 90_000 }] },
        { name: "B", slug: "b", files: [{ path: rawB0, startMs: 90_000 }] },
      ],
    });
    expect(result.outputs.combined).toBe("combined.mp4");
    const combined = await probe(join(clipDir, "combined.mp4"));
    expect(combined.width).toBe(1920);
    expect(combined.durationSec).toBeLessThan(6.5);
  }, 180_000);

  it("keeps valid angles when one angle's file is corrupt", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const bad = join(clipDir, "raw", "bad.mp4");
    await Bun.write(bad, "not a video");
    const result = await processClip({
      clipDir, t: 100_000, windowSec: 5, config,
      angles: [
        { name: "Ok", slug: "ok", files: [{ path: rawB0, startMs: 90_000 }] },
        { name: "Bad", slug: "bad", files: [{ path: bad, startMs: 90_000 }] },
      ],
    });
    expect(Object.keys(result.outputs.angles)).toEqual(["ok"]);
    expect(result.errors.length).toBe(1);
    expect(result.outputs.combined).toBe("combined.mp4"); // single valid angle copied
  }, 180_000);
});
