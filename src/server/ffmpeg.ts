import { writeFileSync } from "node:fs";

export type NormalizeOptions = {
  listFile: string | null;
  input: string | null;
  startSec: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  output: string;
};

export function writeConcatList(paths: string[], listPath: string): void {
  writeFileSync(listPath, paths.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"));
}

export function normalizeCutArgs(o: NormalizeOptions): string[] {
  const args = ["-hide_banner", "-y"];
  if (o.listFile) args.push("-f", "concat", "-safe", "0", "-i", o.listFile);
  else args.push("-i", o.input!);
  if (!o.hasAudio) {
    args.push("-f", "lavfi", "-t", (o.startSec + o.durationSec + 1).toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
  }
  args.push(
    "-ss", o.startSec.toFixed(3),
    "-t", o.durationSec.toFixed(3),
    "-map", "0:v:0",
    "-map", o.hasAudio ? "0:a:0" : "1:a:0",
    "-c:a", "aac", "-b:a", "128k",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-vf", `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2,fps=${o.fps}`,
    "-movflags", "+faststart",
    o.output,
  );
  return args;
}

export function combineSequentialArgs(listFile: string, output: string): string[] {
  return ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", output];
}

export function combineSideBySideArgs(
  inputs: [string, string],
  o: { width: number; height: number; fps: number },
  output: string,
): string[] {
  const half = Math.floor(o.width / 2);
  const pane = (i: number, label: string) =>
    `[${i}:v]scale=${half}:${o.height}:force_original_aspect_ratio=decrease,pad=${half}:${o.height}:(ow-iw)/2:(oh-ih)/2[${label}]`;
  return [
    "-hide_banner", "-y",
    "-i", inputs[0], "-i", inputs[1],
    "-filter_complex", `${pane(0, "l")};${pane(1, "r")};[l][r]hstack=inputs=2,fps=${o.fps}[v]`,
    "-map", "[v]", "-map", "0:a:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ];
}

export async function runFfmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`);
  }
}

export async function probe(file: string): Promise<{ durationSec: number; width: number; height: number; fps: number; hasAudio: boolean }> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffprobe exited ${code}: ${await new Response(proc.stderr).text()}`);
  const data = JSON.parse(await new Response(proc.stdout).text()) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }[];
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
  };
}
