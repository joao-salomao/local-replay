import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUFFER_MARGIN_SECONDS } from "@shared/buffer-window";
import { isCapturePreset } from "@shared/capture-presets";

/**
 * Server configuration. Static settings (the required secrets, size/retention limits, target output)
 * come from environment variables (see `.env.example`). The runtime-adjustable settings — the ones
 * the control page can change live — additionally PERSIST to `<DATA_DIR>/config.json`: the env value
 * is only the first-run default, and once a value is changed live it survives restarts (the file
 * wins over the env). `PASSWORD` and `SESSION_SECRET` are required (the server refuses to boot
 * without them) and are never written to that file — they stay env-only.
 */

export type Config = {
  password: string;
  /** HMAC secret used to sign session cookies (`auth.ts`). Required like `password`: keeping it
   * stable across restarts is what keeps existing sessions valid, so set a fixed value in `.env`. */
  sessionSecret: string;
  /** Current per-clip capture window, seconds. First-run default from `CLIP_DURATION_SECONDS`;
   * changed live via the control page and persisted to `config.json`. */
  clipDurationSeconds: number;
  /** Upper bound accepted by `setClipDuration`. */
  clipDurationMaxSeconds: number;
  /** Floor for the camera's recording cycle length, seconds — see `buffer-window.ts#cycleSeconds`. */
  bufferCycleMinSeconds: number;
  /** Extra seconds the cameras buffer BEYOND `clipDurationSeconds` (`buffer-window.ts#cycleSeconds`)
   * — the safety slack `computeCutWindow` reaches into to recover MediaRecorder rotation gaps.
   * First-run default from `BUFFER_MARGIN_SECONDS`; changed live and persisted. */
  bufferMarginSeconds: number;
  /** How long the server waits (seconds) for cameras to finish uploading a triggered clip before
   * finalizing it with whatever arrived (`clip-job.ts`). Raise it for slow/flaky Wi‑Fi so a lagging
   * camera's angle still makes it in. First-run default from `UPLOAD_TIMEOUT_SECONDS`; persisted. */
  uploadTimeoutSeconds: number;
  /** Display name of the camera whose audio track the simultaneous side-by-side combine uses
   * (`pipeline.ts` maps that angle's audio; the sequential combine keeps each segment's own audio).
   * `null` = automatic: the first angle's audio. First-run default from `AUDIO_SOURCE_NAME`; changed
   * live via the control page and persisted. */
  audioSourceName: string | null;
  targetHeight: number;
  targetFps: number;
  /** Capture resolution/fps the cameras REQUEST from getUserMedia (as `ideal`; the device picks the
   * closest it actually supports). Separate from the target above (the server's normalized output) —
   * lower these to ease weak or overheating phones. First-run default from `CAPTURE_*`; changed live
   * from the control page and persisted (see `setCapture`). */
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  /** Days to keep clips before automatic deletion; `null` disables cleanup entirely. */
  retentionDays: number | null;
};

/** Built-in defaults for every field except the (required) secrets. Also used as test fixtures. */
export const DEFAULT_CONFIG: Omit<Config, "password" | "sessionSecret"> = {
  clipDurationSeconds: 20,
  clipDurationMaxSeconds: 60,
  bufferCycleMinSeconds: 30,
  bufferMarginSeconds: BUFFER_MARGIN_SECONDS,
  uploadTimeoutSeconds: 30,
  audioSourceName: null,
  targetHeight: 1080,
  targetFps: 60,
  captureWidth: 1920,
  captureHeight: 1080,
  captureFps: 60,
  retentionDays: null,
};

/** The subset of `Config` that persists to `config.json` — exactly the fields the control page can
 * change live. Everything else stays env-only. */
type LiveConfig = Pick<
  Config,
  | "clipDurationSeconds"
  | "audioSourceName"
  | "captureWidth"
  | "captureHeight"
  | "captureFps"
  | "bufferMarginSeconds"
  | "uploadTimeoutSeconds"
