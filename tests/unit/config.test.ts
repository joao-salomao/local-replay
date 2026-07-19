import { describe, expect, it } from "bun:test";
import { ConfigStore, DEFAULT_CONFIG } from "@server/config";

describe("ConfigStore.fromEnv", () => {
  it("throws when PASSWORD or SESSION_SECRET is unset or blank (both are required to boot)", () => {
    expect(() => ConfigStore.fromEnv({})).toThrow(); // no PASSWORD
    expect(() => ConfigStore.fromEnv({ PASSWORD: "   " })).toThrow(); // blank PASSWORD
    expect(() => ConfigStore.fromEnv({ PASSWORD: "p" })).toThrow(); // no SESSION_SECRET
    expect(() => ConfigStore.fromEnv({ PASSWORD: "p", SESSION_SECRET: "  " })).toThrow(); // blank
  });

  it("uses defaults for everything but the required secrets when nothing else is set", () => {
    const c = ConfigStore.fromEnv({ PASSWORD: "secret", SESSION_SECRET: "sess" }).value;
    expect(c.password).toBe("secret");
    expect(c.sessionSecret).toBe("sess");
    expect(c.clipDurationSeconds).toBe(DEFAULT_CONFIG.clipDurationSeconds);
    expect(c.clipDurationMaxSeconds).toBe(DEFAULT_CONFIG.clipDurationMaxSeconds);
    expect(c.bufferCycleMinSeconds).toBe(DEFAULT_CONFIG.bufferCycleMinSeconds);
    expect(c.audioSourceName).toBeNull();
    expect(c.targetHeight).toBe(DEFAULT_CONFIG.targetHeight);
    expect(c.targetFps).toBe(DEFAULT_CONFIG.targetFps);
    expect(c.captureWidth).toBe(DEFAULT_CONFIG.captureWidth);
    expect(c.captureHeight).toBe(DEFAULT_CONFIG.captureHeight);
    expect(c.captureFps).toBe(DEFAULT_CONFIG.captureFps);
    expect(c.retentionDays).toBeNull();
  });

  it("reads and trims overrides from the environment", () => {
    const c = ConfigStore.fromEnv({
      PASSWORD: "  secret  ",
      SESSION_SECRET: "  sess  ",
      CLIP_DURATION_SECONDS: "30",
      CLIP_DURATION_MAX_SECONDS: "90",
      BUFFER_CYCLE_MIN_SECONDS: "45",
      AUDIO_SOURCE_NAME: "  Fundo  ",
      TARGET_HEIGHT: "720",
      TARGET_FPS: "30",
      CAPTURE_WIDTH: "1280",
      CAPTURE_HEIGHT: "720",
      CAPTURE_FPS: "24",
      RETENTION_DAYS: "14",
    }).value;
    expect(c.password).toBe("secret");
    expect(c.sessionSecret).toBe("sess");
    expect(c.clipDurationSeconds).toBe(30);
    expect(c.clipDurationMaxSeconds).toBe(90);
    expect(c.bufferCycleMinSeconds).toBe(45);
    expect(c.audioSourceName).toBe("Fundo");
    expect(c.targetHeight).toBe(720);
    expect(c.targetFps).toBe(30);
    expect(c.captureWidth).toBe(1280);
    expect(c.captureHeight).toBe(720);
    expect(c.captureFps).toBe(24);
    expect(c.retentionDays).toBe(14);
  });

  it("falls back to defaults on unparseable numerics and treats a blank AUDIO_SOURCE_NAME as null", () => {
    const c = ConfigStore.fromEnv({
      PASSWORD: "secret",
      SESSION_SECRET: "sess",
      CLIP_DURATION_SECONDS: "abc", // invalid -> default
      AUDIO_SOURCE_NAME: "   ", // blank -> null (automatic)
      RETENTION_DAYS: "not-a-number", // invalid -> null (keep forever)
    }).value;
    expect(c.clipDurationSeconds).toBe(DEFAULT_CONFIG.clipDurationSeconds);
    expect(c.audioSourceName).toBeNull();
    expect(c.retentionDays).toBeNull();
  });

  it("setClipDuration mutates in memory and validates (no persistence)", () => {
    const store = ConfigStore.fromEnv({ PASSWORD: "x", SESSION_SECRET: "x" });
    store.setClipDuration(45);
    expect(store.value.clipDurationSeconds).toBe(45);
    expect(() => store.setClipDuration(61)).toThrow(); // > max (60)
    expect(() => store.setClipDuration(4)).toThrow(); // < 5
    expect(() => store.setClipDuration(20.5)).toThrow(); // not an integer
  });

  it("setAudioSource mutates in memory, trims, and rejects empty/oversized", () => {
    const store = ConfigStore.fromEnv({ PASSWORD: "x", SESSION_SECRET: "x" });
    store.setAudioSource("  Lateral  ");
    expect(store.value.audioSourceName).toBe("Lateral");
    store.setAudioSource(null);
    expect(store.value.audioSourceName).toBeNull();
    expect(() => store.setAudioSource("   ")).toThrow(); // empty after trim
    expect(() => store.setAudioSource("x".repeat(201))).toThrow(); // oversized
  });

  it("setCapture accepts a known preset (in memory) and rejects anything else", () => {
    const store = ConfigStore.fromEnv({ PASSWORD: "x", SESSION_SECRET: "x" });
    store.setCapture(1280, 720, 30); // a real preset
    expect(store.value.captureWidth).toBe(1280);
    expect(store.value.captureHeight).toBe(720);
    expect(store.value.captureFps).toBe(30);
    expect(() => store.setCapture(1234, 567, 60)).toThrow(); // not a preset resolution
    expect(() => store.setCapture(1280, 720, 999)).toThrow(); // preset size, unsupported fps
  });
});
