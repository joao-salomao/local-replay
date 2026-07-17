import { describe, expect, it } from "bun:test";
import { SerialQueue } from "../../src/server/queue";

describe("SerialQueue", () => {
  it("runs tasks strictly in order", async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const slow = q.push(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const fast = q.push(async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });

  it("keeps processing after a task throws", async () => {
    const q = new SerialQueue();
    const failed = q.push(async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    const ok = q.push(async () => "fine" as unknown as void);
    await ok;
  });
});
