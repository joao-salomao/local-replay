import { describe, expect, it } from "bun:test";
import {
  BUFFER_MARGIN_SECONDS,
  computeCutWindow,
  cycleSeconds,
  selectFilesForWindow,
} from "@shared/buffer-window";

describe("cycleSeconds", () => {
  it("is max(min, clipDuration + margin) so the buffer always holds the clip plus slack", () => {
    // The +BUFFER_MARGIN_SECONDS slack is what lets computeCutWindow reach a cut backward to
    // recover MediaRecorder rotation gaps (see the gap test below) instead of returning a short clip.
    expect(cycleSeconds(20, 30)).toBe(30); // max(30, 25): the min floor still wins
    expect(cycleSeconds(30, 30)).toBe(30 + BUFFER_MARGIN_SECONDS); // 35: margin now wins over the floor
    expect(cycleSeconds(60, 30)).toBe(60 + BUFFER_MARGIN_SECONDS); // 65: clip + margin
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

  it("reaches back across a MediaRecorder gap to keep the FULL requested duration (no 9.6s clips)", () => {
    const files = [
      { startMs: 0, durationMs: 30_000 },
      { startMs: 30_400, durationMs: 15_000 }, // 400ms rotation gap after the previous cycle
    ];
    // A 10s wall-clock window [25s, 35s] straddles the gap. The OLD behavior mapped both edges to
    // the media timeline and silently dropped the 400ms of gap -> a 9.6s clip. Now the cut is
    // anchored at the end and reaches 400ms further back into real media to still yield a full 10s.
    const r = computeCutWindow(files, 25_000, 35_000);
    expect(r.durationSec).toBeCloseTo(10, 3); // full 10s, NOT 9.6
    expect(r.startSec).toBeCloseTo(24.6, 3); // reached 400ms further back than the naive 25.0
  });

  it("does NOT slide back when the window runs past all media (camera died before the trigger)", () => {
    // Video ends at 96s but the trigger window runs to 100s (the phone locked at 96s). The missing
    // tail must not pull the cut backward — that would desync this angle from cameras that DO have
    // video through the trigger. Return just the covered [90s, 96s) = 6s, not a slid-back 10s.
    const r = computeCutWindow([{ startMs: 84_000, durationMs: 12_000 }], 90_000, 100_000);
    expect(r.startSec).toBeCloseTo(6, 3); // media offset of 90s inside the file that starts at 84s
    expect(r.durationSec).toBeCloseTo(6, 3); // covered portion only, NOT reached back to a full 10s
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
