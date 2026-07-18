import { describe, expect, it } from "bun:test";
import { computeOffset } from "@shared/clock";

describe("computeOffset", () => {
  it("returns 0 for a symmetric sample with equal clocks", () => {
    expect(computeOffset([{ clientSent: 1000, serverTime: 1005, clientReceived: 1010 }])).toBe(0);
  });

  it("recovers a constant server-ahead offset", () => {
    // server clock = client clock + 500, symmetric 20ms round trip
    expect(computeOffset([{ clientSent: 1000, serverTime: 1510, clientReceived: 1020 }])).toBe(500);
  });

  it("uses the median across samples (robust to one outlier)", () => {
    const samples = [
      { clientSent: 0, serverTime: 510, clientReceived: 20 }, // 500
      { clientSent: 100, serverTime: 611, clientReceived: 122 }, // 500
      { clientSent: 200, serverTime: 1300, clientReceived: 220 }, // 1090 outlier
    ];
    expect(computeOffset(samples)).toBe(500);
  });

  it("throws on empty input", () => {
    expect(() => computeOffset([])).toThrow();
  });
});
