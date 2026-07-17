import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { computeCutWindow } from "../shared/buffer-window";
import type { Config } from "./config";
import { combineSequentialArgs, combineSideBySideArgs, normalizeCutArgs, probe, runFfmpeg, writeConcatList } from "./ffmpeg";
import type { ClipCamera, ClipOutputs } from "./storage";

export type RawAngle = { name: string; slug: string; files: { path: string; startMs: number }[] };

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

  for (const angle of o.angles) {
    try {
      const probed = [];
      let hasAudio = false;
      for (const f of angle.files) {
        const info = await probe(f.path);
        probed.push({ path: f.path, startMs: f.startMs, durationMs: info.durationSec * 1000 });
        hasAudio = hasAudio || info.hasAudio;
      }
      const cut = computeCutWindow(probed, windowStartMs, t);
      if (cut.durationSec < 0.5) throw new Error("window not covered by uploaded files");

      let listFile: string | null = null;
      let input: string | null = null;
      if (probed.length > 1) {
        listFile = join(clipDir, "raw", `${angle.slug}-list.txt`);
        writeConcatList(probed.map((p) => p.path), listFile);
      } else {
        input = probed[0]!.path;
      }
      const outName = `angle-${angle.slug}.mp4`;
      await runFfmpeg(
        normalizeCutArgs({
          listFile, input,
          startSec: cut.startSec, durationSec: cut.durationSec,
          width, height: config.targetHeight, fps: config.targetFps,
          hasAudio, output: join(clipDir, outName),
        }),
      );
      outputs.angles[angle.slug] = outName;
      anglePaths.push(join(clipDir, outName));
      cameras.push({ name: angle.name, slug: angle.slug, files: probed.map(({ startMs, durationMs }) => ({ startMs, durationMs })) });
    } catch (e) {
      errors.push(`angle ${angle.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (anglePaths.length === 1) {
    copyFileSync(anglePaths[0]!, join(clipDir, "combined.mp4"));
    outputs.combined = "combined.mp4";
  } else if (anglePaths.length >= 2) {
    const out = join(clipDir, "combined.mp4");
    if (config.layout === "side-by-side") {
      await runFfmpeg(combineSideBySideArgs([anglePaths[0]!, anglePaths[1]!], { width, height: config.targetHeight, fps: config.targetFps }, out));
    } else {
      const listFile = join(clipDir, "raw", "combined-list.txt");
      writeConcatList(anglePaths, listFile);
      await runFfmpeg(combineSequentialArgs(listFile, out));
    }
    outputs.combined = "combined.mp4";
  }

  return { outputs, cameras, errors };
}
