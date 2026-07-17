import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type Layout = "sequential" | "side-by-side";

export type Config = {
  password: string;
  clipDurationSeconds: number;
  clipDurationMaxSeconds: number;
  bufferCycleMinSeconds: number;
  layout: Layout;
  targetHeight: number;
  targetFps: number;
  retentionDays: number | null;
};

export const DEFAULT_CONFIG: Omit<Config, "password"> = {
  clipDurationSeconds: 20,
  clipDurationMaxSeconds: 60,
  bufferCycleMinSeconds: 30,
  layout: "sequential",
  targetHeight: 1080,
  targetFps: 60,
  retentionDays: null,
};

export function randomPassword(): string {
  return randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 6).toLowerCase();
}

export class ConfigStore {
  private constructor(
    private path: string,
    public value: Config,
  ) {}

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

  setClipDuration(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > this.value.clipDurationMaxSeconds) {
      throw new Error(`invalid clip duration: ${seconds}`);
    }
    this.value.clipDurationSeconds = seconds;
    this.save();
  }

  save(): void {
    writeFileSync(this.path, JSON.stringify(this.value, null, 2));
  }
}