>;

type Env = Record<string, string | undefined>;

/** Reads an integer-ish env var, falling back to `fallback` when it's unset, blank, or not a finite
 * number (a typo shouldn't crash the boot — only a missing secret does that, in `load`). */
function numEnv(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : fallback;
}

/** Reads `config.json` as a plain object, tolerating every failure mode (missing file, unreadable,
 * invalid JSON, or a non-object payload) by returning `{}` — the caller then falls back to the env
 * defaults field by field. The file is only ever written by our own setters, so this is defensive. */
function readLiveFile(configPath: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Overlays the persisted `config.json` values on top of the env-derived `defaults`, per field: a
 * persisted value wins when present and well-typed, otherwise the env default stands. */
function pickLive(parsed: Record<string, unknown>, defaults: LiveConfig): LiveConfig {
  const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);
  return {
    clipDurationSeconds: num(parsed.clipDurationSeconds, defaults.clipDurationSeconds),
    audioSourceName: pickAudio(parsed, defaults.audioSourceName),
    captureWidth: num(parsed.captureWidth, defaults.captureWidth),
    captureHeight: num(parsed.captureHeight, defaults.captureHeight),
    captureFps: num(parsed.captureFps, defaults.captureFps),
    bufferMarginSeconds: num(parsed.bufferMarginSeconds, defaults.bufferMarginSeconds),
    uploadTimeoutSeconds: num(parsed.uploadTimeoutSeconds, defaults.uploadTimeoutSeconds),
  };
}

/** `audioSourceName` is special — a persisted `null` (automatic) is a real value that must win over
 * an env default, so it's keyed on presence, not truthiness. */
function pickAudio(parsed: Record<string, unknown>, fallback: string | null): string | null {
  if (!("audioSourceName" in parsed)) return fallback;
  return typeof parsed.audioSourceName === "string" ? parsed.audioSourceName : null;
}

/**
 * Holds the live `Config` and knows how to persist the runtime-adjustable fields. The setters below
 * mutate `value` and immediately write `config.json`; everything else is fixed at construction from
 * the environment. Construct via `ConfigStore.load`.
 */
export class ConfigStore {
  private constructor(
    private configPath: string,
    public value: Config,
  ) {}

  /**
   * Builds the config from environment variables merged with the persisted `<dataDir>/config.json`.
   * `PASSWORD` and `SESSION_SECRET` are REQUIRED — the server must never boot with no access password
   * or an unstable cookie secret, so a missing/blank one throws here. Every other variable falls back
   * to `DEFAULT_CONFIG`; the runtime-adjustable fields then take their persisted value (if any) over
   * the env default, so a live change on the control page survives the next restart.
   */
  static load(dataDir: string, env: Env = process.env): ConfigStore {
    const password = env.PASSWORD?.trim();
    if (!password) {
      throw new Error("PASSWORD is required — set it in your .env (see .env.example).");
    }

    const sessionSecret = env.SESSION_SECRET?.trim();
    if (!sessionSecret) {
      throw new Error("SESSION_SECRET is required — set it in your .env (see .env.example).");
    }

    const liveDefaults: LiveConfig = {
      clipDurationSeconds: numEnv(env.CLIP_DURATION_SECONDS, DEFAULT_CONFIG.clipDurationSeconds),
      audioSourceName: env.AUDIO_SOURCE_NAME?.trim() || null,
      captureWidth: numEnv(env.CAPTURE_WIDTH, DEFAULT_CONFIG.captureWidth),
      captureHeight: numEnv(env.CAPTURE_HEIGHT, DEFAULT_CONFIG.captureHeight),
      captureFps: numEnv(env.CAPTURE_FPS, DEFAULT_CONFIG.captureFps),
      bufferMarginSeconds: numEnv(env.BUFFER_MARGIN_SECONDS, DEFAULT_CONFIG.bufferMarginSeconds),
      uploadTimeoutSeconds: numEnv(env.UPLOAD_TIMEOUT_SECONDS, DEFAULT_CONFIG.uploadTimeoutSeconds),
    };
    const configPath = join(dataDir, "config.json");
    const live = pickLive(readLiveFile(configPath), liveDefaults);

    const retention = env.RETENTION_DAYS?.trim();
    return new ConfigStore(configPath, {
      password,
      sessionSecret,
      ...live,
      clipDurationMaxSeconds: numEnv(
        env.CLIP_DURATION_MAX_SECONDS,
        DEFAULT_CONFIG.clipDurationMaxSeconds,
      ),
      bufferCycleMinSeconds: numEnv(
        env.BUFFER_CYCLE_MIN_SECONDS,
        DEFAULT_CONFIG.bufferCycleMinSeconds,
      ),
      targetHeight: numEnv(env.TARGET_HEIGHT, DEFAULT_CONFIG.targetHeight),
      targetFps: numEnv(env.TARGET_FPS, DEFAULT_CONFIG.targetFps),
      retentionDays: retention && Number.isFinite(Number(retention)) ? Number(retention) : null,
    });
  }

