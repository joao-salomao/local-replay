import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Layout } from "./config";
import { logger } from "./log";

const log = logger("storage");

/**
 * Filesystem-backed clip storage: `<dataDir>/clips/<YYYY-MM-DD>/clip-<NNN>/{raw/,meta.json,
 * angle-*.mp4,combined.mp4}`. `meta.json` is the source of truth for a clip's existence and
 * state — `listClips` discovers clips purely by scanning for it (see `clip-job.ts` for why it's
 * always written, even for a failed job).
 */

export type ClipOutputs = {
  combined: string | null;
  /** Side-by-side (simultaneous, hstack) combine of the first two angles — only ever set
   * alongside `combined` when ≥2 angles succeed; `null` for 0 or 1 angle, or if the side-by-side
   * ffmpeg step itself failed (best-effort: see `pipeline.ts#processClip`). */
  combinedSideBySide: string | null;
  angles: Record<string, string>;
};
export type ClipCamera = {
  name: string;
  slug: string;
  files: { startMs: number; durationMs: number }[];
};
export type ClipMeta = {
  jobId: string;
  clipNumber: number;
  t: number;
  windowSec: number;
  layout: Layout;
  state: "processing" | "ready" | "error";
  cameras: ClipCamera[];
  outputs: ClipOutputs;
  errors: string[];
  createdAt: number;
};

const pad3 = (n: number) => String(n).padStart(3, "0");
const dateFolder = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `readdirSync` that treats a missing directory as empty instead of throwing — callers scan
 * date-folders and clip-folders that may not exist yet on a fresh install. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export class Storage {
  constructor(readonly dataDir: string) {
    mkdirSync(join(dataDir, "clips"), { recursive: true });
  }

  clipsDir(): string {
    return join(this.dataDir, "clips");
  }

  /** Next clip number, scanning ALL date-folders (not just today) so numbering stays a single
   * monotonic sequence across day boundaries rather than resetting daily. */
  nextClipNumber(): number {
    let max = 0;
    for (const day of safeReaddir(this.clipsDir())) {
      for (const entry of safeReaddir(join(this.clipsDir(), day))) {
        const m = /^clip-(\d+)$/.exec(entry);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
    return max + 1;
  }

  /** Creates `<clips>/<date-folder>/clip-<NNN>/raw/` (and parents) for a newly triggered job. */
  createClipDir(clipNumber: number, dateMs: number): string {
    const dir = join(this.clipsDir(), dateFolder(dateMs), `clip-${pad3(clipNumber)}`);
    mkdirSync(join(dir, "raw"), { recursive: true });
    return dir;
  }

  writeMeta(dir: string, meta: ClipMeta): void {
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  }

  /**
   * Scans every `meta.json` under `clipsDir()` and returns them newest-first. `dir` is returned
   * RELATIVE to `dataDir` (e.g. `"clips/2026-07-17/clip-003"`), not absolute — the web clips page
   * builds `/files/<dir>/<file>` URLs directly from it, and `routes.ts`'s `/files/*` handler
   * re-resolves it against `dataDir` under its own path-traversal guard.
   */
  listClips(): (ClipMeta & { dir: string })[] {
    const out: (ClipMeta & { dir: string })[] = [];
    for (const day of safeReaddir(this.clipsDir())) {
      for (const entry of safeReaddir(join(this.clipsDir(), day))) {
        const metaPath = join(this.clipsDir(), day, entry, "meta.json");
        if (!existsSync(metaPath)) continue;
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ClipMeta;
        out.push({ ...meta, dir: join("clips", day, entry) });
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Free space on the `dataDir` filesystem, in GB; `null` if `statfs` isn't available (used for
   * the low-disk-space banner in the UI). */
  freeDiskGB(): number | null {
    try {
      const s = statfsSync(this.dataDir);
      return (s.bavail * s.bsize) / 1024 ** 3;
    } catch {
      return null;
    }
  }

  /**
   * Deletes whole date-folders older than `retentionDays`. No-ops if `retentionDays` is `null`
   * (retention disabled). The `/^\d{4}-\d{2}-\d{2}$/` regex guard is load-bearing: it's what
   * limits the recursive `rmSync` to entries that actually look like date-folders this class
   * created, so a stray non-date entry under `clipsDir()` (a stale file, a symlink, anything
   * unexpected) can never be recursively deleted by this sweep.
   */
  cleanupRetention(retentionDays: number | null, nowMs: number): string[] {
    if (retentionDays === null) return [];
    const cutoff = dateFolder(nowMs - retentionDays * 86_400_000);
    const deleted: string[] = [];
    for (const day of safeReaddir(this.clipsDir())) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
        rmSync(join(this.clipsDir(), day), { recursive: true, force: true });
        deleted.push(day);
      }
    }
    // index.ts logs the aggregate count at info; keep the specific folder names at debug
    // here to avoid double-logging the same event at two levels.
    if (deleted.length > 0) log.debug("retention deleted folders", { folders: deleted.join(",") });
    return deleted;
  }
}
