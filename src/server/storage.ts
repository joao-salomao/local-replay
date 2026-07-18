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

export type ClipOutputs = { combined: string | null; angles: Record<string, string> };
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

  createClipDir(clipNumber: number, dateMs: number): string {
    const dir = join(this.clipsDir(), dateFolder(dateMs), `clip-${pad3(clipNumber)}`);
    mkdirSync(join(dir, "raw"), { recursive: true });
    return dir;
  }

  writeMeta(dir: string, meta: ClipMeta): void {
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  }

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

  freeDiskGB(): number | null {
    try {
      const s = statfsSync(this.dataDir);
      return (s.bavail * s.bsize) / 1024 ** 3;
    } catch {
      return null;
    }
  }

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
