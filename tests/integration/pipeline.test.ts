import { beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type Config, DEFAULT_CONFIG } from "@server/config";
import { probe, runFfmpeg } from "@server/ffmpeg";
import { processClip } from "@server/pipeline";

setDefaultTimeout(180_000);

const config: Config = { password: "x", ...DEFAULT_CONFIG };
let rawA0: string, rawA1: string, rawB0: string, rawAudioOnly: string, rawGappedCorrupt: string;

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

/**
 * Simulates the video-duration-bloat production failure: an iOS MediaRecorder buffer whose video
 * track has a large internal timestamp gap (dense real frames, then an abrupt jump forward, then a
 * sparse tail) AND a corrupted fragment sample table (a `moof`/`trun` box that declares more
 * samples than are actually backed by real entries — plausible from a client-side fragmented-mp4
 * writer that got interrupted mid-flush). Confirmed against the pre-fix `normalizeCutArgs` (via a
 * temporary local revert while building this fixture): `probe()` reported `durationSec: 10`
 * (matching the requested window — looks fine at a glance) while only ~60 packets (~1s) of the
 * video track were actually real/decodable — the exact "declared duration far exceeds decodable
 * content" pathology from the bug report, just at a smaller absolute scale than production's
 * 62.3s-claimed/~10s-real clip. The dense zone is written at 60fps with `keyint=60` so the first
 * fragment (60 samples) is the one whose `trun` gets corrupted.
 */
async function synthGappedCorrupt(path: string): Promise<void> {
  const expr = "if(lt(N\\,480)\\,N/60\\,33.5+(N-480)/5)/TB";
  await runFfmpeg([
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=60:duration=12.5334",
    "-vf",
    `setpts=${expr}`,
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-x264-params",
    "keyint=60:bframes=3:b-adapt=0",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    path,
  ]);

  // Binary-patch the first fragment's moof/traf/trun sample_count field: inflate it by 20 without
  // touching its (size, composition_offset) entries array, so the demuxer reads 20 "phantom"
  // samples out of whatever bytes happen to follow (the mdat header/payload).
  const data = Buffer.from(readFileSync(path));
  let trunSampleCountOffset = -1;
  let off = 0;
  while (off < data.length - 8) {
    const size = data.readUInt32BE(off);
    const boxType = data.toString("latin1", off + 4, off + 8);
    if (size === 0 || boxType === "mdat") break;
    if (boxType === "moof") {
      let inner = off + 8;
      const moofEnd = off + size;
      while (inner < moofEnd) {
        const innerSize = data.readUInt32BE(inner);
        const innerType = data.toString("latin1", inner + 4, inner + 8);
        if (innerType === "traf") {
          let trafInner = inner + 8;
          const trafEnd = inner + innerSize;
          while (trafInner < trafEnd) {
            const tSize = data.readUInt32BE(trafInner);
            const tType = data.toString("latin1", trafInner + 4, trafInner + 8);
            if (tType === "trun") trunSampleCountOffset = trafInner + 8 + 4;
            trafInner += tSize;
          }
        }
        inner += innerSize;
      }
      break; // only the first fragment needs corrupting
    }
    off += size;
  }
  if (trunSampleCountOffset < 0) throw new Error("synthGappedCorrupt: trun box not found");
  data.writeUInt32BE(data.readUInt32BE(trunSampleCountOffset) + 20, trunSampleCountOffset);
  writeFileSync(path, data);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-raw-"));
  rawA0 = join(dir, "a0.mp4");
  rawA1 = join(dir, "a1.mp4");
  rawB0 = join(dir, "b0.mp4");
  rawAudioOnly = join(dir, "audio-only.mp4");
  rawGappedCorrupt = join(dir, "gapped-corrupt.mp4");
  await Promise.all([
    synth(rawA0, 8),
    synth(rawA1, 8),
    synth(rawB0, 12),
    synthAudioOnly(rawAudioOnly, 12),
    synthGappedCorrupt(rawGappedCorrupt),
  ]);
});

describe("probe", () => {
  it("reports hasVideo accurately for audio-only vs. real video files", async () => {
    expect((await probe(rawAudioOnly)).hasVideo).toBe(false);
    expect((await probe(rawB0)).hasVideo).toBe(true);
  });
});

