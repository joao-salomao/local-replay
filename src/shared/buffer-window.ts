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
 * Extra seconds of media the buffer holds BEYOND the configured clip duration. This slack is what
 * lets `computeCutWindow` reach a cut backward in the media timeline to recover the sub-second gaps
 * MediaRecorder leaves when it rotates between cycles — without it, a clip window that straddles a
 * cycle boundary would come out short (e.g. 9.6s for a requested 10s). The extra is only ever a
 * safety reserve: it's never included in the final clip (the cut takes exactly the requested
 * duration of media and discards the rest).
 */
export const BUFFER_MARGIN_SECONDS = 5;

/**
 * Length (seconds) of one camera recording cycle, i.e. how often the camera rotates its
 * MediaRecorder and rolls the buffer forward (see `web/camera/camera.ts#startCycle`).
 *
 * Always >= clipDurationSeconds + BUFFER_MARGIN_SECONDS: since the camera only keeps the previous +
 * current file (2 files, see camera.ts), the previous file alone must cover the whole clip window
 * plus the margin slack that `computeCutWindow` reaches into to compensate for rotation gaps — a
 * shorter cycle could leave the window uncovered or with no slack to recover the gap. Also floored
 * at minCycleSeconds so a short configured clip duration doesn't force excessively frequent
 * MediaRecorder restarts.
 */
export function cycleSeconds(clipDurationSeconds: number, minCycleSeconds: number): number {
  return Math.max(minCycleSeconds, clipDurationSeconds + BUFFER_MARGIN_SECONDS);
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
 * The cut is ANCHORED AT THE END and takes the requested duration of REAL media: it maps the
 * window end to the media timeline, then reaches back exactly `windowEndMs - windowStartMs` of
 * media from there. If the naive wall-clock mapping of the window start would have lost media to a
 * rotation gap that falls inside the window (the classic "requested 10s, got 9.6s" bug), the cut
 * simply reaches that much further back into the earlier file — which is why the camera buffers
 * `BUFFER_MARGIN_SECONDS` of slack past the clip length (see `cycleSeconds`). Aligning at the end
 * also means every camera's clip finishes on the same trigger instant and comes out the exact same
 * length, which the side-by-side grid (`ffmpeg.ts#combineSideBySideArgs`) needs from its inputs.
 *
 * Throws if `files` is empty. Returns a zero-length cut when the window covers no real media at all
 * (entirely inside a gap, or entirely before/after every file) rather than fabricating footage.
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
  const endMediaMs = toMediaMs(windowEndMs);
  const naiveStartMediaMs = toMediaMs(windowStartMs);
  // No real media in the window (it sits in a gap or fully outside every file): nothing to cut.
  if (endMediaMs <= naiveStartMediaMs) return { startSec: endMediaMs / 1000, durationSec: 0 };
  // Reach the cut backward to recover the full requested duration ONLY to compensate for gaps that
  // fall INSIDE the window — i.e. when the window end still lands on real media. If the window runs
  // past all recorded media (a camera whose video died before the trigger, e.g. it got locked),
  // that missing tail must NOT slide the cut backward: doing so would desync this angle from the
  // others that do have video through the trigger. In that case keep just the covered portion.
  const lastWallEndMs = Math.max(...sorted.map((f) => f.startMs + f.durationMs));
  const windowEndHasMedia = windowEndMs <= lastWallEndMs;
  const requestedMs = windowEndMs - windowStartMs;
  const shortfallMs = windowEndHasMedia
    ? Math.max(0, requestedMs - (endMediaMs - naiveStartMediaMs))
    : 0;
  const startMediaMs = Math.max(0, naiveStartMediaMs - shortfallMs);
  return { startSec: startMediaMs / 1000, durationSec: (endMediaMs - startMediaMs) / 1000 };
}
