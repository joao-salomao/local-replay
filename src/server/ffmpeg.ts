import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Builds argv arrays for `ffmpeg`/`ffprobe` invocations and runs them via `Bun.spawn`. Kept
 * separate from `pipeline.ts` so the argument-building logic (easy to unit-test as plain data)
 * is decoupled from process orchestration.
 */

export type NormalizeOptions = {
  /** Concat-demuxer list file (multiple source segments) — mutually exclusive with `input`. */
  listFile: string | null;
  /** Single source file — mutually exclusive with `listFile`. */
  input: string | null;
  startSec: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  output: string;
};

/**
 * Writes an ffmpeg concat-demuxer list file (`file '...'` per line, one per path in `paths`).
 *
 * Paths are resolved to ABSOLUTE before writing: the concat demuxer resolves relative entries
 * against the list file's own directory, not the process cwd, so a path built from a relative
 * `DATA_DIR` would get silently mis-resolved (effectively doubled) and fail to open.
 *
 * Embedded single quotes are escaped by closing the quote, inserting an escaped quote, and
 * reopening it (`'\\''`) — the shell-style quoting the concat demuxer's own line parser expects.
 */
export function writeConcatList(paths: string[], listPath: string): void {
  writeFileSync(
    listPath,
    paths.map((p) => `file '${resolve(p).replaceAll("'", "'\\''")}'`).join("\n"),
  );
}

/**
 * Builds the argv for cutting+normalizing one angle's source (single file or concat list) down to
 * exactly [startSec, startSec + durationSec) of standardized output (scaled/padded to
 * width×height, fps, h264/aac).
 *
 * `-ss`/`-t` are placed AFTER `-i` (output-side seeking) rather than before it: output-side
 * seeking decodes from the true start and cuts frame-accurately, whereas input-side seeking snaps
 * to the nearest keyframe — cheaper but imprecise, which would make clip boundaries drift from
 * the requested window. This pipeline favors accuracy over speed since the whole point is
 * cutting an exact "lance" (play) window.
 *
 * When the source has no audio track, a synthetic silent track (`anullsrc`) is generated and
 * mapped in instead — this guarantees every normalized angle output has an audio stream, which
 * the downstream combine step relies on unconditionally (`-map 0:a:0` in
 * `combineSideBySideArgs`, and stream-identical assumptions in `combineSequentialArgs`).
 */
export function normalizeCutArgs(o: NormalizeOptions): string[] {
  const args = ["-hide_banner", "-y"];
  if (o.listFile) args.push("-f", "concat", "-safe", "0", "-i", o.listFile);
  else args.push("-i", o.input!);
  if (!o.hasAudio) {
    args.push(
      "-f",
      "lavfi",
      "-t",
      (o.startSec + o.durationSec + 1).toFixed(3),
      "-i",
      "anullsrc=r=48000:cl=stereo",
    );
  }
  args.push(
    "-ss",
    o.startSec.toFixed(3),
    "-t",
    o.durationSec.toFixed(3),
    "-map",
    "0:v:0",
    "-map",
    o.hasAudio ? "0:a:0" : "1:a:0",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2,fps=${o.fps}`,
    "-movflags",
    "+faststart",
    o.output,
  );
  return args;
}

/**
 * Concatenates already-normalized angle outputs, in list order, via the concat demuxer with
 * `-c copy` (stream copy, no re-encode — fast, lossless).
 *
 * `-c copy` is only safe here because every input to this function already went through
 * `normalizeCutArgs`, which forces identical codec, resolution, pixel format, and fps across all
 * angles. Stream-copy concatenation requires that compatibility; feeding it segments with
 * differing encode parameters would produce a broken or corrupted output.
 */
export function combineSequentialArgs(listFile: string, output: string): string[] {
  return [
    "-hide_banner",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ];
}

/** Builds a `hstack` filter graph combining exactly two angle outputs into one side-by-side
 * frame, each pane scaled/padded to half the target width. Requires re-encoding (no `-c copy`). */
export function combineSideBySideArgs(
  inputs: [string, string],
  o: { width: number; height: number; fps: number },
  output: string,
): string[] {
  const half = Math.floor(o.width / 2);
  const pane = (i: number, label: string) =>
    `[${i}:v]scale=${half}:${o.height}:force_original_aspect_ratio=decrease,pad=${half}:${o.height}:(ow-iw)/2:(oh-ih)/2[${label}]`;
  return [
    "-hide_banner",
    "-y",
    "-i",
    inputs[0],
    "-i",
    inputs[1],
    "-filter_complex",
    `${pane(0, "l")};${pane(1, "r")};[l][r]hstack=inputs=2,fps=${o.fps}[v]`,
    "-map",
    "[v]",
    "-map",
    "0:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    output,
  ];
}

/** Runs `ffmpeg` with `args`, throwing on non-zero exit. Only the last 800 chars of stderr are
 * kept in the error — ffmpeg's stderr can be very verbose, but the actually useful failure
 * reason is what it prints last, so the tail is what's worth surfacing in logs/errors. */
export async function runFfmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`);
  }
}

/** Runs `ffprobe` on `file` and extracts the fields `pipeline.ts` needs: duration, the first
 * video stream's resolution/fps (from `r_frame_rate`'s num/den), whether any audio stream is
 * present, and whether any video stream is present at all (`hasVideo`). `hasVideo` matters
 * because a locked iOS phone suspends its camera's video track while the mic keeps recording, so
 * the uploaded segment can be an audio-only mp4 — `pipeline.ts` uses this flag to skip such an
 * angle up front instead of handing it to ffmpeg, which would otherwise reject the `-map 0:v:0`
 * with a cryptic "Stream map '' matches no streams" failure. */
export async function probe(file: string): Promise<{
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
}> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(`ffprobe exited ${code}: ${await new Response(proc.stderr).text()}`);
  const data = JSON.parse(await new Response(proc.stdout).text()) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      duration?: string;
    }[];
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const [num, den] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  const durationSec = Number(data.format?.duration ?? video?.duration ?? 0);
  return {
    durationSec,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: den ? (num ?? 0) / den : 0,
    hasAudio: data.streams?.some((s) => s.codec_type === "audio") ?? false,
    hasVideo: data.streams?.some((s) => s.codec_type === "video") ?? false,
  };
}
