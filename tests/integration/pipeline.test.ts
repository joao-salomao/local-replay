import { beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../../src/server/config";
import { probe, runFfmpeg } from "../../src/server/ffmpeg";
import { processClip } from "../../src/server/pipeline";

setDefaultTimeout(180_000);

const config: Config = { password: "x", ...DEFAULT_CONFIG };
let rawA0: string, rawA1: string, rawB0: string, rawAudioOnly: string;

async function synth(path: string, seconds: number): Promise<void> {
  await runFfmpeg([
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=1280x720:rate=30:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
}

/** Simulates the production failure: an iOS phone camera locked mid-recording suspends the video
 * track while the mic keeps going, so the uploaded segment is an audio-only mp4 (no video stream
 * at all). */
async function synthAudioOnly(path: string, seconds: number): Promise<void> {
  await runFfmpeg([
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    String(seconds),
    "-c:a",
    "aac",
    path,
  ]);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-raw-"));
  rawA0 = join(dir, "a0.mp4");
  rawA1 = join(dir, "a1.mp4");
  rawB0 = join(dir, "b0.mp4");
  rawAudioOnly = join(dir, "audio-only.mp4");
  await Promise.all([
    synth(rawA0, 8),
    synth(rawA1, 8),
    synth(rawB0, 12),
    synthAudioOnly(rawAudioOnly, 12),
  ]);
});

describe("probe", () => {
  it("reports hasVideo accurately for audio-only vs. real video files", async () => {
    expect((await probe(rawAudioOnly)).hasVideo).toBe(false);
    expect((await probe(rawB0)).hasVideo).toBe(true);
  });
});

describe("processClip", () => {
  it("cuts across a cycle boundary, normalizes, and builds a sequential combined clip", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const t = 100_000;
    const result = await processClip({
      clipDir,
      t,
      windowSec: 10,
      config,
      angles: [
        // angle A: two 8s files with a 200ms gap; window [90s,100s] spans both
        {
          name: "Fundo",
          slug: "fundo",
          files: [
            { path: rawA0, startMs: 84_000 },
            { path: rawA1, startMs: 92_200 },
          ],
        },
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

  it("processes an angle whose raw files are cwd-relative paths (matches a relative DATA_DIR in prod)", async () => {
    // Reproduces the prod failure: with DATA_DIR="data" the raw file paths are relative to cwd,
    // and ffmpeg's concat demuxer resolves list entries relative to the LIST FILE's dir — doubling
    // the path — unless writeConcatList emits absolute paths. mkdtemp (absolute) hid this in CI.
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-rel-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const result = await processClip({
      clipDir,
      t: 100_000,
      windowSec: 10,
      config,
      angles: [
        {
          name: "Rel",
          slug: "rel",
          files: [
            { path: relative(process.cwd(), rawA0), startMs: 84_000 },
            { path: relative(process.cwd(), rawA1), startMs: 92_200 },
          ],
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.outputs.angles.rel).toBe("angle-rel.mp4");
    expect(existsSync(join(clipDir, "angle-rel.mp4"))).toBe(true);
  }, 180_000);

  it("combines two angles sequentially when clipDir itself is cwd-relative (matches DATA_DIR in prod)", async () => {
    // Reproduces the prod failure for concat call site #2 (the combined-list.txt sequential
    // combine): anglePaths (= join(clipDir, angle-*.mp4)) are relative whenever clipDir itself is
    // relative — as it is in prod, where DATA_DIR defaults to "data" — and those relative entries
    // flow straight into the combined-list.txt. ffmpeg's concat demuxer resolves relative list
    // entries against the LIST FILE's dir, not cwd, so without writeConcatList's resolve() this
    // combine would fail to open the angle files. mkdtemp's absolute clipDir hid this in every
    // other test here, since the previous relative-path test only relativizes the raw file paths
    // (covering call site #1), not clipDir itself.
    const absClipDir = mkdtempSync(join(tmpdir(), "replay-clip-relcombine-"));
    mkdirSync(join(absClipDir, "raw"), { recursive: true });
    const clipDir = relative(process.cwd(), absClipDir);
    try {
      const result = await processClip({
        clipDir,
        t: 100_000,
        windowSec: 5,
        config,
        angles: [
          { name: "A", slug: "a", files: [{ path: rawB0, startMs: 90_000 }] },
          { name: "B", slug: "b", files: [{ path: rawB0, startMs: 90_000 }] },
        ],
      });
      expect(result.errors).toEqual([]);
      expect(result.outputs.combined).toBe("combined.mp4");
      expect(existsSync(join(clipDir, "combined.mp4"))).toBe(true);

      const single = await probe(join(clipDir, "angle-a.mp4"));
      const combined = await probe(join(clipDir, "combined.mp4"));
      // sequential combine of 2 angles: ~2x a single angle's duration, proving ffmpeg actually
      // read both angle files via the now-absolute combined-list.txt rather than failing (or
      // silently producing a truncated clip) on unresolved relative entries.
      expect(combined.durationSec).toBeGreaterThan(single.durationSec * 1.7);
      expect(combined.durationSec).toBeLessThan(single.durationSec * 2.3);
    } finally {
      rmSync(absClipDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("side-by-side layout stacks the first two angles", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const result = await processClip({
      clipDir,
      t: 100_000,
      windowSec: 5,
      config: { ...config, layout: "side-by-side" },
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
      clipDir,
      t: 100_000,
      windowSec: 5,
      config,
      angles: [
        { name: "Ok", slug: "ok", files: [{ path: rawB0, startMs: 90_000 }] },
        { name: "Bad", slug: "bad", files: [{ path: bad, startMs: 90_000 }] },
      ],
    });
    expect(Object.keys(result.outputs.angles)).toEqual(["ok"]);
    expect(result.errors.length).toBe(1);
    expect(result.outputs.combined).toBe("combined.mp4"); // single valid angle copied
  }, 180_000);

  it("locked camera angle is skipped, clip still produced from the other angle", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const result = await processClip({
      clipDir,
      t: 100_000,
      windowSec: 5,
      config,
      angles: [
        // locked phone: mic kept recording but iOS suspended the video track
        { name: "iPhone", slug: "iphone", files: [{ path: rawAudioOnly, startMs: 90_000 }] },
        { name: "Fundo", slug: "fundo", files: [{ path: rawB0, startMs: 90_000 }] },
      ],
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("iphone");
    expect(result.errors[0]).toContain("no video stream");
    expect(Object.keys(result.outputs.angles)).toEqual(["fundo"]);
    expect(result.outputs.combined).toBe("combined.mp4"); // produced from the one good angle
    expect(existsSync(join(clipDir, "combined.mp4"))).toBe(true);

    const combined = await probe(join(clipDir, "combined.mp4"));
    expect(combined.hasVideo).toBe(true);
  }, 180_000);

  it("all cameras locked → job error, readable message, no combined", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const result = await processClip({
      clipDir,
      t: 100_000,
      windowSec: 5,
      config,
      angles: [
        { name: "iPhone", slug: "iphone", files: [{ path: rawAudioOnly, startMs: 90_000 }] },
      ],
    });
    expect(result.outputs.combined).toBeNull();
    expect(Object.keys(result.outputs.angles).length).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("no video stream"); // readable, not an ffmpeg dump
  }, 180_000);

  it("two angles with the same name both survive in the combined clip", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const result = await processClip({
      clipDir,
      t: 100_000,
      windowSec: 5,
      config,
      angles: [
        // two cameras both named "Fundo" collide on slug "fundo" before uniquification
        { name: "Fundo", slug: "fundo", files: [{ path: rawB0, startMs: 90_000 }] },
        { name: "Fundo", slug: "fundo", files: [{ path: rawB0, startMs: 90_000 }] },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.outputs.angles).sort()).toEqual(["fundo", "fundo-2"]);
    expect(existsSync(join(clipDir, "angle-fundo.mp4"))).toBe(true);
    expect(existsSync(join(clipDir, "angle-fundo-2.mp4"))).toBe(true);

    const single = await probe(join(clipDir, "angle-fundo.mp4"));
    const combined = await probe(join(clipDir, "combined.mp4"));
    // combined concatenates both angles sequentially: ~2x a single angle's duration,
    // proving both survived rather than the 2nd overwriting the 1st.
    expect(combined.durationSec).toBeGreaterThan(single.durationSec * 1.7);
    expect(combined.durationSec).toBeLessThan(single.durationSec * 2.3);
  }, 180_000);
});
