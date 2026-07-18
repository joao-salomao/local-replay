/**
 * Pure math for the camera-side rolling buffer and the server-side clip cut.
 *
 * Timestamps in this module are always server-clock ms (see `../shared/clock.ts`), which is what
 * makes them comparable across independently-clocked camera devices. `computeCutWindow` is the
 * subtle one: it has to reconcile three different time-spaces (wall-clock file start times, each
 * file's own internal duration, and the flat concatenated-media timeline ffmpeg will produce) —
 * see its doc comment below.
 */

/** A recorded segment as seen on the server-clock timeline: starts at `startMs`, lasts `durationMs`. */
export type BufferFile = { startMs: number; durationMs: number };

/**
 * Length (seconds) of one camera recording cycle, i.e. how often the camera rotates its
 * MediaRecorder and rolls the buffer forward (see `web/camera/camera.ts#startCycle`).
 *
 * Always >= clipDurationSeconds: since the camera only keeps the previous + current file (2
 * files, see camera.ts), a cycle shorter than the clip window could require more than 2 files to
 * cover it. Also floored at minCycleSeconds so a short configured clip duration doesn't force
 * excessively frequent MediaRecorder restarts.
 */
export function cycleSeconds(clipDurationSeconds: number, minCycleSeconds: number): number {
  return Math.max(minCycleSeconds, clipDurationSeconds);
}

/**
 * Filters `files` down to those overlapping [windowStartMs, windowEndMs), sorted chronologically.
 * Used both client-side (camera.ts picks which buffered blobs to upload) and as the general
 * building block for window/file overlap tests.
 */
export function selectFilesForWindow<T extends BufferFile>(
  files: T[],
  windowStartMs: number,
  windowEndMs: number,
): T[] {
  return files
    .filter((f) => f.startMs < windowEndMs && f.startMs + f.durationMs > windowStartMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Converts a [windowStartMs, windowEndMs) window — expressed in server-clock wall time — into a
 * {startSec, durationSec} offset into the MEDIA TIMELINE that results from ffmpeg concatenating
 * `files` in order. This is the piece that lets `ffmpeg.ts#normalizeCutArgs` use a plain
 * output-side `-ss`/`-t` against a concat-demuxer input.
 *
 * Why this is non-trivial: a file's position in the concatenated output is the cumulative SUM of
 * the durations of the files before it, which is generally NOT the same as its wall-clock
 * `startMs` gap from the previous file — MediaRecorder stop/start latency and network jitter mean
 * there can be small real-world gaps between recordings that simply don't exist in the stitched
 * media. `spans` builds the wall-clock-to-media-timeline mapping per file; `toMediaMs` walks it to
 * convert a single timestamp, snapping timestamps that fall inside an inter-file gap forward to
 * the start of the next file (there's no media to represent the gap itself).
 *
 * Throws if `files` is empty. Clamps duration to >= 0 (a window entirely inside a gap collapses to
 * a zero-length cut rather than going negative).
 */
export function computeCutWindow(
  files: BufferFile[],
  windowStartMs: number,
  windowEndMs: number,
): { startSec: number; durationSec: number } {
  if (files.length === 0) throw new Error("computeCutWindow: no files");
  const sorted = [...files].sort((a, b) => a.startMs - b.startMs);
  let elapsed = 0;
  const spans = sorted.map((f) => {
    const span = { mediaStartMs: elapsed, startMs: f.startMs, durationMs: f.durationMs };
    elapsed += f.durationMs;
    return span;
  });
  const totalMs = elapsed;
  const toMediaMs = (ts: number): number => {
    for (const s of spans) {
      if (ts < s.startMs) return s.mediaStartMs; // inside a gap → snap forward
      if (ts <= s.startMs + s.durationMs) return s.mediaStartMs + (ts - s.startMs);
    }
    return totalMs;
  };
  const startMs = toMediaMs(windowStartMs);
  const endMs = toMediaMs(windowEndMs);
  return { startSec: startMs / 1000, durationSec: Math.max(0, endMs - startMs) / 1000 };
}
