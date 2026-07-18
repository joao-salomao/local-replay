import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, DEFAULT_CONFIG } from "@server/config";

const tmp = () => mkdtempSync(join(tmpdir(), "replay-config-"));

describe("ConfigStore", () => {
  it("creates config.json with defaults and a random password on first load", () => {
    const dir = tmp();
    const store = ConfigStore.load(dir);
    expect(store.value.clipDurationSeconds).toBe(20);
    expect(store.value.layout).toBe("sequential");
    expect(store.value.retentionDays).toBeNull();
    expect(store.value.password.length).toBeGreaterThanOrEqual(6);
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(onDisk.password).toBe(store.value.password);
  });

  it("preserves existing values and fills missing keys with defaults", () => {
    const dir = tmp();
    const first = ConfigStore.load(dir);
    first.value.layout = "side-by-side";
    first.save();
    const second = ConfigStore.load(dir);
    expect(second.value.layout).toBe("side-by-side");
    expect(second.value.targetFps).toBe(DEFAULT_CONFIG.targetFps);
  });

  it("setClipDuration persists valid values and rejects invalid ones", () => {
    const dir = tmp();
    const store = ConfigStore.load(dir);
    store.setClipDuration(45);
    expect(ConfigStore.load(dir).value.clipDurationSeconds).toBe(45);
    expect(() => store.setClipDuration(61)).toThrow();
    expect(() => store.setClipDuration(4)).toThrow();
    expect(() => store.setClipDuration(20.5)).toThrow();
  });
});
