import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { computeCutWindow } from "@shared/buffer-window";
import type { Config } from "./config";
import {
  combineSequentialArgs,
  combineSideBySideArgs,
  normalizeCutArgs,
  probe,
  runFfmpeg,
  writeConcatList,
} from "./ffmpeg";
import { logger } from "./log";
import type { ClipCamera, ClipOutputs } from "./storage";

const log = logger("ffmpeg");

/** One camera's raw uploaded segments for a clip, prior to normalization. `files` are on disk
 * already (written by `routes.ts`'s upload handler) but not yet probed for duration/audio. */
export type RawAngle = { name: string; slug: string; files: { path: string; startMs: number }[] };

/** Turns a display name into a filesystem/URL-safe slug: strips accents (NFD decompose + drop
 * combining marks), lowercases, collapses non-alphanumerics to `-`, trims edge dashes. Falls back
 * to `"camera"` if that leaves nothing (e.g. a name that was pure punctuation/emoji). */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "camera"
  );
}

/** Test-only injection seam (mirrors `clip-job.ts`'s `Deps.processFn` pattern): lets a test
 * substitute the side-by-side combine step with a fake that fails on demand, to exercise the
 * best-effort catch around it (see `processClip`'s docstring) without needing a real ffmpeg
 * failure. Defaults to the real `runFfmpeg`, so the production call path (no `deps` argument) is
 * byte-identical to before this seam existed. */
export type ProcessClipDeps = {
  combineSideBySideFn?: (args: string[]) => Promise<void>;
};

/**
 * Orchestrates turning a job's raw per-camera uploads into the final clip outputs: for each
 * angle, probe \u2192 compute the cut window \u2192 normalize (cut+scale+encode) \u2192 collect; then combine
 * all successful angles: a single angle is copy-through'd to `combined.mp4`; two or more angles
 * produce BOTH a sequential concat (`combined.mp4`, the primary/main output) AND a simultaneous
 * grid of ALL angles (`combined-side-by-side.mp4` \u2014 a near-square `xstack` tile; see
 * `combineSideBySideArgs`) \u2014 `config.layout` no longer selects between them, it's kept only as a
 * persisted config field (see `config.ts#Layout`).
 *
 * One angle's failure does not abort the clip: each angle runs in its own try/catch, and a
 * failure is recorded in `errors` while the other angles still proceed \u2014 partial success (some
 * angles ready, others failed) is a first-class outcome here, surfaced by the caller
 * (`clip-job.ts`) as `state: "ready"` with `errors` populated, as long as at least one output
 * exists. This is also how a locked phone camera is handled: an angle's probed files are filtered
 * down to only those with a video stream (iOS suspends the camera while keeping the mic live, so
 * a locked segment is audio-only) before anything is handed to ffmpeg \u2014 a phone locked for only
 * part of the buffered window still contributes its video segment(s), and only a *fully* locked
 * angle (zero video files) is failed, with a readable "no video stream" error, instead of being
 * handed to ffmpeg \u2014 the other angles still produce `combined.mp4`. If every angle lacks video,
 * `anglePaths` ends up empty and `outputs.combined` stays `null`, so the job surfaces as an error
 * with per-angle messages instead of an ffmpeg stderr dump.
 */
