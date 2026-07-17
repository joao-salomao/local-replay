import { describe, expect, it } from "bun:test";
import {
  computeCutWindow,
  cycleSeconds,
  selectFilesForWindow,
} from "../../src/shared/buffer-window";

describe("cycleSeconds", () => {
  it("is max(min, clipDuration)", () => {
    expect(cycleSeconds(20, 30)).toBe(30);
    expect(cycleSeconds(60, 30)).toBe(60);
  });
});

describe("selectFilesForWindow", () => {
  const prev = { startMs: 0, durationMs: 30_000, tag: "prev" };
  const cur = { startMs: 30_200, durationMs: 15_000, tag: "cur" };

  it("picks only the current file when the window fits inside it", () => {
    expect(selectFilesForWindow([prev, cur], 34_000, 44_000).map((f) => f.tag)).toEqual(["cur"]);
  });

  it("picks both files when the window spans the cycle boundary", () => {
    expect(selectFilesForWindow([cur, prev], 25_000, 40_000).map((f) => f.tag)).toEqual([
      "prev",
      "cur",
    ]);
  });

  it("ignores files entirely outside the window", () => {
    expect(selectFilesForWindow([prev, cur], 46_000, 50_000).map((f) => f.tag)).toEqual([]);
  });
});

describe("computeCutWindow", () => {
  it("cuts inside a single file", () => {
    const r = computeCutWindow([{ startMs: 10_000, durationMs: 30_000 }], 25_000, 35_000);
    expect(r.startSec).toBeCloseTo(15, 3);
    expect(r.durationSec).toBeCloseTo(10, 3);
  });

  it("collapses the gap when the window spans two files", () => {
    const files = [
      { startMs: 0, durationMs: 30_000 },
      { startMs: 30_200, durationMs: 15_000 }, // 200ms gap
    ];
    const r = computeCutWindow(files, 25_000, 40_000); // 15s of server time
    expect(r.startSec).toBeCloseTo(25, 3);
    expect(r.durationSec).toBeCloseTo(14.8, 3); // gap content does not exist
  });

  it("clamps a window that starts before available media", () => {
    const r = computeCutWindow([{ startMs: 20_000, durationMs: 10_000 }], 15_000, 28_000);
    expect(r.startSec).toBeCloseTo(0, 3);
    expect(r.durationSec).toBeCloseTo(8, 3);
  });

  it("returns zero duration when the window is after all media", () => {
    const r = computeCutWindow([{ startMs: 0, durationMs: 10_000 }], 12_000, 15_000);
    expect(r.durationSec).toBe(0);
  });

  it("throws on empty file list", () => {
    expect(() => computeCutWindow([], 0, 1000)).toThrow();
  });
});