  /** Writes the runtime-adjustable fields to `config.json` (pretty-printed). Called by every setter
   * so a live change survives a restart. The secrets are deliberately excluded — they stay env-only. */
  private persist(): void {
    const v = this.value;
    const live: LiveConfig = {
      clipDurationSeconds: v.clipDurationSeconds,
      audioSourceName: v.audioSourceName,
      captureWidth: v.captureWidth,
      captureHeight: v.captureHeight,
      captureFps: v.captureFps,
      bufferMarginSeconds: v.bufferMarginSeconds,
      uploadTimeoutSeconds: v.uploadTimeoutSeconds,
    };
    writeFileSync(this.configPath, `${JSON.stringify(live, null, 2)}\n`);
  }

  /** Applies a new clip duration (integer seconds, 5..clipDurationMaxSeconds) and persists it. */
  setClipDuration(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > this.value.clipDurationMaxSeconds) {
      throw new Error(`invalid clip duration: ${seconds}`);
    }

    this.value.clipDurationSeconds = seconds;
    this.persist();
  }

  /** Selects which camera's audio the side-by-side combine uses, by display name; `null` restores
   * the automatic (first-angle) default. Trims the name; rejects an empty or oversized string. */
  setAudioSource(name: string | null): void {
    if (name === null) {
      this.value.audioSourceName = null;
      this.persist();
      return;
    }

    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200) {
      throw new Error(`invalid audio source: ${name}`);
    }

    this.value.audioSourceName = trimmed;
    this.persist();
  }

  /** Applies a new capture resolution/fps, validated against the predefined presets
   * (`shared/capture-presets.ts`), and persists it. */
  setCapture(width: number, height: number, fps: number): void {
    if (!isCapturePreset(width, height, fps)) {
      throw new Error(`invalid capture preset: ${width}x${height}@${fps}`);
    }
    this.value.captureWidth = width;
    this.value.captureHeight = height;
    this.value.captureFps = fps;
    this.persist();
  }

  /** Applies a new extra-buffer size (integer seconds, 0..60) and persists it. 0 means the camera
   * buffers exactly the clip duration with no slack (see `buffer-window.ts#cycleSeconds`). */
  setBufferMargin(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 60) {
      throw new Error(`invalid buffer margin: ${seconds}`);
    }
    this.value.bufferMarginSeconds = seconds;
    this.persist();
  }

  /** Applies a new upload timeout (integer seconds, 10..300) and persists it — how long the server
   * waits for cameras to finish uploading before finalizing a clip (`clip-job.ts`). */
  setUploadTimeout(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 300) {
      throw new Error(`invalid upload timeout: ${seconds}`);
    }
    this.value.uploadTimeoutSeconds = seconds;
    this.persist();
  }
}