export async function processClip(
  o: {
    clipDir: string;
    t: number;
    windowSec: number;
    angles: RawAngle[];
    config: Config;
  },
  deps: ProcessClipDeps = {},
): Promise<{ outputs: ClipOutputs; cameras: ClipCamera[]; errors: string[] }> {
  const { clipDir, t, windowSec, config } = o;
  const runSideBySideCombine = deps.combineSideBySideFn ?? runFfmpeg;
  const width = Math.round((config.targetHeight * 16) / 9);
  const windowStartMs = t - windowSec * 1000;
  const outputs: ClipOutputs = { combined: null, combinedSideBySide: null, angles: {} };
  const cameras: ClipCamera[] = [];
  const errors: string[] = [];
  const anglePaths: string[] = [];
  const usedSlugs = new Set<string>();

  for (const angle of o.angles) {
    try {
      let uniqueSlug = angle.slug;
      let n = 2;
      while (usedSlugs.has(uniqueSlug)) uniqueSlug = `${angle.slug}-${n++}`;
      usedSlugs.add(uniqueSlug);

      const probed = [];
      for (const f of angle.files) {
        const info = await probe(f.path);
        probed.push({
          path: f.path,
          startMs: f.startMs,
          durationMs: info.durationSec * 1000,
          hasVideo: info.hasVideo,
          hasAudio: info.hasAudio,
        });
      }
      // A locked iOS phone suspends its camera's video track while the mic keeps recording, so
      // the upload can be audio-only. The camera buffers the previous + current recording cycle
      // (2 files — see camera.ts#startCycle), so a phone locked for only PART of that window
      // produces a MIX: one audio-only file and one video file for the same angle. Filtering down
      // to only the video-bearing files (rather than OR-accumulating a single hasVideo flag
      // across the whole angle) keeps the good segment(s) instead of dropping the angle — and it
      // structurally avoids ever handing ffmpeg a concat list containing a non-video file: the
      // concat demuxer exposes only the FIRST input's stream layout, so a mixed list can fail
      // normalizeCutArgs's `-map 0:v:0` (or `-map 0:a:0`) with a cryptic "Stream map '' matches no
      // streams" dump even though some file in the list does have video. A fully-locked angle
      // (every file audio-only) still bails out here with the same readable error as before.
      const videoFiles = probed.filter((p) => p.hasVideo);
      if (videoFiles.length === 0)
        throw new Error("no video stream (camera locked or in background?)");
      const hasAudio = videoFiles.some((p) => p.hasAudio);
      const cut = computeCutWindow(videoFiles, windowStartMs, t);
      if (cut.durationSec < 0.5) throw new Error("window not covered by uploaded files");

      let listFile: string | null = null;
      let input: string | null = null;
      if (videoFiles.length > 1) {
        listFile = join(clipDir, "raw", `${uniqueSlug}-list.txt`);
        writeConcatList(
          videoFiles.map((p) => p.path),
          listFile,
        );
      } else {
        input = videoFiles[0]!.path;
      }
      const outName = `angle-${uniqueSlug}.mp4`;
      const cutArgs = normalizeCutArgs({
        listFile,
        input,
        startSec: cut.startSec,
        durationSec: cut.durationSec,
        width,
        height: config.targetHeight,
        fps: config.targetFps,
        hasAudio,
        output: join(clipDir, outName),
      });
      log.debug("ffmpeg cmd", { slug: uniqueSlug, cmd: cutArgs.join(" ") });
      await runFfmpeg(cutArgs);
      log.debug("angle normalized", { slug: uniqueSlug });
      outputs.angles[uniqueSlug] = outName;
      anglePaths.push(join(clipDir, outName));
      cameras.push({
        name: angle.name,
        slug: uniqueSlug,
        files: videoFiles.map(({ startMs, durationMs }) => ({ startMs, durationMs })),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn("angle failed", { slug: angle.slug, error: message });
      errors.push(`angle ${angle.slug}: ${message}`);
    }
  }

  if (anglePaths.length === 1) {
    copyFileSync(anglePaths[0]!, join(clipDir, "combined.mp4"));
    outputs.combined = "combined.mp4";
  } else if (anglePaths.length >= 2) {
    // Both combined outputs are produced whenever ≥2 angles succeed — `config.layout` is no
    // longer branched on here (see the docstring above and `config.ts#Layout`).
    const out = join(clipDir, "combined.mp4");
    log.info("combine start", { angles: anglePaths.length });
    const listFile = join(clipDir, "raw", "combined-list.txt");
    writeConcatList(anglePaths, listFile);
    const sequentialArgs = combineSequentialArgs(listFile, out);
    log.debug("ffmpeg cmd", { cmd: sequentialArgs.join(" ") });
    await runFfmpeg(sequentialArgs);
    outputs.combined = "combined.mp4";
    log.info("combine done", { output: out });

    // The side-by-side combine is best-effort: unlike the sequential combine above (whose
    // failure aborts the whole clip, matching prior behavior), a failure here is recorded as an
    // error but must not take down the sequential combined output + angles that already
    // succeeded — mirrors the per-angle resilience elsewhere in this function.
    try {
      const sideBySideOut = join(clipDir, "combined-side-by-side.mp4");
      // `cameras[i]` is 1:1 with `anglePaths[i]` (both are pushed together in the loop above), so a
      // camera's index in `cameras` is also its ffmpeg `-i` input index. Resolve the configured
      // audio source by name, falling back to the first angle (index 0) when it's unset or that
      // camera contributed no video to this clip.
      const audioInputIndex = config.audioSourceName
        ? Math.max(
            0,
            cameras.findIndex((c) => c.name === config.audioSourceName),
          )
        : 0;
      const sideBySideArgs = combineSideBySideArgs(
        anglePaths,
        { width, height: config.targetHeight, fps: config.targetFps, audioInputIndex },
        sideBySideOut,
      );
      log.debug("ffmpeg cmd", { cmd: sideBySideArgs.join(" ") });
      await runSideBySideCombine(sideBySideArgs);
      outputs.combinedSideBySide = "combined-side-by-side.mp4";
      log.info("combine side-by-side done", { output: sideBySideOut });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn("side-by-side combine failed", { error: message });
      errors.push(`side-by-side combine: ${message}`);
    }
  }

  return { outputs, cameras, errors };
}
