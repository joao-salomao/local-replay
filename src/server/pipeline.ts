import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { computeCutWindow } from "../shared/buffer-window";
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

/**
 * Orchestrates turning a job's raw per-camera uploads into the final clip outputs: for each
 * angle, probe \u2192 compute the cut window \u2192 normalize (cut+scale+encode) \u2192 collect; then combine
 * all successful angles into `combined.mp4` (copy-through for one angle, side-by-side or
 * sequential concat for two or more, per `config.layout`).
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
export async function processClip(o: {
  clipDir: string;
  t: number;
  windowSec: number;
  angles: RawAngle[];
  config: Config;
}): Promise<{ outputs: ClipOutputs; cameras: ClipCamera[]; errors: string[] }> {
  const { clipDir, t, windowSec, config } = o;
  const width = Math.round((config.targetHeight * 16) / 9);
  const windowStartMs = t - windowSec * 1000;
  const outputs: ClipOutputs = { combined: null, angles: {} };
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
    const out = join(clipDir, "combined.mp4");
    log.info("combine start", { angles: anglePaths.length, layout: config.layout });
    if (config.layout === "side-by-side") {
      const combineArgs = combineSideBySideArgs(
        [anglePaths[0]!, anglePaths[1]!],
        { width, height: config.targetHeight, fps: config.targetFps },
        out,
      );
      log.debug("ffmpeg cmd", { cmd: combineArgs.join(" ") });
      await runFfmpeg(combineArgs);
    } else {
      const listFile = join(clipDir, "raw", "combined-list.txt");
      writeConcatList(anglePaths, listFile);
      const combineArgs = combineSequentialArgs(listFile, out);
      log.debug("ffmpeg cmd", { cmd: combineArgs.join(" ") });
      await runFfmpeg(combineArgs);
    }
    outputs.combined = "combined.mp4";
    log.info("combine done", { output: out });
  }

  return { outputs, cameras, errors };
}
