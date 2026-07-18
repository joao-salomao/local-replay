import { describe, expect, it } from "bun:test";
import { LogBuffer } from "@server/log-buffer";
import type { LogEntry } from "@shared/protocol";

function entry(seq: number): LogEntry {
  return { seq, ts: new Date(seq).toISOString(), level: "info", scope: "t", message: `m${seq}` };
}

describe("LogBuffer", () => {
  it("keeps only the last `capacity` entries once pushed beyond it", () => {
    const buf = new LogBuffer(3);
    for (let i = 1; i <= 5; i++) buf.push(entry(i));
    expect(buf.entries().map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("returns entries oldest to newest", () => {
    const buf = new LogBuffer(10);
    [1, 2, 3].forEach((i) => {
      buf.push(entry(i));
    });
    expect(buf.entries().map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("returns a fresh array each call — mutating the result does not affect the buffer", () => {
    const buf = new LogBuffer(10);
    buf.push(entry(1));
    const snapshot = buf.entries();
    snapshot.push(entry(2));
    snapshot.pop();
    snapshot.push(entry(3));
    expect(buf.entries().map((e) => e.seq)).toEqual([1]);
  });

  it("defaults capacity to 200", () => {
    const buf = new LogBuffer();
    for (let i = 1; i <= 205; i++) buf.push(entry(i));
    const seqs = buf.entries().map((e) => e.seq);
    expect(seqs).toHaveLength(200);
    expect(seqs[0]).toBe(6);
    expect(seqs[seqs.length - 1]).toBe(205);
  });

  it("starts empty", () => {
    expect(new LogBuffer().entries()).toEqual([]);
  });
});
