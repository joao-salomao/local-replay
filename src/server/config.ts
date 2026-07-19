/**
 * Server configuration, sourced entirely from environment variables (see `.env.example`). Nothing
 * is persisted to disk anymore: `PASSWORD` is required (the server refuses to boot without it),
 * every other value falls back to a built-in default, and the two runtime-adjustable settings
 * (`clipDurationSeconds`, `audioSourceName`) start from their env value and can still be changed
 * live via the control page — but that change is in-memory only and resets to the env value on the
 * next restart.
 */

export type Config = {
  password: string;
  /** HMAC secret used to sign session cookies (`auth.ts`). Required like `password`: keeping it
   * stable across restarts is what keeps existing sessions valid, so set a fixed value in `.env`. */
  sessionSecret: string;
  /** Current per-clip capture window, seconds. Initial value from `CLIP_DURATION_SECONDS`; can be
   * changed live via the control page (in-memory only — resets to the env value on restart). */
  clipDurationSeconds: number;
  /** Upper bound accepted by `setClipDuration`. */
  clipDurationMaxSeconds: number;
  /** Floor for the camera's recording cycle length, seconds — see `buffer-window.ts#cycleSeconds`. */
  bufferCycleMinSeconds: number;
  /** Display name of the camera whose audio track the simultaneous side-by-side combine uses
   * (`pipeline.ts` maps that angle's audio; the sequential combine keeps each segment's own audio).
   * `null` = automatic: the first angle's audio. Initial value from `AUDIO_SOURCE_NAME`; can be
   * changed live via the control page (in-memory only, like `clipDurationSeconds`). */
  audioSourceName: string | null;
  targetHeight: number;
  targetFps: number;
  /** Capture resolution/fps the cameras REQUEST from getUserMedia (as `ideal`; the device picks the
   * closest it actually supports). Separate from the target above (the server's normalized output) —
   * lower these to ease weak or overheating phones. */
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  /** Days to keep clips before automatic deletion; `null` disables cleanup entirely. */
  retentionDays: number | null;
};

/** Built-in defaults for every field except the (required) password. Also used as test fixtures. */
export const DEFAULT_CONFIG: Omit<Config, "password" | "sessionSecret"> = {
  clipDurationSeconds: 20,
  clipDurationMaxSeconds: 60,
  bufferCycleMinSeconds: 30,
  audioSourceName: null,
  targetHeight: 1080,
  targetFps: 60,
  captureWidth: 1920,
  captureHeight: 1080,
  captureFps: 60,
  retentionDays: null,
};

type Env = Record<string, string | undefined>;

/** Reads an integer-ish env var, falling back to `fallback` when it's unset, blank, or not a finite
 * number (a typo shouldn't crash the boot — only a missing PASSWORD does that, in `fromEnv`). */
function numEnv(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Holds the live `Config`. The two runtime-adjustable fields (`clipDurationSeconds`,
 * `audioSourceName`) can be mutated via the setters below; everything else is fixed at construction
 * from the environment. Construct via `ConfigStore.fromEnv`.
 */
export class ConfigStore {
  private constructor(public value: Config) {}

  /**
   * Builds the config from environment variables (defaulting to `process.env`; a custom map can be
   * passed in tests). `PASSWORD` is REQUIRED: the server must never boot with no access password,
   * so a missing/blank one throws here rather than silently leaving the system open. Every other
   * variable falls back to `DEFAULT_CONFIG`, and an unparseable numeric falls back to its default.
   */
  static fromEnv(env: Env = process.env): ConfigStore {
    const password = env.PASSWORD?.trim();
    if (!password) {
      throw new Error("PASSWORD is required — set it in your .env (see .env.example).");
    }

    const sessionSecret = env.SESSION_SECRET?.trim();
    if (!sessionSecret) {
      throw new Error("SESSION_SECRET is required — set it in your .env (see .env.example).");
    }

    const retention = env.RETENTION_DAYS?.trim();
    return new ConfigStore({
      password,
      sessionSecret,
      clipDurationSeconds: numEnv(env.CLIP_DURATION_SECONDS, DEFAULT_CONFIG.clipDurationSeconds),
      clipDurationMaxSeconds: numEnv(
        env.CLIP_DURATION_MAX_SECONDS,
        DEFAULT_CONFIG.clipDurationMaxSeconds,
      ),
      bufferCycleMinSeconds: numEnv(
        env.BUFFER_CYCLE_MIN_SECONDS,
        DEFAULT_CONFIG.bufferCycleMinSeconds,
      ),
      audioSourceName: env.AUDIO_SOURCE_NAME?.trim() || null,
      targetHeight: numEnv(env.TARGET_HEIGHT, DEFAULT_CONFIG.targetHeight),
      targetFps: numEnv(env.TARGET_FPS, DEFAULT_CONFIG.targetFps),
      captureWidth: numEnv(env.CAPTURE_WIDTH, DEFAULT_CONFIG.captureWidth),
      captureHeight: numEnv(env.CAPTURE_HEIGHT, DEFAULT_CONFIG.captureHeight),
      captureFps: numEnv(env.CAPTURE_FPS, DEFAULT_CONFIG.captureFps),
      retentionDays: retention && Number.isFinite(Number(retention)) ? Number(retention) : null,
    });
  }

  /** Applies a new clip duration (integer seconds, 5..clipDurationMaxSeconds). In-memory only —
   * there's no config file anymore, so it resets to `CLIP_DURATION_SECONDS` on the next restart. */
  setClipDuration(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > this.value.clipDurationMaxSeconds) {
      throw new Error(`invalid clip duration: ${seconds}`);
    }

    this.value.clipDurationSeconds = seconds;
  }

  /** Selects which camera's audio the side-by-side combine uses, by display name; `null` restores
   * the automatic (first-angle) default. In-memory only (see `setClipDuration`). Trims the name;
   * rejects an empty or oversized string. */
  setAudioSource(name: string | null): void {
    if (name === null) {
      this.value.audioSourceName = null;
      return;
    }

    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200) {
      throw new Error(`invalid audio source: ${name}`);
    }

    this.value.audioSourceName = trimmed;
  }
}
