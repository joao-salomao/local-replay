import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, DEFAULT_CONFIG } from "@server/config";

const freshDir = () => mkdtempSync(join(tmpdir(), "replay-cfg-"));
const secrets = { PASSWORD: "x", SESSION_SECRET: "x" };

describe("ConfigStore.load", () => {
  it("throws when PASSWORD or SESSION_SECRET is unset or blank (both are required to boot)", () => {
    const dir = freshDir();
    expect(() => ConfigStore.load(dir, {})).toThrow(); // no PASSWORD
    expect(() => ConfigStore.load(dir, { PASSWORD: "   " })).toThrow(); // blank PASSWORD
    expect(() => ConfigStore.load(dir, { PASSWORD: "p" })).toThrow(); // no SESSION_SECRET
    expect(() => ConfigStore.load(dir, { PASSWORD: "p", SESSION_SECRET: "  " })).toThrow(); // blank
  });

  it("uses defaults for everything but the required secrets when nothing else is set", () => {
    const c = ConfigStore.load(freshDir(), { PASSWORD: "secret", SESSION_SECRET: "sess" }).value;
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
    expect(c.bufferMarginSeconds).toBe(DEFAULT_CONFIG.bufferMarginSeconds);
    expect(c.uploadTimeoutSeconds).toBe(DEFAULT_CONFIG.uploadTimeoutSeconds);
    expect(c.retentionDays).toBeNull();
  });

  it("reads and trims the static (non-UI) settings from the environment", () => {
    const c = ConfigStore.load(freshDir(), {
      PASSWORD: "  secret  ",
      SESSION_SECRET: "  sess  ",
      CLIP_DURATION_MAX_SECONDS: "90",
      BUFFER_CYCLE_MIN_SECONDS: "45",
      TARGET_HEIGHT: "720",
      TARGET_FPS: "30",
      RETENTION_DAYS: "14",
    }).value;
    expect(c.password).toBe("secret");
    expect(c.sessionSecret).toBe("sess");
    expect(c.clipDurationMaxSeconds).toBe(90);
    expect(c.bufferCycleMinSeconds).toBe(45);
    expect(c.targetHeight).toBe(720);
    expect(c.targetFps).toBe(30);
    expect(c.retentionDays).toBe(14);
  });

  it("ignores env vars for the UI-managed settings — they default in code, config.json then wins", () => {
    // These settings are managed on /control and persisted to config.json; there's deliberately no
    // env for any of them, so setting one has no effect — the built-in DEFAULT_CONFIG value stands.
    const c = ConfigStore.load(freshDir(), {
      ...secrets,
      CLIP_DURATION_SECONDS: "30",
      AUDIO_SOURCE_NAME: "Fundo",
      CAPTURE_WIDTH: "1280",
      CAPTURE_HEIGHT: "720",
      CAPTURE_FPS: "24",
      BUFFER_MARGIN_SECONDS: "8",
      UPLOAD_TIMEOUT_SECONDS: "45",
    }).value;
    expect(c.clipDurationSeconds).toBe(DEFAULT_CONFIG.clipDurationSeconds);
    expect(c.audioSourceName).toBe(DEFAULT_CONFIG.audioSourceName);
    expect(c.captureWidth).toBe(DEFAULT_CONFIG.captureWidth);
    expect(c.captureHeight).toBe(DEFAULT_CONFIG.captureHeight);
    expect(c.captureFps).toBe(DEFAULT_CONFIG.captureFps);
    expect(c.bufferMarginSeconds).toBe(DEFAULT_CONFIG.bufferMarginSeconds);
    expect(c.uploadTimeoutSeconds).toBe(DEFAULT_CONFIG.uploadTimeoutSeconds);
  });

  it("falls back to defaults on unparseable static numerics and treats a bad retention as null", () => {
    const c = ConfigStore.load(freshDir(), {
      ...secrets,
      CLIP_DURATION_MAX_SECONDS: "abc", // invalid -> default
      RETENTION_DAYS: "not-a-number", // invalid -> null (keep forever)
    }).value;
    expect(c.clipDurationMaxSeconds).toBe(DEFAULT_CONFIG.clipDurationMaxSeconds);
    expect(c.retentionDays).toBeNull();
  });

  it("setClipDuration mutates, validates, and persists across a reload (over the code default)", () => {
    const dir = freshDir();
    const store = ConfigStore.load(dir, secrets);
    store.setClipDuration(45);
    expect(store.value.clipDurationSeconds).toBe(45);
    expect(() => store.setClipDuration(61)).toThrow(); // > max (60)
    expect(() => store.setClipDuration(4)).toThrow(); // < 5
    expect(() => store.setClipDuration(20.5)).toThrow(); // not an integer
    // Persisted: a fresh load from the same dir returns 45, overriding the code default (20).
    expect(ConfigStore.load(dir, secrets).value.clipDurationSeconds).toBe(45);
  });

  it("setAudioSource mutates, trims, rejects empty/oversized, and persists (string and null)", () => {
    const dir = freshDir();
    const store = ConfigStore.load(dir, secrets);
    store.setAudioSource("  Lateral  ");
    expect(store.value.audioSourceName).toBe("Lateral");
    expect(ConfigStore.load(dir, secrets).value.audioSourceName).toBe("Lateral"); // string persisted
    expect(() => store.setAudioSource("   ")).toThrow(); // empty after trim
    expect(() => store.setAudioSource("x".repeat(201))).toThrow(); // oversized
    store.setAudioSource(null);
    expect(store.value.audioSourceName).toBeNull();
    // A persisted null (automatic) is read back as null, not treated as an absent key.
    expect(ConfigStore.load(dir, secrets).value.audioSourceName).toBeNull();
  });

  it("setCapture accepts a known preset, rejects anything else, and persists", () => {
    const dir = freshDir();
    const store = ConfigStore.load(dir, secrets);
    store.setCapture(1280, 720, 30); // a real preset
    expect(store.value.captureWidth).toBe(1280);
    expect(store.value.captureHeight).toBe(720);
    expect(store.value.captureFps).toBe(30);
    expect(() => store.setCapture(1234, 567, 60)).toThrow(); // not a preset resolution
    expect(() => store.setCapture(1280, 720, 999)).toThrow(); // preset size, unsupported fps
    const r = ConfigStore.load(dir, secrets).value;
    expect([r.captureWidth, r.captureHeight, r.captureFps]).toEqual([1280, 720, 30]);
  });

  it("setBufferMargin validates 0..60, mutates, and persists", () => {
    const dir = freshDir();
    const store = ConfigStore.load(dir, secrets);
    store.setBufferMargin(12);
    expect(store.value.bufferMarginSeconds).toBe(12);
    store.setBufferMargin(0); // no extra buffer at all is allowed
    expect(store.value.bufferMarginSeconds).toBe(0);
    expect(() => store.setBufferMargin(-1)).toThrow();
    expect(() => store.setBufferMargin(61)).toThrow();
    expect(() => store.setBufferMargin(5.5)).toThrow(); // not an integer
    expect(ConfigStore.load(dir, secrets).value.bufferMarginSeconds).toBe(0);
  });

  it("setUploadTimeout validates 10..300, mutates, and persists", () => {
    const dir = freshDir();
    const store = ConfigStore.load(dir, secrets);
    store.setUploadTimeout(90);
    expect(store.value.uploadTimeoutSeconds).toBe(90);
    expect(() => store.setUploadTimeout(9)).toThrow(); // < 10
    expect(() => store.setUploadTimeout(301)).toThrow(); // > 300
    expect(() => store.setUploadTimeout(45.5)).toThrow(); // not an integer
    expect(ConfigStore.load(dir, secrets).value.uploadTimeoutSeconds).toBe(90);
  });

  it("ignores a corrupt config.json and falls back to the code defaults", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), "{ not valid json");
    const c = ConfigStore.load(dir, secrets).value;
    expect(c.clipDurationSeconds).toBe(DEFAULT_CONFIG.clipDurationSeconds); // file ignored → default
  });
});
