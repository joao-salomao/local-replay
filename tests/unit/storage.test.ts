import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage, type ClipMeta } from "../../src/server/storage";

const tmp = () => mkdtempSync(join(tmpdir(), "replay-storage-"));

const meta = (over: Partial<ClipMeta>): ClipMeta => ({
  jobId: "j1", clipNumber: 1, t: 0, windowSec: 20, layout: "sequential",
  state: "ready", cameras: [], outputs: { combined: "combined.mp4", angles: {} },
  errors: [], createdAt: 0, ...over,
});

describe("Storage", () => {
  it("starts clip numbering at 1 and scans across date folders", () => {
    const s = new Storage(tmp());
    expect(s.nextClipNumber()).toBe(1);
    s.createClipDir(1, Date.parse("2026-07-16T12:00:00Z"));
    s.createClipDir(7, Date.parse("2026-07-17T12:00:00Z"));
    expect(s.nextClipNumber()).toBe(8);
  });

  it("creates the clip dir with a raw/ subfolder", () => {
    const s = new Storage(tmp());
    const dir = s.createClipDir(3, Date.parse("2026-07-17T15:00:00Z"));
    expect(dir.endsWith(join("2026-07-17", "clip-003"))).toBe(true);
    expect(existsSync(join(dir, "raw"))).toBe(true);
  });

  it("round-trips meta.json and lists newest first with relative dir", () => {
    const s = new Storage(tmp());
    const d1 = s.createClipDir(1, Date.parse("2026-07-16T12:00:00Z"));
    const d2 = s.createClipDir(2, Date.parse("2026-07-17T12:00:00Z"));
    s.writeMeta(d1, meta({ clipNumber: 1, createdAt: 100 }));
    s.writeMeta(d2, meta({ clipNumber: 2, createdAt: 200 }));
    const list = s.listClips();
    expect(list.map((c) => c.clipNumber)).toEqual([2, 1]);
    expect(list[0]!.dir).toBe(join("clips", "2026-07-17", "clip-002"));
  });

  it("skips clip dirs without meta.json", () => {
    const s = new Storage(tmp());
    s.createClipDir(1, Date.now());
    expect(s.listClips()).toEqual([]);
  });

  it("retention deletes date folders older than the cutoff, keeps null untouched", () => {
    const s = new Storage(tmp());
    const now = Date.parse("2026-07-17T12:00:00Z");
    s.createClipDir(1, now - 10 * 86_400_000);
    s.createClipDir(2, now);
    expect(s.cleanupRetention(null, now)).toEqual([]);
    const deleted = s.cleanupRetention(7, now);
    expect(deleted).toEqual(["2026-07-07"]);
    expect(s.listClips().length).toBe(0); // clip-002 has no meta yet, but its dir remains
    expect(existsSync(join(s.clipsDir(), "2026-07-17"))).toBe(true);
  });

  it("reports free disk space as a number", () => {
    const s = new Storage(tmp());
    const free = s.freeDiskGB();
    expect(free === null || free > 0).toBe(true);
  });
});