describe("processClip", () => {
  it("cuts across a cycle boundary, normalizes, and builds both a sequential and a side-by-side combined clip", async () => {
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

    // Side-by-side (hstack) combine is produced ADDITIONALLY whenever ≥2 angles succeed.
    expect(result.outputs.combinedSideBySide).toBe("combined-side-by-side.mp4");
    expect(existsSync(join(clipDir, "combined-side-by-side.mp4"))).toBe(true);
    const sideBySide = await probe(join(clipDir, "combined-side-by-side.mp4"));
    expect(sideBySide.width).toBe(1920); // round(targetHeight(1080) * 16/9), same as combined
    // Simultaneous, not summed: ~1x a single angle's duration (same bounds as `fundo` above),
    // in contrast to the sequential `combined.mp4`'s ~2x duration asserted just above.
    expect(sideBySide.durationSec).toBeGreaterThan(9);
    expect(sideBySide.durationSec).toBeLessThan(10.5);
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

  it("config.layout no longer selects which combined outputs are produced (both always produced for ≥2 angles)", async () => {
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
    expect(result.errors).toEqual([]);
    // combined.mp4 is always the SEQUENTIAL concat now, regardless of config.layout's value.
    expect(result.outputs.combined).toBe("combined.mp4");
    expect(result.outputs.combinedSideBySide).toBe("combined-side-by-side.mp4");

    const single = await probe(join(clipDir, "angle-a.mp4"));
    const combined = await probe(join(clipDir, "combined.mp4"));
    const sideBySide = await probe(join(clipDir, "combined-side-by-side.mp4"));
    expect(combined.width).toBe(1920);
    expect(combined.durationSec).toBeGreaterThan(single.durationSec * 1.7); // sequential: ~2x
    expect(sideBySide.width).toBe(1920);
    expect(sideBySide.durationSec).toBeLessThan(single.durationSec * 1.3); // simultaneous: ~1x
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
    expect(result.outputs.combinedSideBySide).toBeNull(); // only 1 angle: no side-by-side
  }, 180_000);

  it("side-by-side combine failure is resilient: the sequential combine and both angles still succeed (regression)", async () => {
    // Uses the ProcessClipDeps injection seam to make ONLY the side-by-side combine step fail,
    // while everything upstream of it (probing, normalizing both angles, the sequential combine)
    // runs for real. This is the regression test for the best-effort try/catch around the
    // side-by-side combine in processClip: its failure must be recorded in `errors` without
    // taking down the angles or the sequential `combined.mp4` that already succeeded.
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const result = await processClip(
      {
        clipDir,
        t: 100_000,
        windowSec: 5,
        config,
        angles: [
          { name: "A", slug: "a", files: [{ path: rawB0, startMs: 90_000 }] },
          { name: "B", slug: "b", files: [{ path: rawB0, startMs: 90_000 }] },
        ],
      },
      {
        combineSideBySideFn: async () => {
          throw new Error("simulated side-by-side ffmpeg failure");
        },
      },
    );
    expect(Object.keys(result.outputs.angles).sort()).toEqual(["a", "b"]);
    expect(result.outputs.combined).toBe("combined.mp4"); // sequential combine: unaffected
    expect(existsSync(join(clipDir, "combined.mp4"))).toBe(true);
    expect(result.outputs.combinedSideBySide).toBeNull(); // side-by-side: failed, stays null
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("side-by-side combine");
    expect(result.errors[0]).toContain("simulated side-by-side ffmpeg failure");
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

  it("an angle whose buffer mixes an audio-only segment and a video segment keeps the video segment (no ffmpeg crash)", async () => {
    // The camera buffers the previous + current recording cycle (see camera.ts#startCycle). If
    // the phone was locked for part of that window, one buffered file is audio-only (locked) and
    // the other has video (unlocked) — unlike the fully-locked tests above, this angle has SOME
    // video and must not be dropped wholesale. Audio-only FIRST is the order that breaks the
    // ffmpeg concat demuxer, which exposes only the first input's streams: OR-accumulating
    // `hasVideo` across files lets this angle through to ffmpeg, which then fails `-map 0:v:0`
    // against a concat stream layout with no video at all.
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const result = await processClip({
      clipDir,
      t: 100_000,
      windowSec: 10,
      config,
      angles: [
        {
          name: "iPhone",
          slug: "iphone",
          files: [
            { path: rawAudioOnly, startMs: 84_000 }, // locked: audio-only, first in the list
            { path: rawA1, startMs: 92_200 }, // unlocked: has video
          ],
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.outputs.angles)).toEqual(["iphone"]);
    expect(result.outputs.combined).toBe("combined.mp4");
    expect(existsSync(join(clipDir, "combined.mp4"))).toBe(true);

    const angle = await probe(join(clipDir, "angle-iphone.mp4"));
    expect(angle.hasVideo).toBe(true);
    // window is [90s,100s]; only the video segment (starts 92.2s) is kept, so the cut is a
    // shorter ~7.8s rather than the full 10s — plausible and non-zero, not the full window.
    expect(angle.durationSec).toBeGreaterThan(7);
    expect(angle.durationSec).toBeLessThan(8.5);
  }, 180_000);

  it("an angle whose buffer mixes a video segment then an audio-only segment keeps the video segment (no ffmpeg crash)", async () => {
    // Reverse order from the test above: video first, audio-only (locked) last. The concat
    // demuxer's first-file-streams behavior means this breaks a DIFFERENT map (`-map 0:a:0`,
    // since OR'd hasAudio is true from the audio-only file but the concat layout — taken from the
    // video-only first file — has no audio stream at all).
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const result = await processClip({
      clipDir,
      t: 100_000,
      windowSec: 10,
      config,
      angles: [
        {
          name: "iPhone",
          slug: "iphone",
          files: [
            { path: rawB0, startMs: 84_000 }, // unlocked: has video
            { path: rawAudioOnly, startMs: 96_000 }, // locked: audio-only, last in the list
          ],
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.outputs.angles)).toEqual(["iphone"]);
    expect(result.outputs.combined).toBe("combined.mp4");
    expect(existsSync(join(clipDir, "combined.mp4"))).toBe(true);

    const angle = await probe(join(clipDir, "angle-iphone.mp4"));
    expect(angle.hasVideo).toBe(true);
    // window is [90s,100s]; only the video segment (84s-96s) is kept, so the cut is [90s,96s) → 6s.
    expect(angle.durationSec).toBeGreaterThan(5.5);
    expect(angle.durationSec).toBeLessThan(6.5);
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
    expect(result.outputs.combinedSideBySide).toBeNull(); // 0 angles: neither combined output
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

  it("clamps a source with a corrupted/gapped internal timeline instead of bloating past the requested window (regression: video-duration-bloat bug)", async () => {
    // Pre-fix, this exact fixture produced an angle output whose `probe()` reported
    // `durationSec: 10` (matching the requested window, i.e. looking correct) while only ~60
    // packets (~1s) of video were actually real -- `normalizeCutArgs`'s `-t` alone didn't stop the
    // container from claiming a duration the source couldn't back up. The fix (CFR resample +
    // `setpts=PTS-STARTPTS` re-anchor + a hard `-frames:v` cap) makes the declared duration track
    // reality: it must never exceed the requested window, and must decode cleanly end to end.
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const windowSec = 10;
    const t = 100_000;
    const result = await processClip({
      clipDir,
      t,
      windowSec,
      config,
      angles: [
        {
          name: "iPhone",
          slug: "iphone",
          files: [{ path: rawGappedCorrupt, startMs: t - windowSec * 1000 }],
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.outputs.angles.iphone).toBe("angle-iphone.mp4");
    expect(result.outputs.combined).toBe("combined.mp4");

    const angleOut = join(clipDir, "angle-iphone.mp4");
    const angle = await probe(angleOut);
    // Core regression check: the declared duration must never bloat past the requested window,
    // and the angle must still yield *some* usable video rather than failing outright.
    expect(angle.durationSec).toBeGreaterThan(0);
    expect(angle.durationSec).toBeLessThanOrEqual(windowSec + 0.5);

    // Hard-cap check: the ACTUAL packet count (ground truth, not just the container's declared
    // duration) must never exceed round(windowSec * targetFps) -- belt-and-suspenders proof that
    // `-frames:v` mechanically bounds the output regardless of what the source's sample table claims.
    const countProc = Bun.spawn(
      [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v",
        "-show_entries",
        "packet=pts_time",
        "-of",
        "csv=p=0",
        angleOut,
      ],
      { stdout: "pipe" },
    );
    const packetCount = (await new Response(countProc.stdout).text())
      .trim()
      .split("\n")
      .filter(Boolean).length;
    expect(packetCount).toBeLessThanOrEqual(Math.round(windowSec * config.targetFps));

    // Discrimination check: the declared duration must match the ACTUAL frame count (not just
    // be bounded above by the window). Pre-fix, durationSec was 10.0 while packetCount/fps was
    // ~1.0 (bloat). Post-fix, both are ~1.0. This assertion would fail on the old normalizeCutArgs.
    expect(angle.durationSec).toBeCloseTo(packetCount / config.targetFps, 1);

    // Decodes clean end to end: no "missing picture in access unit" / PPS-reference errors.
    const decodeProc = Bun.spawn(["ffmpeg", "-v", "error", "-i", angleOut, "-f", "null", "-"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    await decodeProc.exited;
    expect((await new Response(decodeProc.stderr).text()).trim()).toBe("");

    // The combined clip (a straight copy for a single angle) inherits the same guarantees.
    const combined = await probe(join(clipDir, "combined.mp4"));
    expect(combined.durationSec).toBeLessThanOrEqual(windowSec + 0.5);

    // The combined clip's duration must also be consistent with its actual frame count.
    const combinedCountProc = Bun.spawn(
      [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v",
        "-show_entries",
        "packet=pts_time",
        "-of",
        "csv=p=0",
        join(clipDir, "combined.mp4"),
      ],
      { stdout: "pipe" },
    );
    const combinedPacketCount = (await new Response(combinedCountProc.stdout).text())
      .trim()
      .split("\n")
      .filter(Boolean).length;
    expect(combined.durationSec).toBeCloseTo(combinedPacketCount / config.targetFps, 1);
  }, 180_000);
});
