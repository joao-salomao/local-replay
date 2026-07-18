import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persisted, mutable server configuration (`<dataDir>/config.json`), including the plaintext
 * access password — see `ConfigStore.save` for why the file is chmod'd 0600.
 */

export type Layout = "sequential" | "side-by-side";

export type Config = {
  password: string;
  /** Current per-clip capture window, seconds. Changeable at runtime via the control page. */
  clipDurationSeconds: number;
  /** Upper bound accepted by `setClipDuration`. */
  clipDurationMaxSeconds: number;
  /** Floor for the camera's recording cycle length, seconds — see `buffer-window.ts#cycleSeconds`. */
  bufferCycleMinSeconds: number;
  /** Historically selected how multi-camera clips were combined (concatenated one after another,
   * or side-by-side). Currently unused by the combine step itself: `pipeline.ts#processClip` now
   * always produces BOTH a sequential `combined.mp4` and a side-by-side `combined-side-by-side.mp4`
   * whenever ≥2 angles succeed, regardless of this value. Kept as a config field to avoid churn. */
  layout: Layout;
  /** Display name of the camera whose audio track the simultaneous side-by-side combine uses
   * (`pipeline.ts` maps that angle's audio; the sequential combine keeps each segment's own audio).
   * `null` = automatic: the first angle's audio (the historical default). A name that matches no
   * angle in a given clip also falls back to the first angle. Set from the control page. */
  audioSourceName: string | null;
  targetHeight: number;
  targetFps: number;
  /** Days to keep clips before automatic deletion; `null` disables cleanup entirely. */
  retentionDays: number | null;
};

export const DEFAULT_CONFIG: Omit<Config, "password"> = {
  clipDurationSeconds: 20,
  clipDurationMaxSeconds: 60,
  bufferCycleMinSeconds: 30,
  layout: "sequential",
  audioSourceName: null,
  targetHeight: 1080,
  targetFps: 60,
  retentionDays: null,
};

/**
 * Generates the default access password: 6 lowercase alphanumeric characters. `-`/`_` (the
 * base64url-specific characters) are replaced with `x` rather than re-rolled, trading a
 * negligible amount of entropy for a fixed-shape, easy-to-read-aloud-and-type string — this
 * password is meant to be spoken or typed by non-technical players on a phone keyboard.
 */
export function randomPassword(): string {
  return randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 6).toLowerCase();
}

/** Loads, mutates, and persists `Config`. Construct only via `ConfigStore.load`. */
export class ConfigStore {
  private constructor(
    private path: string,
    public value: Config,
  ) {}

  /**
   * Loads `<dataDir>/config.json`, creating it (with a fresh random password and defaults) if
   * absent. On an existing file, merges the persisted values over `DEFAULT_CONFIG` so that
   * fields added in later versions get a sane default even for old config files on disk.
   */
  static load(dataDir: string): ConfigStore {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "config.json");
    if (!existsSync(path)) {
      const store = new ConfigStore(path, { password: randomPassword(), ...DEFAULT_CONFIG });
      store.save();
      return store;
    }
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    return new ConfigStore(path, { password: "", ...DEFAULT_CONFIG, ...raw });
  }

  /** Validates and applies a new clip duration (integer seconds, 5..clipDurationMaxSeconds), then persists. */
  setClipDuration(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > this.value.clipDurationMaxSeconds) {
      throw new Error(`invalid clip duration: ${seconds}`);
    }
    this.value.clipDurationSeconds = seconds;
    this.save();
  }

  /** Selects which camera's audio the side-by-side combine uses, by display name; `null` restores
   * the automatic (first-angle) default. Trims the name; rejects an empty or oversized string. */
  setAudioSource(name: string | null): void {
    if (name === null) {
      this.value.audioSourceName = null;
    } else {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 200) throw new Error(`invalid audio source: ${name}`);
      this.value.audioSourceName = trimmed;
    }
    this.save();
  }

  /** Persists the current value. chmod 0600: config.json holds the plaintext access password. */
  save(): void {
    writeFileSync(this.path, JSON.stringify(this.value, null, 2));
    chmodSync(this.path, 0o600);
  }
}
