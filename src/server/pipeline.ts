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
  const usedSlugs = new Set<string>();

  for (const angle of o.angles) {
    try {
      let uniqueSlug = angle.slug;
      let n = 2;
      while (usedSlugs.has(uniqueSlug)) uniqueSlug = `${angle.slug}-${n++}`;
      usedSlugs.add(uniqueSlug);

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
        listFile = join(clipDir, "raw", `${uniqueSlug}-list.txt`);
        writeConcatList(
          probed.map((p) => p.path),
          listFile,
        );
      } else {
        input = probed[0]!.path;
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
        files: probed.map(({ startMs, durationMs }) => ({ startMs, durationMs })),
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
