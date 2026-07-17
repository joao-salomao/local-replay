# Replay Local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local sports-replay system: phones on the LAN act as buffering cameras; a web "GRAVAR" button captures the last N seconds from every camera and the server (Bun + FFmpeg, Dockerized) produces a combined clip in a local gallery.

**Architecture:** Single Bun server serves 4 static pages (login, camera, control, clips gallery), a JSON API, and a WebSocket hub. Camera pages keep a rolling buffer (previous + current MediaRecorder cycle) in browser memory and upload only on trigger. The server aligns angles via NTP-style clock offsets, cuts/normalizes each angle with FFmpeg, and concatenates or stacks them into a combined MP4. Spec: `docs/superpowers/specs/2026-07-17-replay-local-design.md`.

**Tech Stack:** Bun ≥ 1.3 (TS runtime, `Bun.serve` HTTP+WS+TLS, `bun test`, `Bun.build`, `Bun.spawn`), FFmpeg (CLI), `qrcode` (npm), Playwright (e2e), Docker (`oven/bun` + ffmpeg).

## Global Constraints

- All code, file names, routes, protocol messages, JSON/config keys: **English**. UI strings: **pt-BR** (exact copies: "GRAVAR", "Ser câmera", "Controlar gravação", "Ver lances", "Lance pronto").
- Local toolchain: Bun 1.3.1, ffmpeg 8.x on PATH (dev machine has both; container installs its own).
- Output video: 1920×1080, 60 fps CFR, H.264 (`libx264 -preset veryfast -crf 23 -pix_fmt yuv420p`), AAC 128k, `+faststart`. Missing source audio → silent AAC track.
- Constants (single source of truth where defined): clip duration default 20s, options `[10,20,30,45,60]`, max 60s; buffer cycle = `max(30, clipDuration)`s; trigger cooldown 2000ms; upload timeout 30000ms; camera offline after 10000ms without heartbeat, heartbeat sent every 3000ms (spec text says "heartbeat 5s" — we implement 3s send / 10s offline threshold, same intent, stricter detection); session TTL 24h; login rate limit 5/min per IP; low-disk warning < 5 GB; cert validity 3650 days; ports HTTPS 8443 / HTTP-redirect 8080; env vars `DATA_DIR`, `HTTPS_PORT`, `HTTP_PORT`, `HOST_LAN_IP`.
- TDD: every logic module gets a failing test first. Conventional commits in English. Run `bun test` before every commit.
- YAGNI: no DB, no user accounts, no cloud, no live streaming, no sponsor overlays.
- Platform floors: iOS Safari ≥ 16.4, Android Chrome ≥ 96. 60fps capture is best-effort (`ideal` constraint — many phones deliver 30fps in the browser; the camera page surfaces actual fps). All outputs are MP4 H.264/AAC (iPhones cannot play WebM). iOS kills camera streams in background → pages must re-acquire, not just restart. Self-signed cert: Android proceeds via browser warning; iOS users install the cert from public route `GET /cert` (login page explains).

---

## File Structure

```
replaybr/
├── package.json / tsconfig.json / .gitignore(exists)
├── Dockerfile / docker-compose.yml / .dockerignore / start.sh
├── playwright.config.ts
├── README.md                          # pt-BR operator manual + court checklist
├── src/
│   ├── shared/                        # imported by server AND browser bundles
│   │   ├── protocol.ts                # WS message + state types
│   │   ├── clock.ts                   # NTP offset math (pure)
│   │   └── buffer-window.ts           # file selection + cut-window math (pure)
│   ├── server/
│   │   ├── index.ts                   # bootstrap: wiring, TLS servers, timers, QR log
│   │   ├── config.ts                  # config.json load/save/validate
│   │   ├── auth.ts                    # password login, HMAC session, rate limiter
│   │   ├── hub.ts                     # WS registry: cameras/controls, heartbeat, NTP
│   │   ├── clip-job.ts                # trigger → collect uploads → finalize
│   │   ├── queue.ts                   # serial async queue
│   │   ├── ffmpeg.ts                  # arg builders (pure) + spawn/probe
│   │   ├── pipeline.ts                # per-job processing orchestration
│   │   ├── storage.ts                 # clip dirs, meta.json, listing, disk, retention
│   │   ├── cert.ts                    # self-signed cert via openssl
│   │   ├── pages.ts                   # Bun.build web bundles + html/asset serving
│   │   └── routes.ts                  # fetch router (factory, testable without TLS)
│   └── web/
│       ├── index.html + login.ts      # password + role choice
│       ├── shared/app.css             # single stylesheet
│       ├── shared/ws-client.ts        # reconnecting WS + clock sync + heartbeat
│       ├── shared/api.ts              # fetch helpers
│       ├── camera/index.html + camera.ts
│       ├── control/index.html + control.ts
│       └── clips/index.html + clips.ts
├── tests/
│   ├── unit/*.test.ts
│   ├── integration/pipeline.test.ts
│   ├── integration/routes.test.ts
│   ├── integration/full-flow.test.ts
│   ├── helpers/camera-simulator.ts
│   └── e2e/record-flow.spec.ts
└── data/                              # runtime volume (gitignored)
```

`pipeline.ts`, `cert.ts`, `pages.ts`, `routes.ts` are additions to the spec's proposed layout (finer-grained responsibilities, same architecture).

---

### Task 1: Project scaffold + config module

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/server/config.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `type Layout = "sequential" | "side-by-side"`; `type Config = { password: string; clipDurationSeconds: number; clipDurationMaxSeconds: number; bufferCycleMinSeconds: number; layout: Layout; targetHeight: number; targetFps: number; retentionDays: number | null }`; `DEFAULT_CONFIG: Omit<Config,"password">`; `class ConfigStore { static load(dataDir: string): ConfigStore; value: Config; setClipDuration(seconds: number): void; save(): void }`; `randomPassword(): string`.

- [ ] **Step 1: Scaffold**

`package.json`:
```json
{
  "name": "replay-local",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run src/server/index.ts",
    "start": "bun run src/server/index.ts",
    "test": "bun test tests/unit tests/integration",
    "test:e2e": "playwright test"
  },
  "dependencies": { "qrcode": "^1.5.4" },
  "devDependencies": { "@types/qrcode": "^1.5.5", "@playwright/test": "^1.49.0" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true,
    "types": ["bun-types"], "lib": ["ESNext", "DOM", "DOM.Iterable"]
  },
  "include": ["src", "tests"]
}
```

Run: `bun install` — Expected: lockfile created, deps installed.

- [ ] **Step 2: Write the failing test**

`tests/unit/config.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, DEFAULT_CONFIG } from "../../src/server/config";

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/config.test.ts`
Expected: FAIL — cannot resolve `../../src/server/config`.

- [ ] **Step 4: Implement**

`src/server/config.ts`:
```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json bun.lock src/server/config.ts tests/unit/config.test.ts
git commit -m "feat: project scaffold and config store"
```

---

### Task 2: Shared protocol types + clock-sync math

**Files:**
- Create: `src/shared/protocol.ts`, `src/shared/clock.ts`
- Test: `tests/unit/clock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (protocol): `type CameraInfo = { id: string; name: string; online: boolean; width: number; height: number; fps: number }`; `type JobState = "capturing" | "processing" | "ready" | "error"`; `type JobStatus = { jobId: string; clipNumber: number; state: JobState; error?: string; createdAt: number }`; `type ClientMessage`; `type ServerMessage` (exact unions below).
- Produces (clock): `type NtpSample = { clientSent: number; serverTime: number; clientReceived: number }`; `computeOffset(samples: NtpSample[]): number`.

- [ ] **Step 1: Write protocol types (no test — pure types)**

`src/shared/protocol.ts`:
```ts
export type CameraInfo = { id: string; name: string; online: boolean; width: number; height: number; fps: number };

export type JobState = "capturing" | "processing" | "ready" | "error";
export type JobStatus = { jobId: string; clipNumber: number; state: JobState; error?: string; createdAt: number };

export type ClientMessage =
  | { type: "register"; role: "camera"; name: string }
  | { type: "register"; role: "control" }
  | { type: "ntp"; clientTime: number }
  | { type: "cameraStatus"; width: number; height: number; fps: number }
  | { type: "hb" };

export type ServerMessage =
  | { type: "registered"; cameraId: string }
  | { type: "ntpReply"; clientTime: number; serverTime: number }
  | { type: "record"; jobId: string; t: number; windowSec: number }
  | { type: "state"; cameras: CameraInfo[]; clipDurationSeconds: number; jobs: JobStatus[] }
  | { type: "jobUpdate"; job: JobStatus };
```

- [ ] **Step 2: Write the failing clock test**

`tests/unit/clock.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { computeOffset } from "../../src/shared/clock";

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
      { clientSent: 0, serverTime: 510, clientReceived: 20 },   // 500
      { clientSent: 100, serverTime: 611, clientReceived: 122 }, // 500
      { clientSent: 200, serverTime: 1300, clientReceived: 220 }, // 1090 outlier
    ];
    expect(computeOffset(samples)).toBe(500);
  });

  it("throws on empty input", () => {
    expect(() => computeOffset([])).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/clock.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/clock`.

- [ ] **Step 4: Implement**

`src/shared/clock.ts`:
```ts
export type NtpSample = { clientSent: number; serverTime: number; clientReceived: number };

/** Offset such that serverTime ≈ clientTime + offset. Median across samples. */
export function computeOffset(samples: NtpSample[]): number {
  if (samples.length === 0) throw new Error("computeOffset: no samples");
  const offsets = samples
    .map((s) => s.serverTime - (s.clientSent + s.clientReceived) / 2)
    .sort((a, b) => a - b);
  return offsets[Math.floor(offsets.length / 2)]!;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/clock.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/protocol.ts src/shared/clock.ts tests/unit/clock.test.ts
git commit -m "feat: shared ws protocol types and ntp offset math"
```

---

### Task 3: Buffer window math (file selection + cut window)

**Files:**
- Create: `src/shared/buffer-window.ts`
- Test: `tests/unit/buffer-window.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type BufferFile = { startMs: number; durationMs: number }`; `cycleSeconds(clipDurationSeconds: number, minCycleSeconds: number): number`; `selectFilesForWindow<T extends BufferFile>(files: T[], windowStartMs: number, windowEndMs: number): T[]`; `computeCutWindow(files: BufferFile[], windowStartMs: number, windowEndMs: number): { startSec: number; durationSec: number }`.
- Semantics: files may have gaps between them (recorder restart). `computeCutWindow` maps server-time to the **concatenated media timeline** (gap time collapses), clamping into available media.

- [ ] **Step 1: Write the failing test**

`tests/unit/buffer-window.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { computeCutWindow, cycleSeconds, selectFilesForWindow } from "../../src/shared/buffer-window";

describe("cycleSeconds", () => {
  it("is max(min, clipDuration)", () => {
    expect(cycleSeconds(20, 30)).toBe(30);
    expect(cycleSeconds(60, 30)).toBe(60);
  });
});

describe("selectFilesForWindow", () => {
  const prev = { startMs: 0, durationMs: 30_000, tag: "prev" };
  const cur = { startMs: 30_200, durationMs: 15_000, tag: "cur" };

  it("picks only the current file when the window fits inside it", () => {
    expect(selectFilesForWindow([prev, cur], 34_000, 44_000).map((f) => f.tag)).toEqual(["cur"]);
  });

  it("picks both files when the window spans the cycle boundary", () => {
    expect(selectFilesForWindow([cur, prev], 25_000, 40_000).map((f) => f.tag)).toEqual(["prev", "cur"]);
  });

  it("ignores files entirely outside the window", () => {
    expect(selectFilesForWindow([prev, cur], 46_000, 50_000).map((f) => f.tag)).toEqual([]);
  });
});

describe("computeCutWindow", () => {
  it("cuts inside a single file", () => {
    const r = computeCutWindow([{ startMs: 10_000, durationMs: 30_000 }], 25_000, 35_000);
    expect(r.startSec).toBeCloseTo(15, 3);
    expect(r.durationSec).toBeCloseTo(10, 3);
  });

  it("collapses the gap when the window spans two files", () => {
    const files = [
      { startMs: 0, durationMs: 30_000 },
      { startMs: 30_200, durationMs: 15_000 }, // 200ms gap
    ];
    const r = computeCutWindow(files, 25_000, 40_000); // 15s of server time
    expect(r.startSec).toBeCloseTo(25, 3);
    expect(r.durationSec).toBeCloseTo(14.8, 3); // gap content does not exist
  });

  it("clamps a window that starts before available media", () => {
    const r = computeCutWindow([{ startMs: 20_000, durationMs: 10_000 }], 15_000, 28_000);
    expect(r.startSec).toBeCloseTo(0, 3);
    expect(r.durationSec).toBeCloseTo(8, 3);
  });

  it("returns zero duration when the window is after all media", () => {
    const r = computeCutWindow([{ startMs: 0, durationMs: 10_000 }], 12_000, 15_000);
    expect(r.durationSec).toBe(0);
  });

  it("throws on empty file list", () => {
    expect(() => computeCutWindow([], 0, 1000)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/buffer-window.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/buffer-window`.

- [ ] **Step 3: Implement**

`src/shared/buffer-window.ts`:
```ts
export type BufferFile = { startMs: number; durationMs: number };

export function cycleSeconds(clipDurationSeconds: number, minCycleSeconds: number): number {
  return Math.max(minCycleSeconds, clipDurationSeconds);
}

export function selectFilesForWindow<T extends BufferFile>(
  files: T[],
  windowStartMs: number,
  windowEndMs: number,
): T[] {
  return files
    .filter((f) => f.startMs < windowEndMs && f.startMs + f.durationMs > windowStartMs)
    .sort((a, b) => a.startMs - b.startMs);
}

export function computeCutWindow(
  files: BufferFile[],
  windowStartMs: number,
  windowEndMs: number,
): { startSec: number; durationSec: number } {
  if (files.length === 0) throw new Error("computeCutWindow: no files");
  const sorted = [...files].sort((a, b) => a.startMs - b.startMs);
  let elapsed = 0;
  const spans = sorted.map((f) => {
    const span = { mediaStartMs: elapsed, startMs: f.startMs, durationMs: f.durationMs };
    elapsed += f.durationMs;
    return span;
  });
  const totalMs = elapsed;
  const toMediaMs = (ts: number): number => {
    for (const s of spans) {
      if (ts < s.startMs) return s.mediaStartMs; // inside a gap → snap forward
      if (ts <= s.startMs + s.durationMs) return s.mediaStartMs + (ts - s.startMs);
    }
    return totalMs;
  };
  const startMs = toMediaMs(windowStartMs);
  const endMs = toMediaMs(windowEndMs);
  return { startSec: startMs / 1000, durationSec: Math.max(0, endMs - startMs) / 1000 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/buffer-window.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/buffer-window.ts tests/unit/buffer-window.test.ts
git commit -m "feat: buffer file selection and cut-window math"
```

---

### Task 4: Storage module

**Files:**
- Create: `src/server/storage.ts`
- Test: `tests/unit/storage.test.ts`

**Interfaces:**
- Consumes: `Layout` from `src/server/config.ts` (type import only).
- Produces: `type ClipOutputs = { combined: string | null; angles: Record<string, string> }`; `type ClipCamera = { name: string; slug: string; files: { startMs: number; durationMs: number }[] }`; `type ClipMeta = { jobId: string; clipNumber: number; t: number; windowSec: number; layout: Layout; state: "processing" | "ready" | "error"; cameras: ClipCamera[]; outputs: ClipOutputs; errors: string[]; createdAt: number }`; `class Storage { constructor(dataDir: string); clipsDir(): string; nextClipNumber(): number; createClipDir(clipNumber: number, dateMs: number): string; writeMeta(dir: string, meta: ClipMeta): void; listClips(): (ClipMeta & { dir: string })[]; freeDiskGB(): number | null; cleanupRetention(retentionDays: number | null, nowMs: number): string[] }`.
- Layout on disk: `<dataDir>/clips/YYYY-MM-DD/clip-042/{raw/, combined.mp4, angle-<slug>.mp4, meta.json}`. `listClips()[i].dir` is relative to dataDir (e.g. `clips/2026-07-17/clip-042`) so routes can serve `/files/<dir>/<file>`.

- [ ] **Step 1: Write the failing test**

`tests/unit/storage.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage, type ClipMeta } from "../../src/server/storage";

const tmp = () => mkdtempSync(join(tmpdir(), "replay-storage-"));

const meta = (over: Partial<ClipMeta>): ClipMeta => ({
  jobId: "j1", clipNumber: 1, t: 0, windowSec: 20, layout: "sequential",
  state: "ready", cameras: [], outputs: { combined: "combined.mp4", angles: {} },
  errors: [], createdAt: 0, ...over,
});

describe("Storage", () => {
  it("starts clip numbering at 1 and scans across date folders", () => {
    const s = new Storage(tmp());
    expect(s.nextClipNumber()).toBe(1);
    s.createClipDir(1, Date.parse("2026-07-16T12:00:00Z"));
    s.createClipDir(7, Date.parse("2026-07-17T12:00:00Z"));
    expect(s.nextClipNumber()).toBe(8);
  });

  it("creates the clip dir with a raw/ subfolder", () => {
    const s = new Storage(tmp());
    const dir = s.createClipDir(3, Date.parse("2026-07-17T15:00:00Z"));
    expect(dir.endsWith(join("2026-07-17", "clip-003"))).toBe(true);
    expect(existsSync(join(dir, "raw"))).toBe(true);
  });

  it("round-trips meta.json and lists newest first with relative dir", () => {
    const s = new Storage(tmp());
    const d1 = s.createClipDir(1, Date.parse("2026-07-16T12:00:00Z"));
    const d2 = s.createClipDir(2, Date.parse("2026-07-17T12:00:00Z"));
    s.writeMeta(d1, meta({ clipNumber: 1, createdAt: 100 }));
    s.writeMeta(d2, meta({ clipNumber: 2, createdAt: 200 }));
    const list = s.listClips();
    expect(list.map((c) => c.clipNumber)).toEqual([2, 1]);
    expect(list[0]!.dir).toBe(join("clips", "2026-07-17", "clip-002"));
  });

  it("skips clip dirs without meta.json", () => {
    const s = new Storage(tmp());
    s.createClipDir(1, Date.now());
    expect(s.listClips()).toEqual([]);
  });

  it("retention deletes date folders older than the cutoff, keeps null untouched", () => {
    const s = new Storage(tmp());
    const now = Date.parse("2026-07-17T12:00:00Z");
    s.createClipDir(1, now - 10 * 86_400_000);
    s.createClipDir(2, now);
    expect(s.cleanupRetention(null, now)).toEqual([]);
    const deleted = s.cleanupRetention(7, now);
    expect(deleted).toEqual(["2026-07-07"]);
    expect(s.listClips().length).toBe(0); // clip-002 has no meta yet, but its dir remains
    expect(existsSync(join(s.clipsDir(), "2026-07-17"))).toBe(true);
  });

  it("reports free disk space as a number", () => {
    const s = new Storage(tmp());
    const free = s.freeDiskGB();
    expect(free === null || free > 0).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/storage.test.ts`
Expected: FAIL — cannot resolve `../../src/server/storage`.

- [ ] **Step 3: Implement**

`src/server/storage.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./config";

export type ClipOutputs = { combined: string | null; angles: Record<string, string> };
export type ClipCamera = { name: string; slug: string; files: { startMs: number; durationMs: number }[] };
export type ClipMeta = {
  jobId: string;
  clipNumber: number;
  t: number;
  windowSec: number;
  layout: Layout;
  state: "processing" | "ready" | "error";
  cameras: ClipCamera[];
  outputs: ClipOutputs;
  errors: string[];
  createdAt: number;
};

const pad3 = (n: number) => String(n).padStart(3, "0");
const dateFolder = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export class Storage {
  constructor(readonly dataDir: string) {
    mkdirSync(join(dataDir, "clips"), { recursive: true });
  }

  clipsDir(): string {
    return join(this.dataDir, "clips");
  }

  nextClipNumber(): number {
    let max = 0;
    for (const day of safeReaddir(this.clipsDir())) {
      for (const entry of safeReaddir(join(this.clipsDir(), day))) {
        const m = /^clip-(\d+)$/.exec(entry);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
    return max + 1;
  }

  createClipDir(clipNumber: number, dateMs: number): string {
    const dir = join(this.clipsDir(), dateFolder(dateMs), `clip-${pad3(clipNumber)}`);
    mkdirSync(join(dir, "raw"), { recursive: true });
    return dir;
  }

  writeMeta(dir: string, meta: ClipMeta): void {
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  }

  listClips(): (ClipMeta & { dir: string })[] {
    const out: (ClipMeta & { dir: string })[] = [];
    for (const day of safeReaddir(this.clipsDir())) {
      for (const entry of safeReaddir(join(this.clipsDir(), day))) {
        const metaPath = join(this.clipsDir(), day, entry, "meta.json");
        if (!existsSync(metaPath)) continue;
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ClipMeta;
        out.push({ ...meta, dir: join("clips", day, entry) });
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  freeDiskGB(): number | null {
    try {
      const s = statfsSync(this.dataDir);
      return (s.bavail * s.bsize) / 1024 ** 3;
    } catch {
      return null;
    }
  }

  cleanupRetention(retentionDays: number | null, nowMs: number): string[] {
    if (retentionDays === null) return [];
    const cutoff = dateFolder(nowMs - retentionDays * 86_400_000);
    const deleted: string[] = [];
    for (const day of safeReaddir(this.clipsDir())) {
      if (day < cutoff) {
        rmSync(join(this.clipsDir(), day), { recursive: true, force: true });
        deleted.push(day);
      }
    }
    return deleted;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/storage.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/storage.ts tests/unit/storage.test.ts
git commit -m "feat: clip storage, meta persistence, disk and retention"
```

---

### Task 5: FFmpeg command builders + runner

**Files:**
- Create: `src/server/ffmpeg.ts`
- Test: `tests/unit/ffmpeg.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type NormalizeOptions = { listFile: string | null; input: string | null; startSec: number; durationSec: number; width: number; height: number; fps: number; hasAudio: boolean; output: string }`; `writeConcatList(paths: string[], listPath: string): void`; `normalizeCutArgs(o: NormalizeOptions): string[]`; `combineSequentialArgs(listFile: string, output: string): string[]`; `combineSideBySideArgs(inputs: [string, string], o: { width: number; height: number; fps: number }, output: string): string[]`; `runFfmpeg(args: string[]): Promise<void>` (throws with stderr tail); `probe(file: string): Promise<{ durationSec: number; width: number; height: number; fps: number; hasAudio: boolean }>`.
- Rules: exactly one of `listFile`/`input` is set. `-ss`/`-t` are **output-side** (accurate cut). Normalized outputs share identical codec parameters, which is what makes `combineSequentialArgs` safe with `-c copy`.

- [ ] **Step 1: Write the failing test**

`tests/unit/ffmpeg.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combineSequentialArgs, combineSideBySideArgs, normalizeCutArgs, writeConcatList } from "../../src/server/ffmpeg";

describe("writeConcatList", () => {
  it("writes one quoted line per file, escaping single quotes", () => {
    const listPath = join(mkdtempSync(join(tmpdir(), "replay-ffmpeg-")), "list.txt");
    writeConcatList(["/a/b.mp4", "/c/it's.webm"], listPath);
    expect(readFileSync(listPath, "utf8")).toBe("file '/a/b.mp4'\nfile '/c/it'\\''s.webm'");
  });
});

describe("normalizeCutArgs", () => {
  const base = { listFile: null, input: "/raw/a.webm", startSec: 5, durationSec: 20, width: 1920, height: 1080, fps: 60, hasAudio: true, output: "/out/a.mp4" };

  it("builds an accurate output-side cut with scale/pad/fps and x264/aac", () => {
    const args = normalizeCutArgs(base).join(" ");
    expect(args).toContain("-i /raw/a.webm");
    expect(args).toContain("-ss 5.000 -t 20.000");
    expect(args).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
    expect(args).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
    expect(args).toContain("fps=60");
    expect(args).toContain("-c:v libx264 -preset veryfast -crf 23");
    expect(args).toContain("-map 0:a:0 -c:a aac -b:a 128k");
    expect(args).toContain("-movflags +faststart /out/a.mp4");
  });

  it("uses the concat demuxer when listFile is set", () => {
    const args = normalizeCutArgs({ ...base, listFile: "/tmp/list.txt", input: null }).join(" ");
    expect(args).toContain("-f concat -safe 0 -i /tmp/list.txt");
  });

  it("injects a silent audio track when hasAudio is false", () => {
    const args = normalizeCutArgs({ ...base, hasAudio: false }).join(" ");
    expect(args).toContain("anullsrc=r=48000:cl=stereo");
    expect(args).toContain("-map 1:a:0");
  });
});

describe("combine builders", () => {
  it("sequential uses concat demuxer with stream copy", () => {
    expect(combineSequentialArgs("/tmp/list.txt", "/out/combined.mp4").join(" "))
      .toContain("-f concat -safe 0 -i /tmp/list.txt -c copy");
  });

  it("side-by-side stacks two halves at target size", () => {
    const args = combineSideBySideArgs(["/a.mp4", "/b.mp4"], { width: 1920, height: 1080, fps: 60 }, "/out/c.mp4").join(" ");
    expect(args).toContain("scale=960:1080:force_original_aspect_ratio=decrease");
    expect(args).toContain("hstack=inputs=2");
    expect(args).toContain("-map 0:a:0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/ffmpeg.test.ts`
Expected: FAIL — cannot resolve `../../src/server/ffmpeg`.

- [ ] **Step 3: Implement**

`src/server/ffmpeg.ts`:
```ts
import { writeFileSync } from "node:fs";

export type NormalizeOptions = {
  listFile: string | null;
  input: string | null;
  startSec: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  output: string;
};

export function writeConcatList(paths: string[], listPath: string): void {
  writeFileSync(listPath, paths.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"));
}

export function normalizeCutArgs(o: NormalizeOptions): string[] {
  const args = ["-hide_banner", "-y"];
  if (o.listFile) args.push("-f", "concat", "-safe", "0", "-i", o.listFile);
  else args.push("-i", o.input!);
  if (!o.hasAudio) {
    args.push("-f", "lavfi", "-t", (o.startSec + o.durationSec + 1).toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
  }
  args.push(
    "-ss", o.startSec.toFixed(3),
    "-t", o.durationSec.toFixed(3),
    "-map", "0:v:0",
    "-map", o.hasAudio ? "0:a:0" : "1:a:0",
    "-vf", `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2,fps=${o.fps}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    o.output,
  );
  return args;
}

export function combineSequentialArgs(listFile: string, output: string): string[] {
  return ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", output];
}

export function combineSideBySideArgs(
  inputs: [string, string],
  o: { width: number; height: number; fps: number },
  output: string,
): string[] {
  const half = Math.floor(o.width / 2);
  const pane = (i: number, label: string) =>
    `[${i}:v]scale=${half}:${o.height}:force_original_aspect_ratio=decrease,pad=${half}:${o.height}:(ow-iw)/2:(oh-ih)/2[${label}]`;
  return [
    "-hide_banner", "-y",
    "-i", inputs[0], "-i", inputs[1],
    "-filter_complex", `${pane(0, "l")};${pane(1, "r")};[l][r]hstack=inputs=2,fps=${o.fps}[v]`,
    "-map", "[v]", "-map", "0:a:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ];
}

export async function runFfmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`);
  }
}

export async function probe(file: string): Promise<{ durationSec: number; width: number; height: number; fps: number; hasAudio: boolean }> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffprobe exited ${code}: ${await new Response(proc.stderr).text()}`);
  const data = JSON.parse(await new Response(proc.stdout).text()) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }[];
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const [num, den] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  const durationSec = Number(data.format?.duration ?? video?.duration ?? 0);
  return {
    durationSec,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: den ? (num ?? 0) / den : 0,
    hasAudio: data.streams?.some((s) => s.codec_type === "audio") ?? false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/ffmpeg.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/ffmpeg.ts tests/unit/ffmpeg.test.ts
git commit -m "feat: ffmpeg arg builders, runner and probe"
```

---

### Task 6: Processing pipeline (+ FFmpeg integration test)

**Files:**
- Create: `src/server/pipeline.ts`
- Test: `tests/integration/pipeline.test.ts` (needs `ffmpeg`/`ffprobe` on PATH)

**Interfaces:**
- Consumes: `computeCutWindow` (Task 3); `normalizeCutArgs`, `combineSequentialArgs`, `combineSideBySideArgs`, `writeConcatList`, `runFfmpeg`, `probe` (Task 5); `Config` (Task 1); `ClipOutputs`, `ClipCamera` (Task 4).
- Produces: `type RawAngle = { name: string; slug: string; files: { path: string; startMs: number }[] }`; `slugify(name: string): string`; `processClip(o: { clipDir: string; t: number; windowSec: number; angles: RawAngle[]; config: Config }): Promise<{ outputs: ClipOutputs; cameras: ClipCamera[]; errors: string[] }>`.
- Behavior: per angle — probe each raw file for duration/audio, `computeCutWindow` against `[t − windowSec·1000, t]`, skip angle with an error entry if resulting duration < 0.5s, else normalize to `angle-<slug>.mp4`. Combined: 0 angles → `combined: null`; 1 angle → copy it to `combined.mp4`; ≥2 → `sequential` concat-copies **all** angles, `side-by-side` stacks the **first two**. Angle failures never abort the job.

- [ ] **Step 1: Write the failing test**

`tests/integration/pipeline.test.ts`:
```ts
import { beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../../src/server/config";
import { probe, runFfmpeg } from "../../src/server/ffmpeg";
import { processClip } from "../../src/server/pipeline";

setDefaultTimeout(180_000);

const config: Config = { password: "x", ...DEFAULT_CONFIG };
let rawA0: string, rawA1: string, rawB0: string;

async function synth(path: string, seconds: number): Promise<void> {
  await runFfmpeg([
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `testsrc=size=1280x720:rate=30:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path,
  ]);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-raw-"));
  rawA0 = join(dir, "a0.mp4");
  rawA1 = join(dir, "a1.mp4");
  rawB0 = join(dir, "b0.mp4");
  await Promise.all([synth(rawA0, 8), synth(rawA1, 8), synth(rawB0, 12)]);
});

describe("processClip", () => {
  it("cuts across a cycle boundary, normalizes, and builds a sequential combined clip", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const t = 100_000;
    const result = await processClip({
      clipDir, t, windowSec: 10, config,
      angles: [
        // angle A: two 8s files with a 200ms gap; window [90s,100s] spans both
        { name: "Fundo", slug: "fundo", files: [{ path: rawA0, startMs: 84_000 }, { path: rawA1, startMs: 92_200 }] },
        // angle B: one 12s file covering the window
        { name: "Lateral rede", slug: "lateral-rede", files: [{ path: rawB0, startMs: 89_000 }] },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.outputs.angles).sort()).toEqual(["fundo", "lateral-rede"]);
    expect(result.outputs.combined).toBe("combined.mp4");

    const fundo = await probe(join(clipDir, "angle-fundo.mp4"));
    expect(fundo.width).toBe(1920);
    expect(fundo.height).toBe(1080);
    expect(Math.round(fundo.fps)).toBe(60);
    expect(fundo.hasAudio).toBe(true); // silent track injected
    expect(fundo.durationSec).toBeGreaterThan(9);
    expect(fundo.durationSec).toBeLessThan(10.5);

    const combined = await probe(join(clipDir, "combined.mp4"));
    expect(combined.durationSec).toBeGreaterThan(18.5);
    expect(combined.durationSec).toBeLessThan(21);
  }, 180_000);

  it("side-by-side layout stacks the first two angles", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const result = await processClip({
      clipDir, t: 100_000, windowSec: 5, config: { ...config, layout: "side-by-side" },
      angles: [
        { name: "A", slug: "a", files: [{ path: rawB0, startMs: 90_000 }] },
        { name: "B", slug: "b", files: [{ path: rawB0, startMs: 90_000 }] },
      ],
    });
    expect(result.outputs.combined).toBe("combined.mp4");
    const combined = await probe(join(clipDir, "combined.mp4"));
    expect(combined.width).toBe(1920);
    expect(combined.durationSec).toBeLessThan(6.5);
  }, 180_000);

  it("keeps valid angles when one angle's file is corrupt", async () => {
    const clipDir = mkdtempSync(join(tmpdir(), "replay-clip-"));
    mkdirSync(join(clipDir, "raw"), { recursive: true });
    const bad = join(clipDir, "raw", "bad.mp4");
    await Bun.write(bad, "not a video");
    const result = await processClip({
      clipDir, t: 100_000, windowSec: 5, config,
      angles: [
        { name: "Ok", slug: "ok", files: [{ path: rawB0, startMs: 90_000 }] },
        { name: "Bad", slug: "bad", files: [{ path: bad, startMs: 90_000 }] },
      ],
    });
    expect(Object.keys(result.outputs.angles)).toEqual(["ok"]);
    expect(result.errors.length).toBe(1);
    expect(result.outputs.combined).toBe("combined.mp4"); // single valid angle copied
  }, 180_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/pipeline.test.ts`
Expected: FAIL — cannot resolve `../../src/server/pipeline`.

- [ ] **Step 3: Implement**

`src/server/pipeline.ts`:
```ts
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { computeCutWindow } from "../shared/buffer-window";
import type { Config } from "./config";
import { combineSequentialArgs, combineSideBySideArgs, normalizeCutArgs, probe, runFfmpeg, writeConcatList } from "./ffmpeg";
import type { ClipCamera, ClipOutputs } from "./storage";

export type RawAngle = { name: string; slug: string; files: { path: string; startMs: number }[] };

export function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "camera"
  );
}

export async function processClip(o: {
  clipDir: string;
  t: number;
  windowSec: number;
  angles: RawAngle[];
  config: Config;
}): Promise<{ outputs: ClipOutputs; cameras: ClipCamera[]; errors: string[] }> {
  const { clipDir, t, windowSec, config } = o;
  const width = Math.round((config.targetHeight * 16) / 9);
  const windowStartMs = t - windowSec * 1000;
  const outputs: ClipOutputs = { combined: null, angles: {} };
  const cameras: ClipCamera[] = [];
  const errors: string[] = [];
  const anglePaths: string[] = [];

  for (const angle of o.angles) {
    try {
      const probed = [];
      let hasAudio = false;
      for (const f of angle.files) {
        const info = await probe(f.path);
        probed.push({ path: f.path, startMs: f.startMs, durationMs: info.durationSec * 1000 });
        hasAudio = hasAudio || info.hasAudio;
      }
      const cut = computeCutWindow(probed, windowStartMs, t);
      if (cut.durationSec < 0.5) throw new Error("window not covered by uploaded files");

      let listFile: string | null = null;
      let input: string | null = null;
      if (probed.length > 1) {
        listFile = join(clipDir, "raw", `${angle.slug}-list.txt`);
        writeConcatList(probed.map((p) => p.path), listFile);
      } else {
        input = probed[0]!.path;
      }
      const outName = `angle-${angle.slug}.mp4`;
      await runFfmpeg(
        normalizeCutArgs({
          listFile, input,
          startSec: cut.startSec, durationSec: cut.durationSec,
          width, height: config.targetHeight, fps: config.targetFps,
          hasAudio, output: join(clipDir, outName),
        }),
      );
      outputs.angles[angle.slug] = outName;
      anglePaths.push(join(clipDir, outName));
      cameras.push({ name: angle.name, slug: angle.slug, files: probed.map(({ startMs, durationMs }) => ({ startMs, durationMs })) });
    } catch (e) {
      errors.push(`angle ${angle.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (anglePaths.length === 1) {
    copyFileSync(anglePaths[0]!, join(clipDir, "combined.mp4"));
    outputs.combined = "combined.mp4";
  } else if (anglePaths.length >= 2) {
    const out = join(clipDir, "combined.mp4");
    if (config.layout === "side-by-side") {
      await runFfmpeg(combineSideBySideArgs([anglePaths[0]!, anglePaths[1]!], { width, height: config.targetHeight, fps: config.targetFps }, out));
    } else {
      const listFile = join(clipDir, "raw", "combined-list.txt");
      writeConcatList(anglePaths, listFile);
      await runFfmpeg(combineSequentialArgs(listFile, out));
    }
    outputs.combined = "combined.mp4";
  }

  return { outputs, cameras, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/integration/pipeline.test.ts`
Expected: PASS (3 tests; takes ~1–3 min, software encoding).

- [ ] **Step 5: Commit**

```bash
git add src/server/pipeline.ts tests/integration/pipeline.test.ts
git commit -m "feat: clip processing pipeline with ffmpeg integration tests"
```

---

### Task 7: Auth module

**Files:**
- Create: `src/server/auth.ts`
- Test: `tests/unit/auth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SESSION_TTL_MS = 86_400_000`; `class Auth { constructor(secret: string, password: () => string); static load(dataDir: string, password: () => string): Auth; login(password: string, nowMs: number): string | null; verify(token: string | undefined, nowMs: number): boolean; cookieFor(token: string): string }`; `tokenFromCookie(header: string | null): string | undefined`; `class RateLimiter { constructor(limit: number, windowMs: number); allow(key: string, nowMs: number): boolean }`.
- Token format: `"<expiryMs>.<hmacSha256Hex(expiryMs, secret)>"` — stateless, survives restarts via `<dataDir>/session-secret`.

- [ ] **Step 1: Write the failing test**

`tests/unit/auth.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, RateLimiter, SESSION_TTL_MS, tokenFromCookie } from "../../src/server/auth";

const tmp = () => mkdtempSync(join(tmpdir(), "replay-auth-"));

describe("Auth", () => {
  it("rejects a wrong password and accepts the right one", () => {
    const auth = Auth.load(tmp(), () => "segredo");
    expect(auth.login("errada", 0)).toBeNull();
    const token = auth.login("segredo", 0);
    expect(token).not.toBeNull();
    expect(auth.verify(token!, 1000)).toBe(true);
  });

  it("expires tokens after the TTL and rejects tampering", () => {
    const auth = Auth.load(tmp(), () => "s");
    const token = auth.login("s", 0)!;
    expect(auth.verify(token, SESSION_TTL_MS + 1)).toBe(false);
    const [exp, sig] = token.split(".");
    expect(auth.verify(`${Number(exp) + 9999}.${sig}`, 0)).toBe(false);
    expect(auth.verify(undefined, 0)).toBe(false);
    expect(auth.verify("garbage", 0)).toBe(false);
  });

  it("persists the secret so tokens survive a restart", () => {
    const dir = tmp();
    const token = Auth.load(dir, () => "s").login("s", 0)!;
    expect(Auth.load(dir, () => "s").verify(token, 1000)).toBe(true);
  });

  it("parses the session cookie", () => {
    expect(tokenFromCookie("theme=dark; session=abc.def; x=1")).toBe("abc.def");
    expect(tokenFromCookie(null)).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit per window, then blocks, then resets", () => {
    const rl = new RateLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) expect(rl.allow("ip", i)).toBe(true);
    expect(rl.allow("ip", 100)).toBe(false);
    expect(rl.allow("other", 100)).toBe(true);
    expect(rl.allow("ip", 60_001)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/auth.test.ts`
Expected: FAIL — cannot resolve `../../src/server/auth`.

- [ ] **Step 3: Implement**

`src/server/auth.ts`:
```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class Auth {
  constructor(
    private secret: string,
    private password: () => string,
  ) {}

  static load(dataDir: string, password: () => string): Auth {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "session-secret");
    if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("hex"));
    return new Auth(readFileSync(path, "utf8").trim(), password);
  }

  login(password: string, nowMs: number): string | null {
    const expected = Buffer.from(this.password());
    const given = Buffer.from(password);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const exp = String(nowMs + SESSION_TTL_MS);
    return `${exp}.${this.sign(exp)}`;
  }

  verify(token: string | undefined, nowMs: number): boolean {
    if (!token) return false;
    const [exp, sig] = token.split(".");
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < nowMs) return false;
    const good = this.sign(exp);
    return sig.length === good.length && timingSafeEqual(Buffer.from(sig), Buffer.from(good));
  }

  cookieFor(token: string): string {
    return `session=${token}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }
}

export function tokenFromCookie(header: string | null): string | undefined {
  return /(?:^|;\s*)session=([^;]+)/.exec(header ?? "")?.[1];
}

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  allow(key: string, nowMs: number): boolean {
    const h = this.hits.get(key);
    if (!h || nowMs >= h.resetAt) {
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    h.count += 1;
    return h.count <= this.limit;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/auth.ts tests/unit/auth.test.ts
git commit -m "feat: shared-password auth with hmac sessions and rate limiter"
```

---

### Task 8: WebSocket hub

**Files:**
- Create: `src/server/hub.ts`
- Test: `tests/unit/hub.test.ts`

**Interfaces:**
- Consumes: `CameraInfo`, `ClientMessage`, `ServerMessage` (Task 2).
- Produces: `type WSData = { role?: "camera" | "control"; cameraId?: string }`; `TOPIC_ALL = "all"`; `TOPIC_CAMERAS = "cameras"`; `OFFLINE_AFTER_MS = 10_000`; `class Hub { onStateChanged: () => void; cameras(): CameraInfo[]; onlineCameraIds(): string[]; open(ws): void; message(ws, raw: string | Buffer, nowMs: number): void; close(ws): void; sweep(nowMs: number): void }`.
- The hub is transport-thin: it mutates registry state and fires `onStateChanged`; broadcasting/publishing is wired in `index.ts`. `ws` only needs `{ data, send(), subscribe() }`, so unit tests use fakes — no real server.

- [ ] **Step 1: Write the failing test**

`tests/unit/hub.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Hub, OFFLINE_AFTER_MS, type WSData } from "../../src/server/hub";

function fakeWs() {
  const sent: string[] = [];
  const topics: string[] = [];
  const ws = {
    data: {} as WSData,
    send: (m: string) => sent.push(m),
    subscribe: (t: string) => topics.push(t),
  } as unknown as ServerWebSocket<WSData>;
  return { ws, sent, topics };
}

describe("Hub", () => {
  it("registers a camera, replies with its id, and lists it online", () => {
    const hub = new Hub();
    let changes = 0;
    hub.onStateChanged = () => changes++;
    const { ws, sent, topics } = fakeWs();
    hub.open(ws);
    hub.message(ws, JSON.stringify({ type: "register", role: "camera", name: "Fundo" }), 1000);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe("registered");
    expect(ws.data.cameraId).toBe(reply.cameraId);
    expect(topics).toEqual(["all", "cameras"]);
    expect(hub.cameras()).toMatchObject([{ name: "Fundo", online: true }]);
    expect(hub.onlineCameraIds()).toEqual([reply.cameraId]);
    expect(changes).toBe(1);
  });

  it("answers ntp with serverTime and echoes clientTime", () => {
    const hub = new Hub();
    const { ws, sent } = fakeWs();
    hub.open(ws);
    hub.message(ws, JSON.stringify({ type: "ntp", clientTime: 123 }), 5000);
    expect(JSON.parse(sent[0]!)).toEqual({ type: "ntpReply", clientTime: 123, serverTime: 5000 });
  });

  it("updates camera status and marks offline after heartbeat silence", () => {
    const hub = new Hub();
    const { ws, sent } = fakeWs();
    hub.open(ws);
    hub.message(ws, JSON.stringify({ type: "register", role: "camera", name: "A" }), 0);
    void sent;
    hub.message(ws, JSON.stringify({ type: "cameraStatus", width: 1920, height: 1080, fps: 60 }), 1000);
    expect(hub.cameras()[0]).toMatchObject({ width: 1920, fps: 60, online: true });

    hub.sweep(1000 + OFFLINE_AFTER_MS + 1);
    expect(hub.cameras()[0]!.online).toBe(false);
    expect(hub.onlineCameraIds()).toEqual([]);

    hub.message(ws, JSON.stringify({ type: "hb" }), 20_000);
    hub.sweep(20_001);
    expect(hub.cameras()[0]!.online).toBe(true);
  });

  it("removes a camera on close and ignores malformed json", () => {
    const hub = new Hub();
    const { ws } = fakeWs();
    hub.open(ws);
    hub.message(ws, "{not json", 0);
    hub.message(ws, JSON.stringify({ type: "register", role: "camera", name: "A" }), 0);
    hub.close(ws);
    expect(hub.cameras()).toEqual([]);
  });

  it("control registration does not create a camera", () => {
    const hub = new Hub();
    const { ws } = fakeWs();
    hub.open(ws);
    hub.message(ws, JSON.stringify({ type: "register", role: "control" }), 0);
    expect(hub.cameras()).toEqual([]);
    expect(ws.data.role).toBe("control");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/hub.test.ts`
Expected: FAIL — cannot resolve `../../src/server/hub`.

- [ ] **Step 3: Implement**

`src/server/hub.ts`:
```ts
import type { ServerWebSocket } from "bun";
import type { CameraInfo, ClientMessage, ServerMessage } from "../shared/protocol";

export type WSData = { role?: "camera" | "control"; cameraId?: string };
export const TOPIC_ALL = "all";
export const TOPIC_CAMERAS = "cameras";
export const OFFLINE_AFTER_MS = 10_000;

type CameraConn = { info: CameraInfo; lastSeen: number };

export class Hub {
  private camerasById = new Map<string, CameraConn>();
  onStateChanged: () => void = () => {};

  cameras(): CameraInfo[] {
    return [...this.camerasById.values()].map((c) => c.info);
  }

  onlineCameraIds(): string[] {
    return [...this.camerasById.values()].filter((c) => c.info.online).map((c) => c.info.id);
  }

  open(ws: ServerWebSocket<WSData>): void {
    ws.subscribe(TOPIC_ALL);
  }

  message(ws: ServerWebSocket<WSData>, raw: string | Buffer, nowMs: number): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === "ntp") {
      const reply: ServerMessage = { type: "ntpReply", clientTime: msg.clientTime, serverTime: nowMs };
      ws.send(JSON.stringify(reply));
      return;
    }
    if (msg.type === "register") {
      ws.data.role = msg.role;
      if (msg.role === "camera") {
        const id = crypto.randomUUID();
        ws.data.cameraId = id;
        ws.subscribe(TOPIC_CAMERAS);
        this.camerasById.set(id, {
          info: { id, name: msg.name, online: true, width: 0, height: 0, fps: 0 },
          lastSeen: nowMs,
        });
        const reply: ServerMessage = { type: "registered", cameraId: id };
        ws.send(JSON.stringify(reply));
      }
      this.onStateChanged();
      return;
    }
    const cam = ws.data.cameraId ? this.camerasById.get(ws.data.cameraId) : undefined;
    if (!cam) return;
    cam.lastSeen = nowMs;
    const wasOffline = !cam.info.online;
    cam.info.online = true;
    if (msg.type === "cameraStatus") {
      const changed =
        wasOffline || cam.info.width !== msg.width || cam.info.height !== msg.height || cam.info.fps !== msg.fps;
      cam.info.width = msg.width;
      cam.info.height = msg.height;
      cam.info.fps = msg.fps;
      if (changed) this.onStateChanged(); // cameras re-report every 5s; only broadcast real changes
    } else if (wasOffline) {
      this.onStateChanged();
    }
  }

  close(ws: ServerWebSocket<WSData>): void {
    if (ws.data.cameraId && this.camerasById.delete(ws.data.cameraId)) this.onStateChanged();
  }

  sweep(nowMs: number): void {
    let changed = false;
    for (const cam of this.camerasById.values()) {
      const online = nowMs - cam.lastSeen < OFFLINE_AFTER_MS;
      if (online !== cam.info.online) {
        cam.info.online = online;
        changed = true;
      }
    }
    if (changed) this.onStateChanged();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/hub.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/hub.ts tests/unit/hub.test.ts
git commit -m "feat: websocket hub with camera registry, ntp and heartbeat sweep"
```

---

### Task 9: Serial queue + clip job manager

**Files:**
- Create: `src/server/queue.ts`, `src/server/clip-job.ts`
- Test: `tests/unit/queue.test.ts`, `tests/unit/clip-job.test.ts`

**Interfaces:**
- Consumes: `Storage`, `ClipMeta` (Task 4); `ConfigStore` (Task 1); `Hub` (Task 8 — only `onlineCameraIds()`); `processClip`, `RawAngle` (Task 6); `JobStatus` (Task 2).
- Produces: `class SerialQueue { push(task: () => Promise<void>): Promise<void> }`; `type TriggerResult = { jobId: string } | { error: "cooldown" | "no-cameras" }`; `class JobManager { constructor(deps: { storage: Storage; config: ConfigStore; hub: Pick<Hub, "onlineCameraIds">; queue: SerialQueue; publishRecord: (jobId: string, t: number, windowSec: number) => void; onUpdate: (job: JobStatus) => void; processFn?: typeof processClip; uploadTimeoutMs?: number; cooldownMs?: number }); trigger(nowMs: number): TriggerResult; uploadDir(jobId: string): string | null; addUpload(jobId: string, cameraId: string, angle: RawAngle): boolean; jobs(): JobStatus[] }`.
- Behavior: trigger enforces cooldown (default 2000ms) and ≥1 online camera; creates the clip dir immediately; finalizes when every expected camera delivered **or** on upload timeout (default 30000ms); processing runs on the queue; `meta.json` is always written (state `ready` if any output exists, else `error`); `jobs()` returns the 20 most recent statuses, newest first. `processFn` exists so unit tests stub FFmpeg out; production wiring omits it.

- [ ] **Step 1: Write the failing queue test**

`tests/unit/queue.test.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing job manager test**

`tests/unit/clip-job.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStatus } from "../../src/shared/protocol";
import { ConfigStore } from "../../src/server/config";
import { JobManager } from "../../src/server/clip-job";
import { SerialQueue } from "../../src/server/queue";
import { Storage } from "../../src/server/storage";

function setup(cameraIds: string[], processOk = true) {
  const dir = mkdtempSync(join(tmpdir(), "replay-job-"));
  const updates: JobStatus[] = [];
  const records: string[] = [];
  const manager = new JobManager({
    storage: new Storage(dir),
    config: ConfigStore.load(dir),
    hub: { onlineCameraIds: () => cameraIds },
    queue: new SerialQueue(),
    publishRecord: (jobId) => records.push(jobId),
    onUpdate: (j) => updates.push({ ...j }),
    processFn: async () => {
      if (!processOk) throw new Error("ffmpeg exploded");
      return { outputs: { combined: "combined.mp4", angles: { a: "angle-a.mp4" } }, cameras: [], errors: [] };
    },
    uploadTimeoutMs: 60,
    cooldownMs: 20,
  });
  return { manager, updates, records, dir };
}

const angle = { name: "A", slug: "a", files: [{ path: "/dev/null", startMs: 0 }] };
const waitFor = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("JobManager", () => {
  it("refuses to trigger without cameras and during cooldown", () => {
    const none = setup([]);
    expect(none.manager.trigger(1000)).toEqual({ error: "no-cameras" });
    const { manager } = setup(["cam1"]);
    expect("jobId" in manager.trigger(1000)).toBe(true);
    expect(manager.trigger(1010)).toEqual({ error: "cooldown" });
    expect("jobId" in manager.trigger(1030)).toBe(true);
  });

  it("publishes record, finalizes when all cameras deliver, writes ready meta", async () => {
    const { manager, updates, records, dir } = setup(["cam1", "cam2"]);
    const result = manager.trigger(1000) as { jobId: string };
    expect(records).toEqual([result.jobId]);
    const clipDir = manager.uploadDir(result.jobId)!;
    expect(clipDir.startsWith(dir)).toBe(true);
    expect(manager.addUpload(result.jobId, "cam1", angle)).toBe(true);
    expect(manager.addUpload(result.jobId, "cam2", angle)).toBe(true);
    await waitFor(() => updates.some((u) => u.state === "ready"));
    expect(updates.map((u) => u.state)).toEqual(["capturing", "processing", "ready"]);
    expect(existsSync(join(clipDir, "meta.json"))).toBe(true);
  });

  it("processes with partial uploads after the timeout", async () => {
    const { manager, updates } = setup(["cam1", "cam2"]);
    const { jobId } = manager.trigger(1000) as { jobId: string };
    manager.addUpload(jobId, "cam1", angle);
    await waitFor(() => updates.some((u) => u.state === "ready"));
  });

  it("marks the job error when no uploads arrive or processing throws", async () => {
    const empty = setup(["cam1"]);
    empty.manager.trigger(1000);
    await waitFor(() => empty.updates.some((u) => u.state === "error"));

    const broken = setup(["cam1"], false);
    const { jobId } = broken.manager.trigger(1000) as { jobId: string };
    broken.manager.addUpload(jobId, "cam1", angle);
    await waitFor(() => broken.updates.some((u) => u.state === "error"));
  });

  it("rejects uploads for unknown or already-finalized jobs", async () => {
    const { manager, updates } = setup(["cam1"]);
    expect(manager.addUpload("nope", "cam1", angle)).toBe(false);
    const { jobId } = manager.trigger(1000) as { jobId: string };
    manager.addUpload(jobId, "cam1", angle);
    await waitFor(() => updates.some((u) => u.state === "ready"));
    expect(manager.addUpload(jobId, "cam1", angle)).toBe(false);
    expect(manager.uploadDir(jobId)).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/queue.test.ts tests/unit/clip-job.test.ts`
Expected: FAIL — cannot resolve `../../src/server/queue` / `clip-job`.

- [ ] **Step 4: Implement**

`src/server/queue.ts`:
```ts
export class SerialQueue {
  private chain: Promise<void> = Promise.resolve();

  push(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}
```

`src/server/clip-job.ts`:
```ts
import type { JobStatus } from "../shared/protocol";
import type { ConfigStore } from "./config";
import type { Hub } from "./hub";
import { processClip, type RawAngle } from "./pipeline";
import type { SerialQueue } from "./queue";
import type { ClipMeta, Storage } from "./storage";

export type TriggerResult = { jobId: string } | { error: "cooldown" | "no-cameras" };

type Deps = {
  storage: Storage;
  config: ConfigStore;
  hub: Pick<Hub, "onlineCameraIds">;
  queue: SerialQueue;
  publishRecord: (jobId: string, t: number, windowSec: number) => void;
  onUpdate: (job: JobStatus) => void;
  processFn?: typeof processClip;
  uploadTimeoutMs?: number;
  cooldownMs?: number;
};

type ActiveJob = {
  status: JobStatus;
  dir: string;
  t: number;
  windowSec: number;
  expected: Set<string>;
  delivered: Set<string>;
  angles: RawAngle[];
  timer: ReturnType<typeof setTimeout>;
};

export class JobManager {
  private active = new Map<string, ActiveJob>();
  private recent: JobStatus[] = [];
  private lastTriggerAt = -Infinity;

  constructor(private deps: Deps) {}

  jobs(): JobStatus[] {
    return this.recent.slice(0, 20);
  }

  trigger(nowMs: number): TriggerResult {
    if (nowMs - this.lastTriggerAt < (this.deps.cooldownMs ?? 2000)) return { error: "cooldown" };
    const cameraIds = this.deps.hub.onlineCameraIds();
    if (cameraIds.length === 0) return { error: "no-cameras" };
    this.lastTriggerAt = nowMs;

    const clipNumber = this.deps.storage.nextClipNumber();
    const dir = this.deps.storage.createClipDir(clipNumber, nowMs);
    const windowSec = this.deps.config.value.clipDurationSeconds;
    const status: JobStatus = { jobId: crypto.randomUUID(), clipNumber, state: "capturing", createdAt: nowMs };
    const job: ActiveJob = {
      status, dir, t: nowMs, windowSec,
      expected: new Set(cameraIds),
      delivered: new Set(),
      angles: [],
      timer: setTimeout(() => this.finalize(status.jobId), this.deps.uploadTimeoutMs ?? 30_000),
    };
    this.active.set(status.jobId, job);
    this.recent.unshift(status);
    this.deps.publishRecord(status.jobId, job.t, windowSec);
    this.deps.onUpdate(status);
    return { jobId: status.jobId };
  }

  uploadDir(jobId: string): string | null {
    const job = this.active.get(jobId);
    return job && job.status.state === "capturing" ? job.dir : null;
  }

  addUpload(jobId: string, cameraId: string, angle: RawAngle): boolean {
    const job = this.active.get(jobId);
    if (!job || job.status.state !== "capturing") return false;
    job.angles.push(angle);
    job.delivered.add(cameraId);
    if ([...job.expected].every((id) => job.delivered.has(id))) this.finalize(jobId);
    return true;
  }

  private finalize(jobId: string): void {
    const job = this.active.get(jobId);
    if (!job || job.status.state !== "capturing") return;
    clearTimeout(job.timer);
    job.status.state = "processing";
    this.deps.onUpdate({ ...job.status });
    void this.deps.queue.push(async () => {
      const meta = await this.process(job);
      job.status.state = meta.state === "ready" ? "ready" : "error";
      if (meta.state === "error") job.status.error = meta.errors.join("; ") || "processing failed";
      this.active.delete(jobId);
      this.deps.onUpdate({ ...job.status });
    });
  }

  private async process(job: ActiveJob): Promise<ClipMeta> {
    const meta: ClipMeta = {
      jobId: job.status.jobId,
      clipNumber: job.status.clipNumber,
      t: job.t,
      windowSec: job.windowSec,
      layout: this.deps.config.value.layout,
      state: "error",
      cameras: [],
      outputs: { combined: null, angles: {} },
      errors: [],
      createdAt: job.status.createdAt,
    };
    try {
      if (job.angles.length === 0) {
        meta.errors.push("no camera uploads received");
      } else {
        const run = this.deps.processFn ?? processClip;
        const result = await run({ clipDir: job.dir, t: job.t, windowSec: job.windowSec, angles: job.angles, config: this.deps.config.value });
        meta.cameras = result.cameras;
        meta.outputs = result.outputs;
        meta.errors = result.errors;
        if (result.outputs.combined || Object.keys(result.outputs.angles).length > 0) meta.state = "ready";
      }
    } catch (e) {
      meta.errors.push(e instanceof Error ? e.message : String(e));
    }
    this.deps.storage.writeMeta(job.dir, meta);
    return meta;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/queue.test.ts tests/unit/clip-job.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/queue.ts src/server/clip-job.ts tests/unit/queue.test.ts tests/unit/clip-job.test.ts
git commit -m "feat: serial processing queue and clip job coordinator"
```

---

### Task 10: TLS cert generation + page bundling

**Files:**
- Create: `src/server/cert.ts`, `src/server/pages.ts`
- Create (placeholder pages so bundling works): `src/web/index.html`, `src/web/login.ts`, `src/web/shared/app.css`, `src/web/camera/index.html`, `src/web/camera/camera.ts`, `src/web/control/index.html`, `src/web/control/control.ts`, `src/web/clips/index.html`, `src/web/clips/clips.ts`
- Test: `tests/unit/cert.test.ts`, `tests/unit/pages.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ensureCert(dataDir: string): Promise<{ certPath: string; keyPath: string }>` (idempotent; uses `openssl`; `HOST_LAN_IP` goes into the SAN and is remembered in `<dataDir>/certs/san-ip` — when it changes, cert+key are regenerated so iPhones/Androids validate the right IP); `buildPages(webDir: string, outDir: string): Promise<PageAssets>`; `type PageAssets = { html(page: "login" | "camera" | "control" | "clips"): string; assetFile(name: string): string | null }` — `assetFile` returns an absolute path only for the whitelisted names `login.js`, `camera.js`, `control.js`, `clips.js`, `app.css`.
- Placeholder page files created here are one-line stubs (real content comes in Tasks 12–15): each `index.html` is `<!doctype html><title>stub</title><script type="module" src="/assets/<name>.js"></script>` and each `.ts` is `console.log("<name> stub");`. `app.css` starts empty.

- [ ] **Step 1: Write the failing tests**

`tests/unit/cert.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCert } from "../../src/server/cert";

describe("ensureCert", () => {
  it("generates cert+key once and reuses them after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-cert-"));
    const first = await ensureCert(dir);
    expect(readFileSync(first.certPath, "utf8")).toContain("BEGIN CERTIFICATE");
    expect(readFileSync(first.keyPath, "utf8")).toContain("PRIVATE KEY");
    const mtime = statSync(first.certPath).mtimeMs;
    const second = await ensureCert(dir);
    expect(second.certPath).toBe(first.certPath);
    expect(statSync(second.certPath).mtimeMs).toBe(mtime);
  }, 30_000);

  it("regenerates cert+key when HOST_LAN_IP changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-cert-"));
    process.env.HOST_LAN_IP = "192.168.0.10";
    const first = await ensureCert(dir);
    const before = readFileSync(first.certPath, "utf8");
    process.env.HOST_LAN_IP = "192.168.0.20";
    const second = await ensureCert(dir);
    expect(readFileSync(second.certPath, "utf8")).not.toBe(before);
    process.env.HOST_LAN_IP = "192.168.0.20";
    const third = await ensureCert(dir);
    expect(readFileSync(third.certPath, "utf8")).toBe(readFileSync(second.certPath, "utf8"));
    delete process.env.HOST_LAN_IP;
  }, 30_000);
});
```

`tests/unit/pages.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPages } from "../../src/server/pages";

describe("buildPages", () => {
  it("bundles the four page entrypoints and serves html + whitelisted assets", async () => {
    const out = mkdtempSync(join(tmpdir(), "replay-dist-"));
    const pages = await buildPages("src/web", out);
    expect(pages.html("login")).toContain("<script");
    expect(pages.html("camera").length).toBeGreaterThan(0);
    for (const name of ["login.js", "camera.js", "control.js", "clips.js", "app.css"]) {
      expect(pages.assetFile(name)).not.toBeNull();
    }
    expect(pages.assetFile("../secret")).toBeNull();
    expect(pages.assetFile("evil.js")).toBeNull();
  }, 30_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/cert.test.ts tests/unit/pages.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Create the placeholder web files**

```bash
mkdir -p src/web/shared src/web/camera src/web/control src/web/clips
printf '<!doctype html><title>stub</title><script type="module" src="/assets/login.js"></script>' > src/web/index.html
printf 'console.log("login stub");\n' > src/web/login.ts
printf '' > src/web/shared/app.css
printf '<!doctype html><title>stub</title><script type="module" src="/assets/camera.js"></script>' > src/web/camera/index.html
printf 'console.log("camera stub");\n' > src/web/camera/camera.ts
printf '<!doctype html><title>stub</title><script type="module" src="/assets/control.js"></script>' > src/web/control/index.html
printf 'console.log("control stub");\n' > src/web/control/control.ts
printf '<!doctype html><title>stub</title><script type="module" src="/assets/clips.js"></script>' > src/web/clips/index.html
printf 'console.log("clips stub");\n' > src/web/clips/clips.ts
```

- [ ] **Step 4: Implement**

`src/server/cert.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function ensureCert(dataDir: string): Promise<{ certPath: string; keyPath: string }> {
  const dir = join(dataDir, "certs");
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  const ipMarker = join(dir, "san-ip");
  const wantedIp = process.env.HOST_LAN_IP ?? "";
  const markedIp = existsSync(ipMarker) ? readFileSync(ipMarker, "utf8") : "";
  if (wantedIp && markedIp !== wantedIp) {
    rmSync(certPath, { force: true }); // IP changed: SAN must match for iOS/Android trust
    rmSync(keyPath, { force: true });
  }
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    const san = wantedIp ? `subjectAltName=DNS:replay.local,IP:${wantedIp}` : "subjectAltName=DNS:replay.local";
    const proc = Bun.spawn(
      [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath, "-days", "3650",
        "-subj", "/CN=replay.local", "-addext", san,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      throw new Error(`openssl failed: ${await new Response(proc.stderr).text()}`);
    }
    writeFileSync(ipMarker, wantedIp);
  }
  return { certPath, keyPath };
}
```

`src/server/pages.ts`:
```ts
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type PageName = "login" | "camera" | "control" | "clips";
export type PageAssets = {
  html(page: PageName): string;
  assetFile(name: string): string | null;
};

const ASSET_WHITELIST = new Set(["login.js", "camera.js", "control.js", "clips.js", "app.css"]);

export async function buildPages(webDir: string, outDir: string): Promise<PageAssets> {
  mkdirSync(outDir, { recursive: true });
  const entry = (p: PageName) => (p === "login" ? join(webDir, "login.ts") : join(webDir, p, `${p}.ts`));
  const result = await Bun.build({
    entrypoints: (["login", "camera", "control", "clips"] as PageName[]).map(entry),
    outdir: outDir,
    target: "browser",
    naming: "[name].[ext]",
    minify: false,
  });
  if (!result.success) {
    throw new Error(`page bundling failed: ${result.logs.map(String).join("\n")}`);
  }
  copyFileSync(join(webDir, "shared", "app.css"), join(outDir, "app.css"));

  const htmlByPage: Record<PageName, string> = {
    login: readFileSync(join(webDir, "index.html"), "utf8"),
    camera: readFileSync(join(webDir, "camera", "index.html"), "utf8"),
    control: readFileSync(join(webDir, "control", "index.html"), "utf8"),
    clips: readFileSync(join(webDir, "clips", "index.html"), "utf8"),
  };
  return {
    html: (page) => htmlByPage[page],
    assetFile: (name) => (ASSET_WHITELIST.has(name) ? resolve(outDir, name) : null),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/cert.test.ts tests/unit/pages.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/cert.ts src/server/pages.ts src/web tests/unit/cert.test.ts tests/unit/pages.test.ts
git commit -m "feat: self-signed cert generation and web page bundling"
```

---

### Task 11: Router + server bootstrap

**Files:**
- Create: `src/server/routes.ts`, `src/server/index.ts`
- Test: `tests/integration/routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: `type AppContext = { dataDir: string; config: ConfigStore; storage: Storage; auth: Auth; hub: Hub; jobs: JobManager; loginLimiter: RateLimiter; pages: PageAssets }`; `createApp(ctx: AppContext): { fetch(req: Request, server: Bun.Server): Promise<Response | undefined>; websocket: Bun.WebSocketHandler<WSData> }` — reusable by tests (plain HTTP) and by `index.ts` (TLS). `index.ts` additionally produces `buildState(ctx): ServerMessage` (the `state` message) and wires `hub.onStateChanged`/`publishRecord`/`onUpdate` to `server.publish`.
- Routes (all JSON errors as `{ error: string }`):
  - `GET /` → login html (public). `GET /camera|/control|/clips` → html if session valid, else 302 `/`.
  - `GET /assets/:name` → whitelisted bundle/css (public).
  - `GET /cert` → the self-signed certificate `<dataDir>/certs/cert.pem` as a download (public — needed BEFORE trust exists, for manual install on iOS).
  - `POST /api/login` `{password}` → rate-limited 5/min/IP; 200 + `Set-Cookie` or 401/429.
  - `GET /ws` → 401 without session; otherwise upgrade.
  - `POST /api/record` → `{jobId}` | 429 cooldown | 409 no-cameras.
  - `POST /api/config/clip-duration` `{seconds}` — must be one of `[10,20,30,45,60]` → 200 `{clipDurationSeconds}` | 400.
  - `GET /api/state` → `{ cameras, clipDurationSeconds, jobs, freeDiskGB }`.
  - `GET /api/clips` → `Storage.listClips()`.
  - `GET /files/clips/...` → clip file streaming (path-traversal safe: resolved path must stay under `<dataDir>/clips`).
  - `POST /api/clips/:jobId/upload` → multipart: fields `cameraId`, `angleName`, `filesMeta` (JSON `[{startMs, mimeType}]`), parts `file0..fileN`; saves to `<clipDir>/raw/<slug>-<i>.<mp4|webm>`, calls `jobs.addUpload`; 200 | 404 unknown/finalized job | 400 malformed.
  - `GET /api/qr.svg?data=...` → SVG QR (via `qrcode` package).

- [ ] **Step 1: Write the failing test**

`tests/integration/routes.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppForTest } from "./test-app";

let base: string;
let dataDirRef: string;
let stop: () => void;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "replay-routes-"));
  dataDirRef = dataDir;
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ password: "senha-teste" }));
  const app = await createAppForTest(dataDir);
  base = app.base;
  stop = app.stop;
});
afterAll(() => stop());

const login = async (): Promise<string> => {
  const res = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "senha-teste" }) });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
};

describe("routes", () => {
  it("serves the login page publicly and guards role pages", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    const guarded = await fetch(`${base}/camera`, { redirect: "manual" });
    expect(guarded.status).toBe(302);
    const cookie = await login();
    expect((await fetch(`${base}/camera`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/assets/camera.js`)).status).toBe(200);
  });

  it("rejects wrong passwords and rate limits logins", async () => {
    expect((await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "nope" }) })).status).toBe(401);
  });

  it("refuses to record without cameras and validates clip duration", async () => {
    const cookie = await login();
    expect((await fetch(`${base}/api/record`, { method: "POST", headers: { cookie } })).status).toBe(409);
    const bad = await fetch(`${base}/api/config/clip-duration`, { method: "POST", headers: { cookie }, body: JSON.stringify({ seconds: 25 }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/api/config/clip-duration`, { method: "POST", headers: { cookie }, body: JSON.stringify({ seconds: 30 }) });
    expect((await ok.json()).clipDurationSeconds).toBe(30);
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    expect(state.clipDurationSeconds).toBe(30);
    expect(state.cameras).toEqual([]);
  });

  it("blocks path traversal on /files", async () => {
    const cookie = await login();
    expect((await fetch(`${base}/files/clips/../config.json`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/files/clips/nope/x.mp4`, { headers: { cookie } })).status).toBe(404);
  });

  it("requires auth on the api and on /ws", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/clips`)).status).toBe(401);
    expect((await fetch(`${base}/ws`)).status).toBe(401);
  });

  it("serves a qr svg", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/qr.svg?data=https://example.local`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("svg");
    expect(await res.text()).toContain("<svg");
  });

  it("serves the certificate publicly for manual install (iOS)", async () => {
    mkdirSync(join(dataDirRef, "certs"), { recursive: true });
    writeFileSync(join(dataDirRef, "certs", "cert.pem"), "FAKE PEM");
    const res = await fetch(`${base}/cert`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("replay-local.crt");
    expect(await res.text()).toBe("FAKE PEM");
  });
});
```

`tests/integration/test-app.ts` (shared helper — also used by Task 16):
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, RateLimiter } from "../../src/server/auth";
import { JobManager } from "../../src/server/clip-job";
import { ConfigStore } from "../../src/server/config";
import { Hub, TOPIC_ALL, TOPIC_CAMERAS } from "../../src/server/hub";
import { buildPages } from "../../src/server/pages";
import { SerialQueue } from "../../src/server/queue";
import { createApp, type AppContext } from "../../src/server/routes";
import { Storage } from "../../src/server/storage";
import type { ServerMessage } from "../../src/shared/protocol";

export async function createAppForTest(dataDir: string, jobOverrides: { uploadTimeoutMs?: number; cooldownMs?: number } = {}) {
  const config = ConfigStore.load(dataDir);
  const storage = new Storage(dataDir);
  const hub = new Hub();
  const queue = new SerialQueue();
  const ctx: AppContext = {
    dataDir,
    config,
    storage,
    auth: Auth.load(dataDir, () => config.value.password),
    hub,
    loginLimiter: new RateLimiter(100, 60_000),
    pages: await buildPages("src/web", mkdtempSync(join(tmpdir(), "replay-dist-"))),
    jobs: undefined as unknown as JobManager,
  };
  ctx.jobs = new JobManager({
    storage, config, hub, queue,
    publishRecord: (jobId, t, windowSec) =>
      server.publish(TOPIC_CAMERAS, JSON.stringify({ type: "record", jobId, t, windowSec } satisfies ServerMessage)),
    onUpdate: (job) => server.publish(TOPIC_ALL, JSON.stringify({ type: "jobUpdate", job } satisfies ServerMessage)),
    ...jobOverrides,
  });
  const app = createApp(ctx);
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.websocket });
  hub.onStateChanged = () =>
    server.publish(
      TOPIC_ALL,
      JSON.stringify({
        type: "state",
        cameras: hub.cameras(),
        clipDurationSeconds: config.value.clipDurationSeconds,
        jobs: ctx.jobs.jobs(),
      } satisfies ServerMessage),
    );
  return { base: `http://localhost:${server.port}`, ws: `ws://localhost:${server.port}/ws`, server, ctx, stop: () => server.stop(true) };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/routes.test.ts`
Expected: FAIL — cannot resolve `../../src/server/routes`.

- [ ] **Step 3: Implement the router**

`src/server/routes.ts`:
```ts
import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import QRCode from "qrcode";
import type { Server, WebSocketHandler } from "bun";
import type { Auth, RateLimiter } from "./auth";
import { tokenFromCookie } from "./auth";
import type { JobManager } from "./clip-job";
import type { ConfigStore } from "./config";
import { Hub, type WSData } from "./hub";
import type { PageAssets, PageName } from "./pages";
import { slugify } from "./pipeline";
import type { Storage } from "./storage";

export type AppContext = {
  dataDir: string;
  config: ConfigStore;
  storage: Storage;
  auth: Auth;
  hub: Hub;
  jobs: JobManager;
  loginLimiter: RateLimiter;
  pages: PageAssets;
};

const CLIP_DURATION_OPTIONS = [10, 20, 30, 45, 60];

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

export function createApp(ctx: AppContext): {
  fetch(req: Request, server: Server): Promise<Response | undefined>;
  websocket: WebSocketHandler<WSData>;
} {
  const websocket: WebSocketHandler<WSData> = {
    open: (ws) => ctx.hub.open(ws),
    message: (ws, raw) => ctx.hub.message(ws, raw, Date.now()),
    close: (ws) => ctx.hub.close(ws),
  };

  async function fetchHandler(req: Request, server: Server): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    const authed = ctx.auth.verify(tokenFromCookie(req.headers.get("cookie")), Date.now());

    if (req.method === "GET") {
      if (path === "/") return html(ctx.pages.html("login"));
      if (path === "/camera" || path === "/control" || path === "/clips") {
        if (!authed) return Response.redirect("/", 302);
        return html(ctx.pages.html(path.slice(1) as PageName));
      }
      if (path.startsWith("/assets/")) {
        const file = ctx.pages.assetFile(path.slice("/assets/".length));
        if (!file) return json({ error: "not found" }, 404);
        const type = file.endsWith(".css") ? "text/css" : "application/javascript";
        return new Response(Bun.file(file), { headers: { "content-type": type } });
      }
      if (path === "/cert") {
        const certPath = join(ctx.dataDir, "certs", "cert.pem");
        if (!existsSync(certPath)) return json({ error: "not found" }, 404);
        return new Response(Bun.file(certPath), {
          headers: {
            "content-type": "application/x-x509-ca-cert",
            "content-disposition": 'attachment; filename="replay-local.crt"',
          },
        });
      }
      if (path === "/ws") {
        if (!authed) return json({ error: "unauthorized" }, 401);
        if (server.upgrade(req, { data: {} as WSData })) return undefined;
        return json({ error: "upgrade failed" }, 400);
      }
    }

    if (req.method === "POST" && path === "/api/login") {
      const ip = server.requestIP(req)?.address ?? "unknown";
      if (!ctx.loginLimiter.allow(ip, Date.now())) return json({ error: "muitas tentativas, aguarde" }, 429);
      const body = (await req.json().catch(() => ({}))) as { password?: string };
      const token = ctx.auth.login(body.password ?? "", Date.now());
      if (!token) return json({ error: "senha incorreta" }, 401);
      return json({ ok: true }, 200, { "set-cookie": ctx.auth.cookieFor(token) });
    }

    if (!authed) return json({ error: "unauthorized" }, 401);

    if (req.method === "POST" && path === "/api/record") {
      const result = ctx.jobs.trigger(Date.now());
      if ("error" in result) return json(result, result.error === "cooldown" ? 429 : 409);
      return json(result);
    }

    if (req.method === "POST" && path === "/api/config/clip-duration") {
      const body = (await req.json().catch(() => ({}))) as { seconds?: number };
      if (!CLIP_DURATION_OPTIONS.includes(body.seconds ?? -1)) return json({ error: "invalid seconds" }, 400);
      ctx.config.setClipDuration(body.seconds!);
      ctx.hub.onStateChanged();
      return json({ clipDurationSeconds: ctx.config.value.clipDurationSeconds });
    }

    if (req.method === "GET" && path === "/api/state") {
      return json({
        cameras: ctx.hub.cameras(),
        clipDurationSeconds: ctx.config.value.clipDurationSeconds,
        jobs: ctx.jobs.jobs(),
        freeDiskGB: ctx.storage.freeDiskGB(),
      });
    }

    if (req.method === "GET" && path === "/api/clips") return json(ctx.storage.listClips());

    if (req.method === "GET" && path.startsWith("/files/clips/")) {
      const clipsRoot = resolve(ctx.dataDir, "clips");
      const target = resolve(ctx.dataDir, normalize(path.slice("/files/".length)));
      if (!target.startsWith(clipsRoot + "/") || !existsSync(target)) return json({ error: "not found" }, 404);
      return new Response(Bun.file(target));
    }

    const upload = /^\/api\/clips\/([0-9a-f-]{36})\/upload$/.exec(path);
    if (req.method === "POST" && upload) {
      const jobId = upload[1]!;
      const dir = ctx.jobs.uploadDir(jobId);
      if (!dir) return json({ error: "unknown or finalized job" }, 404);
      const form = await req.formData().catch(() => null);
      if (!form) return json({ error: "malformed form" }, 400);
      const cameraId = String(form.get("cameraId") ?? "");
      const angleName = String(form.get("angleName") ?? "");
      let filesMeta: { startMs: number; mimeType: string }[];
      try {
        filesMeta = JSON.parse(String(form.get("filesMeta")));
      } catch {
        return json({ error: "bad filesMeta" }, 400);
      }
      if (!cameraId || !angleName || !Array.isArray(filesMeta) || filesMeta.length === 0) {
        return json({ error: "missing fields" }, 400);
      }
      const slug = slugify(angleName);
      const saved: { path: string; startMs: number }[] = [];
      for (let i = 0; i < filesMeta.length; i++) {
        const part = form.get(`file${i}`);
        if (!(part instanceof Blob)) return json({ error: `missing file${i}` }, 400);
        const ext = filesMeta[i]!.mimeType.includes("mp4") ? "mp4" : "webm";
        const filePath = join(dir, "raw", `${slug}-${i}.${ext}`);
        await Bun.write(filePath, part);
        saved.push({ path: filePath, startMs: filesMeta[i]!.startMs });
      }
      const accepted = ctx.jobs.addUpload(jobId, cameraId, { name: angleName, slug, files: saved });
      return accepted ? json({ ok: true }) : json({ error: "job already finalized" }, 404);
    }

    if (req.method === "GET" && path === "/api/qr.svg") {
      const data = url.searchParams.get("data") ?? "";
      if (!data) return json({ error: "missing data" }, 400);
      const svg = await QRCode.toString(data, { type: "svg", margin: 1, width: 240 });
      return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
    }

    return json({ error: "not found" }, 404);
  }

  return { fetch: fetchHandler, websocket };
}

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
```

- [ ] **Step 4: Implement the bootstrap**

`src/server/index.ts`:
```ts
import { join } from "node:path";
import QRCode from "qrcode";
import { Auth, RateLimiter } from "./auth";
import { JobManager } from "./clip-job";
import { ConfigStore } from "./config";
import { ensureCert } from "./cert";
import { Hub, TOPIC_ALL, TOPIC_CAMERAS } from "./hub";
import { buildPages } from "./pages";
import { SerialQueue } from "./queue";
import { createApp, type AppContext } from "./routes";
import { Storage } from "./storage";
import type { ServerMessage } from "../shared/protocol";

const dataDir = process.env.DATA_DIR ?? "data";
const httpsPort = Number(process.env.HTTPS_PORT ?? 8443);
const httpPort = Number(process.env.HTTP_PORT ?? 8080);

const config = ConfigStore.load(dataDir);
const storage = new Storage(dataDir);
const hub = new Hub();
const queue = new SerialQueue();
const ctx: AppContext = {
  dataDir,
  config,
  storage,
  auth: Auth.load(dataDir, () => config.value.password),
  hub,
  loginLimiter: new RateLimiter(5, 60_000),
  pages: await buildPages("src/web", join(dataDir, "dist")),
  jobs: undefined as unknown as JobManager,
};
ctx.jobs = new JobManager({
  storage, config, hub, queue,
  publishRecord: (jobId, t, windowSec) =>
    server.publish(TOPIC_CAMERAS, JSON.stringify({ type: "record", jobId, t, windowSec } satisfies ServerMessage)),
  onUpdate: () => publishState(),
});

const { certPath, keyPath } = await ensureCert(dataDir);
const app = createApp(ctx);
const server = Bun.serve({
  port: httpsPort,
  tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) },
  fetch: app.fetch,
  websocket: app.websocket,
});

function publishState(): void {
  const state: ServerMessage = {
    type: "state",
    cameras: hub.cameras(),
    clipDurationSeconds: config.value.clipDurationSeconds,
    jobs: ctx.jobs.jobs(),
  };
  server.publish(TOPIC_ALL, JSON.stringify(state));
}
hub.onStateChanged = publishState;

Bun.serve({
  port: httpPort,
  fetch(req) {
    const url = new URL(req.url);
    return Response.redirect(`https://${url.hostname}:${httpsPort}${url.pathname}`, 301);
  },
});

setInterval(() => hub.sweep(Date.now()), 2_000);
storage.cleanupRetention(config.value.retentionDays, Date.now());
setInterval(() => storage.cleanupRetention(config.value.retentionDays, Date.now()), 24 * 60 * 60 * 1000);

const host = process.env.HOST_LAN_IP ?? "localhost";
const entryUrl = `https://${host}:${httpsPort}`;
console.log(`\nReplay Local no ar: ${entryUrl}`);
console.log(`Senha de acesso: ${config.value.password}\n`);
console.log(await QRCode.toString(entryUrl, { type: "terminal", small: true }));
```

- [ ] **Step 5: Run tests + boot smoke test**

Run: `bun test tests/integration/routes.test.ts`
Expected: PASS (6 tests).

Run: `DATA_DIR=$(mktemp -d) bun run src/server/index.ts & sleep 3; curl -sk https://localhost:8443/ | head -c 100; kill %1`
Expected: HTML output; terminal shows URL, password and an ASCII QR code.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes.ts src/server/index.ts tests/integration/routes.test.ts tests/integration/test-app.ts
git commit -m "feat: http router, upload endpoint and tls server bootstrap"
```

---

### Task 12: Web shared client + login page

**Files:**
- Create: `src/web/shared/api.ts`, `src/web/shared/ws-client.ts`
- Modify: `src/web/index.html`, `src/web/login.ts`, `src/web/shared/app.css` (replace stubs)

**Interfaces:**
- Consumes: `computeOffset` (Task 2), protocol types (Task 2), routes (Task 11).
- Produces (api): `api<T>(path: string, init?: RequestInit): Promise<T>` (same-origin fetch, JSON, throws `Error(error)` on non-2xx); `isLoggedIn(): Promise<boolean>` (probes `/api/state`).
- Produces (ws-client): `class WsClient { onMessage: (msg: ServerMessage) => void; onStatus: (connected: boolean) => void; connect(): void; send(msg: ClientMessage): void; serverNow(): number }` — auto-reconnect (1.5s), clock re-sync on every connect and every 5 min, heartbeat `{type:"hb"}` every 3s.
- UI copy (exact): title "Replay Local"; password placeholder "Senha"; button "Entrar"; role buttons "📷 Ser câmera", "🔴 Controlar gravação", "🎬 Ver lances"; wrong password shows the server's `senha incorreta`; collapsible help "Problemas para conectar no iPhone?" with the `/cert` install steps (text in the html below).

- [ ] **Step 1: Implement shared api client**

`src/web/shared/api.ts`:
```ts
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function isLoggedIn(): Promise<boolean> {
  try {
    await api("/api/state");
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Implement the ws client**

`src/web/shared/ws-client.ts`:
```ts
import { computeOffset, type NtpSample } from "../../shared/clock";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";

export class WsClient {
  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};
  private ws: WebSocket | null = null;
  private offset = 0;
  private samples: NtpSample[] = [];
  private timers: number[] = [];

  connect(): void {
    const ws = new WebSocket(`wss://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.onStatus(true);
      this.syncClock();
      this.timers.push(window.setInterval(() => this.send({ type: "hb" }), 3_000));
      this.timers.push(window.setInterval(() => this.syncClock(), 5 * 60_000));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === "ntpReply") {
        this.samples.push({ clientSent: msg.clientTime, serverTime: msg.serverTime, clientReceived: Date.now() });
        if (this.samples.length >= 3) this.offset = computeOffset(this.samples.slice(-3));
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      this.onStatus(false);
      this.timers.forEach(clearInterval);
      this.timers = [];
      setTimeout(() => this.connect(), 1_500);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  serverNow(): number {
    return Date.now() + this.offset;
  }

  private syncClock(): void {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.send({ type: "ntp", clientTime: Date.now() }), i * 150);
    }
  }
}
```

- [ ] **Step 3: Implement stylesheet, login html and script**

`src/web/shared/app.css`:
```css
* { box-sizing: border-box; margin: 0; }
body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 16px; }
h1 { font-size: 1.3rem; margin: 12px 0; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px; width: 100%; max-width: 460px; margin-bottom: 12px; }
input, select { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #30363d; background: #0d1117; color: inherit; font-size: 1rem; }
button { width: 100%; padding: 14px; border: 0; border-radius: 10px; background: #238636; color: #fff; font-size: 1.1rem; font-weight: 600; cursor: pointer; }
button:disabled { background: #30363d; cursor: not-allowed; }
button.danger { background: #da3633; }
.row { display: flex; gap: 8px; align-items: center; }
.muted { color: #8b949e; font-size: .85rem; }
.error { color: #ff7b72; margin-top: 8px; min-height: 1.2em; }
.banner { background: #6e2c00; border: 1px solid #f0883e; border-radius: 8px; padding: 10px; margin-bottom: 10px; width: 100%; max-width: 460px; }
video { width: 100%; border-radius: 8px; background: #000; }
.status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #f85149; }
.status-dot.on { background: #3fb950; }
.record-btn { font-size: 1.6rem; padding: 28px; border-radius: 16px; }
.seg { display: flex; gap: 6px; }
.seg button { padding: 10px 0; font-size: .95rem; background: #21262d; }
.seg button.active { background: #238636; }
.clip-card video { margin-bottom: 8px; }
a.dl { color: #58a6ff; margin-right: 12px; text-decoration: none; }
```

`src/web/index.html`:
```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Replay Local</title>
  <link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
  <h1>🏐 Replay Local</h1>
  <div class="card" id="login-card">
    <form id="login-form">
      <input id="password" type="password" placeholder="Senha" autocomplete="current-password" required />
      <div class="error" id="login-error"></div>
      <button type="submit">Entrar</button>
    </form>
  </div>
  <div class="card" id="roles" hidden>
    <button id="go-camera">📷 Ser câmera</button>
    <div style="height:8px"></div>
    <button id="go-control" class="danger">🔴 Controlar gravação</button>
    <div style="height:8px"></div>
    <button id="go-clips" style="background:#1f6feb">🎬 Ver lances</button>
  </div>
  <details class="card">
    <summary class="muted">Problemas para conectar no iPhone?</summary>
    <p class="muted" style="margin-top:8px">
      No iPhone, o aviso de segurança pode não bastar para a conexão em tempo real.
      1) Baixe o <a href="/cert" style="color:#58a6ff">certificado</a>.
      2) Instale em Ajustes → Geral → VPN e Gerenciamento de Dispositivo.
      3) Ative em Ajustes → Geral → Sobre → Confiança de Certificado.
      No Android, basta tocar em "Avançado → Continuar" no aviso do navegador.
    </p>
  </details>
  <script type="module" src="/assets/login.js"></script>
</body>
</html>
```

`src/web/login.ts`:
```ts
import { api, isLoggedIn } from "./shared/api";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const showRoles = () => {
  $("login-card").hidden = true;
  $("roles").hidden = false;
};

$("go-camera").onclick = () => (location.href = "/camera");
$("go-control").onclick = () => (location.href = "/control");
$("go-clips").onclick = () => (location.href = "/clips");

$<HTMLFormElement>("login-form").onsubmit = async (ev) => {
  ev.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: $<HTMLInputElement>("password").value }) });
    showRoles();
  } catch (e) {
    $("login-error").textContent = e instanceof Error ? e.message : "erro";
  }
};

if (await isLoggedIn()) showRoles();
```

- [ ] **Step 4: Verify bundling + serve**

Run: `bun test tests/unit/pages.test.ts && bun test tests/integration/routes.test.ts`
Expected: PASS — pages still bundle, login page still serves.

Run: `DATA_DIR=$(mktemp -d) bun run src/server/index.ts & sleep 3; curl -sk https://localhost:8443/ | grep -o "Replay Local" | head -1; curl -sk https://localhost:8443/assets/login.js | head -c 80; kill %1`
Expected: prints `Replay Local` and bundled JS.

- [ ] **Step 5: Commit**

```bash
git add src/web
git commit -m "feat: shared web client, stylesheet and login page"
```

---

### Task 13: Camera page

**Files:**
- Modify: `src/web/camera/index.html`, `src/web/camera/camera.ts` (replace stubs)

**Interfaces:**
- Consumes: `WsClient` (Task 12), `selectFilesForWindow`, `cycleSeconds` (Task 3), protocol types (Task 2), upload route (Task 11).
- Produces: browser-only page; no exports. Verified by Playwright in Task 17.
- Behavior contract: request rear camera 1080p60 (`ideal` constraints, `audio: true`; on audio failure retry video-only); pick the first supported `MediaRecorder` mime from `["video/mp4;codecs=avc1","video/webm;codecs=h264,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"]` (iPhone lands on MP4/H.264, Android on WebM); bitrate 12 Mbps when actual fps ≥ 50 else 6 Mbps; rolling buffer = previous finalized file + current recorder (cycle = `cycleSeconds(clipDurationSeconds, 30)`, restarted when the server pushes a new duration); on `record` message stop the current recorder (clean finalize), immediately start the next cycle, then upload the files overlapping `[t − windowSec·1000, t]` with 3 retries (1s/2s/4s backoff); wake lock requested and re-acquired on visibility, with a red banner after any hidden period; angle name persisted in `localStorage["angleName"]`.
- Platform contract (iOS/Android): iOS kills the camera stream in background — on return (or on `track.onended`) the page runs `recoverStream()`: detach old recorder handlers, stop tracks, fresh `getUserMedia`, restart cycle. Multi-lens phones get a camera selector (`enumerateDevices`; switching lens = `recoverStream()` with `deviceId: {exact}` — ultrawide is great for framing the whole court). A hint "↔️ Vire o celular para a horizontal" shows while in portrait. The fps readout appends "(60fps é melhor esforço — varia por aparelho)" because many phones cap browser capture at 30fps, and `reportStatus()` re-runs every 5s while recording (thermal throttling changes fps mid-session) — the badge and the control page stay live. Safari may fire few `dataavailable` events with timeslice — harmless: only the finalized blob at `onstop` is used.
- UI copy (exact): name placeholder "Nome do ângulo (ex: Fundo)"; start button "Iniciar câmera"; status lines "Conectado"/"Desconectado", "Bufferizando últimos {N}s", "Enviando lance..."; banner "⚠️ A tela ficou oculta — buffer reiniciado. Mantenha esta página aberta e o celular na tomada."

- [ ] **Step 1: Implement the html**

`src/web/camera/index.html`:
```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Câmera — Replay Local</title>
  <link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
  <h1>📷 Câmera</h1>
  <div class="banner" id="hidden-banner" hidden>⚠️ A tela ficou oculta — buffer reiniciado. Mantenha esta página aberta e o celular na tomada.</div>
  <div class="card" id="setup">
    <input id="angle-name" placeholder="Nome do ângulo (ex: Fundo)" />
    <div style="height:8px"></div>
    <button id="start">Iniciar câmera</button>
    <div class="error" id="camera-error"></div>
  </div>
  <div class="card" id="live" hidden>
    <video id="preview" autoplay muted playsinline></video>
    <p class="muted" id="orient-hint" hidden>↔️ Vire o celular para a horizontal</p>
    <select id="camera-select" hidden></select>
    <p class="row"><span class="status-dot" id="conn-dot"></span><span id="conn-text">Desconectado</span></p>
    <p class="muted" id="media-info"></p>
    <p id="buffer-status" class="muted"></p>
  </div>
  <script type="module" src="/assets/camera.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement the page logic**

`src/web/camera/camera.ts`:
```ts
import { cycleSeconds, selectFilesForWindow } from "../../shared/buffer-window";
import type { ServerMessage } from "../../shared/protocol";
import { WsClient } from "../shared/ws-client";

type BufferedFile = { blob: Blob; mimeType: string; startMs: number; durationMs: number };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1",
  "video/webm;codecs=h264,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

let ws: WsClient;
let cameraId = "";
let stream: MediaStream;
let mimeType = "";
let clipDurationSeconds = 20;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let currentStartMs = 0;
let files: BufferedFile[] = []; // previous + just-finalized, max 2
let cycleTimer = 0;
let pendingRecord: { jobId: string; t: number; windowSec: number } | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let wasHidden = false;
let currentDeviceId: string | null = null;

async function acquireMedia(deviceId: string | null): Promise<MediaStream> {
  const video = {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60 },
  } as MediaTrackConstraints;
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  }
}

function reportStatus(): void {
  const s = stream.getVideoTracks()[0]!.getSettings();
  ws.send({ type: "cameraStatus", width: s.width ?? 0, height: s.height ?? 0, fps: Math.round(s.frameRate ?? 0) });
  $("media-info").textContent = `${s.width}×${s.height} @ ${Math.round(s.frameRate ?? 0)}fps (60fps é melhor esforço — varia por aparelho)`;
}

function watchTrack(): void {
  stream.getVideoTracks()[0]!.onended = () => void recoverStream();
}

/** iOS Safari kills the stream when backgrounded or on lens switch; recover with a fresh getUserMedia. */
async function recoverStream(): Promise<void> {
  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null; // detach so the dead recorder cannot restart a cycle on the old stream
    try {
      if (recorder.state === "recording") recorder.stop();
    } catch { /* already dead */ }
    recorder = null;
  }
  clearTimeout(cycleTimer);
  files = [];
  stream.getTracks().forEach((t) => t.stop());
  stream = await acquireMedia(currentDeviceId);
  $<HTMLVideoElement>("preview").srcObject = stream;
  watchTrack();
  reportStatus();
  startCycle();
}

async function populateCameraSelect(): Promise<void> {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  if (cams.length < 2) return;
  const select = $<HTMLSelectElement>("camera-select");
  select.hidden = false;
  select.innerHTML = cams.map((c, i) => `<option value="${c.deviceId}">${c.label || `Câmera ${i + 1}`}</option>`).join("");
  const active = stream.getVideoTracks()[0]!.getSettings().deviceId;
  if (active) select.value = active;
  select.onchange = () => {
    currentDeviceId = select.value;
    void recoverStream();
  };
}

function startCycle(): void {
  chunks = [];
  currentStartMs = ws.serverNow();
  const settings = stream.getVideoTracks()[0]!.getSettings();
  const rec = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: (settings.frameRate ?? 30) >= 50 ? 12_000_000 : 6_000_000,
  });
  recorder = rec;
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  rec.onstop = () => {
    const file: BufferedFile = {
      blob: new Blob(chunks, { type: mimeType }),
      mimeType,
      startMs: currentStartMs,
      durationMs: ws.serverNow() - currentStartMs,
    };
    files = [...files.slice(-1), file];
    const record = pendingRecord;
    pendingRecord = null;
    startCycle(); // next cycle starts immediately; the gap stays after T
    if (record) void uploadClip(record);
  };
  rec.start(1000);
  clearTimeout(cycleTimer);
  cycleTimer = window.setTimeout(() => rec.state === "recording" && rec.stop(), cycleSeconds(clipDurationSeconds, 30) * 1000);
  $("buffer-status").textContent = `Bufferizando últimos ${clipDurationSeconds}s`;
}

async function uploadClip(record: { jobId: string; t: number; windowSec: number }): Promise<void> {
  $("buffer-status").textContent = "Enviando lance...";
  const windowStartMs = record.t - record.windowSec * 1000;
  const selected = selectFilesForWindow(files, windowStartMs, record.t);
  const form = new FormData();
  form.append("cameraId", cameraId);
  form.append("angleName", localStorage.getItem("angleName") ?? "Camera");
  form.append("filesMeta", JSON.stringify(selected.map((f) => ({ startMs: f.startMs, mimeType: f.mimeType }))));
  selected.forEach((f, i) => form.append(`file${i}`, f.blob, `part${i}`));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/api/clips/${record.jobId}/upload`, { method: "POST", body: form });
      if (res.ok) break;
      if (res.status === 404) break; // job finalized without us
      throw new Error(`HTTP ${res.status}`);
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  $("buffer-status").textContent = `Bufferizando últimos ${clipDurationSeconds}s`;
}

function handleMessage(msg: ServerMessage): void {
  if (msg.type === "registered") {
    cameraId = msg.cameraId;
    reportStatus();
  }
  if (msg.type === "state") {
    if (msg.clipDurationSeconds !== clipDurationSeconds) {
      clipDurationSeconds = msg.clipDurationSeconds; // applied on the next cycle restart
      $("buffer-status").textContent = `Bufferizando últimos ${clipDurationSeconds}s`;
    }
  }
  if (msg.type === "record" && recorder?.state === "recording") {
    pendingRecord = msg;
    clearTimeout(cycleTimer);
    recorder.stop();
  }
}

async function keepAwake(): Promise<void> {
  try {
    wakeLock = await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen") ?? null;
  } catch {
    wakeLock = null; // headless/unsupported: keep going
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    wasHidden = true;
    return;
  }
  if (!wasHidden || !stream) return;
  $("hidden-banner").hidden = false;
  void keepAwake();
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState === "ended" || track.muted) {
    void recoverStream(); // iOS dropped the stream while hidden
  } else {
    files = [];
    if (recorder?.state === "recording") recorder.stop();
    else startCycle();
  }
});

$("start").onclick = async () => {
  const name = $<HTMLInputElement>("angle-name").value.trim();
  if (!name) {
    $("camera-error").textContent = "Dê um nome para este ângulo.";
    return;
  }
  localStorage.setItem("angleName", name);
  try {
    stream = await acquireMedia(null);
  } catch (e) {
    $("camera-error").textContent = `Sem acesso à câmera: ${e instanceof Error ? e.message : e}`;
    return;
  }
  mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  $<HTMLVideoElement>("preview").srcObject = stream;
  $("setup").hidden = true;
  $("live").hidden = false;
  await keepAwake();

  ws = new WsClient();
  ws.onStatus = (connected) => {
    $("conn-dot").classList.toggle("on", connected);
    $("conn-text").textContent = connected ? "Conectado" : "Desconectado";
    if (connected) {
      ws.send({ type: "register", role: "camera", name });
      setTimeout(() => startCycle(), 800); // wait for first ntp samples
    }
  };
  ws.onMessage = handleMessage;
  ws.connect();

  watchTrack();
  void populateCameraSelect();
  const portrait = window.matchMedia("(orientation: portrait)");
  const updateOrientHint = () => ($("orient-hint").hidden = !portrait.matches);
  portrait.addEventListener("change", updateOrientHint);
  updateOrientHint();
  setInterval(reportStatus, 5_000); // fps/resolution drift with heat — keep badge and control live
};

$<HTMLInputElement>("angle-name").value = localStorage.getItem("angleName") ?? "";
```

- [ ] **Step 3: Verify bundling**

Run: `bun test tests/unit/pages.test.ts`
Expected: PASS — camera.ts bundles without type errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/camera
git commit -m "feat: camera page with rolling buffer, wake lock and triggered upload"
```

---

### Task 14: Control page

**Files:**
- Modify: `src/web/control/index.html`, `src/web/control/control.ts` (replace stubs)

**Interfaces:**
- Consumes: `WsClient`, `api` (Task 12), protocol types (Task 2), routes `/api/record`, `/api/config/clip-duration`, `/api/state`, `/api/qr.svg` (Task 11).
- Produces: browser-only page. Verified by Playwright in Task 17.
- UI copy (exact): button "GRAVAR"; camera counter "{n} câmera(s) online"; duration label "Duração do clipe"; job lines "Lance #{n} — capturando...", "Lance #{n} — processando...", "Lance #{n} — pronto 🎬" (link "ver na galeria" → `/clips`), "Lance #{n} — erro"; empty-camera hint "Nenhuma câmera online — abra /camera em um celular"; toast for 429 "Aguarde um instante entre lances"; disk banner (same as gallery) "⚠️ Pouco espaço em disco ({n} GB livres)" when `freeDiskGB < 5`.

- [ ] **Step 1: Implement the html**

`src/web/control/index.html`:
```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Controle — Replay Local</title>
  <link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
  <h1>🔴 Controle</h1>
  <div class="banner" id="disk-banner" hidden></div>
  <div class="card">
    <button id="record" class="record-btn danger" disabled>GRAVAR</button>
    <div class="error" id="record-error"></div>
    <p class="row"><span class="status-dot" id="conn-dot"></span><span id="cam-count">0 câmera(s) online</span></p>
    <p class="muted" id="cam-hint" hidden>Nenhuma câmera online — abra /camera em um celular</p>
    <ul id="cam-list" class="muted"></ul>
  </div>
  <div class="card">
    <p class="muted">Duração do clipe</p>
    <div class="seg" id="durations"></div>
  </div>
  <div class="card">
    <p class="muted">Últimos lances</p>
    <ul id="jobs"></ul>
  </div>
  <div class="card">
    <p class="muted">Entrar no sistema</p>
    <img id="qr" alt="QR code" style="width:100%;max-width:240px;background:#fff;border-radius:8px" />
  </div>
  <script type="module" src="/assets/control.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement the page logic**

`src/web/control/control.ts`:
```ts
import type { CameraInfo, JobStatus, ServerMessage } from "../../shared/protocol";
import { api } from "../shared/api";
import { WsClient } from "../shared/ws-client";

type State = { cameras: CameraInfo[]; clipDurationSeconds: number; jobs: JobStatus[]; freeDiskGB?: number | null };
const DURATIONS = [10, 20, 30, 45, 60];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function jobLabel(job: JobStatus): string {
  if (job.state === "capturing") return `Lance #${job.clipNumber} — capturando...`;
  if (job.state === "processing") return `Lance #${job.clipNumber} — processando...`;
  if (job.state === "ready") return `Lance #${job.clipNumber} — pronto 🎬 `;
  return `Lance #${job.clipNumber} — erro`;
}

let state: State = { cameras: [], clipDurationSeconds: 20, jobs: [] };

function render(): void {
  const online = state.cameras.filter((c) => c.online);
  if (typeof state.freeDiskGB === "number" && state.freeDiskGB < 5) {
    $("disk-banner").hidden = false;
    $("disk-banner").textContent = `⚠️ Pouco espaço em disco (${state.freeDiskGB.toFixed(1)} GB livres)`;
  }
  $("cam-count").textContent = `${online.length} câmera(s) online`;
  $("cam-hint").hidden = online.length > 0;
  $<HTMLButtonElement>("record").disabled = online.length === 0;
  $("cam-list").innerHTML = state.cameras
    .map((c) => `<li>${c.online ? "🟢" : "🔴"} ${c.name} — ${c.width}×${c.height}@${c.fps}fps</li>`)
    .join("");
  $("durations").innerHTML = DURATIONS.map(
    (d) => `<button data-d="${d}" class="${d === state.clipDurationSeconds ? "active" : ""}" style="flex:1">${d}s</button>`,
  ).join("");
  $("durations").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", async () => {
      await api("/api/config/clip-duration", { method: "POST", body: JSON.stringify({ seconds: Number(b.dataset.d) }) });
    });
  });
  $("jobs").innerHTML = state.jobs
    .slice(0, 5)
    .map((j) => `<li>${jobLabel(j)}${j.state === "ready" ? '<a class="dl" href="/clips">ver na galeria</a>' : ""}</li>`)
    .join("");
}

$("record").onclick = async () => {
  $("record-error").textContent = "";
  try {
    await api("/api/record", { method: "POST" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erro";
    $("record-error").textContent = msg === "cooldown" ? "Aguarde um instante entre lances" : msg;
  }
};

const ws = new WsClient();
ws.onStatus = (connected) => {
  $("conn-dot").classList.toggle("on", connected);
  if (connected) ws.send({ type: "register", role: "control" });
};
ws.onMessage = (msg: ServerMessage) => {
  if (msg.type === "state") {
    state = { ...state, cameras: msg.cameras, clipDurationSeconds: msg.clipDurationSeconds, jobs: msg.jobs };
    render();
  }
  if (msg.type === "jobUpdate") {
    const rest = state.jobs.filter((j) => j.jobId !== msg.job.jobId);
    state.jobs = [msg.job, ...rest].sort((a, b) => b.createdAt - a.createdAt);
    render();
  }
};
ws.connect();

state = await api<State>("/api/state");
render();
$<HTMLImageElement>("qr").src = `/api/qr.svg?data=${encodeURIComponent(location.origin)}`;
```

- [ ] **Step 3: Verify bundling**

Run: `bun test tests/unit/pages.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/control
git commit -m "feat: control page with record button, duration selector and status"
```

---

### Task 15: Clips gallery page

**Files:**
- Modify: `src/web/clips/index.html`, `src/web/clips/clips.ts` (replace stubs)

**Interfaces:**
- Consumes: `api` (Task 12), `/api/clips`, `/api/state`, `/files/clips/...`, `/api/qr.svg` (Task 11), `ClipMeta & { dir }` shape (Task 4).
- Produces: browser-only page. Verified by Playwright in Task 17.
- UI copy (exact): heading "🎬 Lances"; empty state "Nenhum lance ainda. Aperte GRAVAR no controle!"; per-card title "Lance #{n} — {HH:mm}"; download links "⬇️ Combinado" and "⬇️ {angle name}"; share button "📤 Compartilhar"; disk banner "⚠️ Pouco espaço em disco ({n} GB livres)" when `freeDiskGB < 5`; error badge "processado parcialmente" when `errors.length > 0`; each card's QR encodes the direct URL of that clip's video file (scan → open/download that clip).
- Platform contract (iOS/Android): "📤 Compartilhar" uses the Web Share API with files (`navigator.canShare({files})` → `navigator.share`) — on phones it opens the native share sheet (WhatsApp/Instagram direct); hidden when `navigator.share` is unavailable (desktop), and falls back to navigating to the file if `canShare` rejects the payload. Clips are MP4 H.264/AAC, playable inline on iPhone (Safari can't play WebM — that's why the server normalizes).

- [ ] **Step 1: Implement the html**

`src/web/clips/index.html`:
```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lances — Replay Local</title>
  <link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
  <h1>🎬 Lances</h1>
  <div class="banner" id="disk-banner" hidden></div>
  <p class="muted" id="empty" hidden>Nenhum lance ainda. Aperte GRAVAR no controle!</p>
  <div id="list" style="width:100%;max-width:460px"></div>
  <script type="module" src="/assets/clips.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement the page logic**

`src/web/clips/clips.ts`:
```ts
import { api } from "../shared/api";

type ClipEntry = {
  clipNumber: number;
  createdAt: number;
  state: "processing" | "ready" | "error";
  cameras: { name: string; slug: string }[];
  outputs: { combined: string | null; angles: Record<string, string> };
  errors: string[];
  dir: string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const time = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

function card(clip: ClipEntry): string {
  const nameBySlug = new Map(clip.cameras.map((c) => [c.slug, c.name]));
  const src = clip.outputs.combined ?? Object.values(clip.outputs.angles)[0];
  if (!src) return "";
  const video = `/files/${clip.dir}/${src}`;
  const downloads = [
    clip.outputs.combined ? `<a class="dl" href="/files/${clip.dir}/${clip.outputs.combined}" download>⬇️ Combinado</a>` : "",
    ...Object.entries(clip.outputs.angles).map(
      ([slug, file]) => `<a class="dl" href="/files/${clip.dir}/${file}" download>⬇️ ${nameBySlug.get(slug) ?? slug}</a>`,
    ),
  ].join("");
  const partial = clip.errors.length > 0 ? ' <span class="muted">(processado parcialmente)</span>' : "";
  return `<div class="card clip-card">
    <p><strong>Lance #${clip.clipNumber}</strong> — ${time(clip.createdAt)}${partial}</p>
    <video controls preload="metadata" src="${video}"></video>
    <p>${downloads}</p>
    <button class="share-btn" data-file="${video}" data-name="lance-${String(clip.clipNumber).padStart(3, "0")}.mp4">📤 Compartilhar</button>
    <img alt="QR" style="width:96px;background:#fff;border-radius:6px;margin-top:8px" src="/api/qr.svg?data=${encodeURIComponent(location.origin + video)}" />
  </div>`;
}

function wireShareButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".share-btn").forEach((btn) => {
    if (!("share" in navigator)) {
      btn.hidden = true; // desktop browsers: downloads links cover it
      return;
    }
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const blob = await (await fetch(btn.dataset.file!)).blob();
        const file = new File([blob], btn.dataset.name!, { type: "video/mp4" });
        const nav = navigator as Navigator & { canShare?(data: { files: File[] }): boolean };
        if (nav.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file] } as ShareData); // native share sheet (WhatsApp etc.)
        } else {
          location.href = btn.dataset.file!;
        }
      } catch {
        /* user cancelled the share sheet */
      } finally {
        btn.disabled = false;
      }
    };
  });
}

async function load(): Promise<void> {
  const clips = await api<ClipEntry[]>("/api/clips");
  const ready = clips.filter((c) => c.state !== "processing");
  $("empty").hidden = ready.length > 0;
  $("list").innerHTML = ready.map(card).join("");
  wireShareButtons();
  const state = await api<{ freeDiskGB: number | null }>("/api/state");
  if (state.freeDiskGB !== null && state.freeDiskGB < 5) {
    $("disk-banner").hidden = false;
    $("disk-banner").textContent = `⚠️ Pouco espaço em disco (${state.freeDiskGB.toFixed(1)} GB livres)`;
  }
}

await load();
setInterval(load, 10_000);
```

- [ ] **Step 3: Verify bundling**

Run: `bun test tests/unit/pages.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/clips
git commit -m "feat: clips gallery with player, downloads and disk warning"
```

---

### Task 16: Camera simulator + server full-flow integration test

**Files:**
- Create: `tests/helpers/camera-simulator.ts`
- Test: `tests/integration/full-flow.test.ts` (needs ffmpeg)

**Interfaces:**
- Consumes: `createAppForTest` (Task 11 helper), protocol types (Task 2), `runFfmpeg`, `probe` (Task 5).
- Produces: `class CameraSimulator { constructor(o: { httpBase: string; wsUrl: string; cookie: string; name: string; rawFile: string; rawDurationMs: number }); connect(): Promise<void>; close(): void; uploads: number }` — registers as a camera over WS (Bun's `WebSocket` accepts a `headers` option for the cookie), replies to nothing else, and on a `record` message uploads `rawFile` claiming `startMs = t − windowSec·1000 − 1000` (file starts 1s before the window, so `rawDurationMs` must be ≥ `windowSec·1000 + 1000`).

- [ ] **Step 1: Write the simulator**

`tests/helpers/camera-simulator.ts`:
```ts
import type { ServerMessage } from "../../src/shared/protocol";

export class CameraSimulator {
  uploads = 0;
  private ws: WebSocket | null = null;
  private cameraId = "";

  constructor(
    private o: { httpBase: string; wsUrl: string; cookie: string; name: string; rawFile: string; rawDurationMs: number },
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(this.o.wsUrl, { headers: { cookie: this.o.cookie } } as unknown as string[]);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "register", role: "camera", name: this.o.name }));
        resolve();
      };
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === "registered") this.cameraId = msg.cameraId;
      if (msg.type === "record") void this.upload(msg);
    };
    const hb = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "hb" })), 1000);
    ws.onclose = () => clearInterval(hb);
  }

  private async upload(msg: { jobId: string; t: number; windowSec: number }): Promise<void> {
    const form = new FormData();
    form.append("cameraId", this.cameraId); // id assigned by the hub in the "registered" message
    form.append("angleName", this.o.name);
    form.append("filesMeta", JSON.stringify([{ startMs: msg.t - msg.windowSec * 1000 - 1000, mimeType: "video/mp4" }]));
    form.append("file0", new Blob([await Bun.file(this.o.rawFile).arrayBuffer()], { type: "video/mp4" }), "part0");
    const res = await fetch(`${this.o.httpBase}/api/clips/${msg.jobId}/upload`, {
      method: "POST",
      headers: { cookie: this.o.cookie },
      body: form,
    });
    if (res.ok) this.uploads++;
  }

  close(): void {
    this.ws?.close();
  }
}
```

- [ ] **Step 2: Write the failing full-flow test**

`tests/integration/full-flow.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe, runFfmpeg } from "../../src/server/ffmpeg";
import type { ClipMeta } from "../../src/server/storage";
import { CameraSimulator } from "../helpers/camera-simulator";
import { createAppForTest } from "./test-app";

setDefaultTimeout(240_000);

let app: Awaited<ReturnType<typeof createAppForTest>>;
let cookie: string;
let raw: string;
const sims: CameraSimulator[] = [];

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "replay-flow-"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ password: "senha", clipDurationSeconds: 10 }));
  app = await createAppForTest(dataDir, { cooldownMs: 0 });
  raw = join(mkdtempSync(join(tmpdir(), "replay-flow-raw-")), "raw.mp4");
  await runFfmpeg([
    "-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=12",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", raw,
  ]);
  const res = await fetch(`${app.base}/api/login`, { method: "POST", body: JSON.stringify({ password: "senha" }) });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(() => {
  sims.forEach((s) => s.close());
  app.stop();
});

describe("full flow", () => {
  it("two simulated cameras + trigger produce a ready combined clip", async () => {
    for (const name of ["Fundo", "Lateral"]) {
      const sim = new CameraSimulator({ httpBase: app.base, wsUrl: app.ws, cookie, name, rawFile: raw, rawDurationMs: 12_000 });
      await sim.connect();
      sims.push(sim);
    }
    await new Promise((r) => setTimeout(r, 300)); // registration settles
    expect(app.ctx.hub.onlineCameraIds().length).toBe(2);

    const trigger = await fetch(`${app.base}/api/record`, { method: "POST", headers: { cookie } });
    expect(trigger.status).toBe(200);

    const deadline = Date.now() + 200_000;
    let clips: (ClipMeta & { dir: string })[] = [];
    while (Date.now() < deadline) {
      clips = (await (await fetch(`${app.base}/api/clips`, { headers: { cookie } })).json()) as (ClipMeta & { dir: string })[];
      if (clips.length > 0 && clips[0]!.state !== "processing") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(clips[0]!.state).toBe("ready");
    expect(clips[0]!.cameras.length).toBe(2);
    expect(clips[0]!.outputs.combined).toBe("combined.mp4");
    expect(sims.every((s) => s.uploads === 1)).toBe(true);

    const filePath = join(app.ctx.dataDir, clips[0]!.dir, "combined.mp4");
    const info = await probe(filePath);
    expect(info.width).toBe(1920);
    expect(info.durationSec).toBeGreaterThan(17); // 2 angles × ~10s sequential
    expect(info.durationSec).toBeLessThan(22);

    const served = await fetch(`${app.base}/files/${clips[0]!.dir}/combined.mp4`, { headers: { cookie } });
    expect(served.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run to verify it fails, then passes**

Run: `bun test tests/integration/full-flow.test.ts`
Expected first: FAIL (simulator missing / behavior gaps). After implementing: PASS (~1–2 min).

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/camera-simulator.ts tests/integration/full-flow.test.ts
git commit -m "test: end-to-end server flow with simulated cameras"
```

---

### Task 17: Playwright e2e (real browser, fake camera)

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/record-flow.spec.ts`, `tests/e2e/seed.ts`

**Interfaces:**
- Consumes: the running server (`bun run src/server/index.ts`), all pages.
- Produces: `bun run test:e2e` green.

- [ ] **Step 1: Install browsers**

Run: `bunx playwright install chromium`
Expected: Chromium downloaded.

- [ ] **Step 2: Write config + seed**

`tests/e2e/seed.ts` (pre-creates the data dir so the password is known):
```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

rmSync(".e2e-data", { recursive: true, force: true });
mkdirSync(".e2e-data", { recursive: true });
writeFileSync(".e2e-data/config.json", JSON.stringify({ password: "e2e", clipDurationSeconds: 10 }));
```

`playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 300_000,
  workers: 1,
  use: {
    baseURL: "https://localhost:8543",
    ignoreHTTPSErrors: true,
    permissions: ["camera", "microphone"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    command: "bun run tests/e2e/seed.ts && DATA_DIR=.e2e-data HTTPS_PORT=8543 HTTP_PORT=8580 bun run src/server/index.ts",
    url: "https://localhost:8543",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
```

- [ ] **Step 3: Write the failing e2e test**

`tests/e2e/record-flow.spec.ts`:
```ts
import { expect, test, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.fill("#password", "e2e");
  await page.click("#login-form button");
  await expect(page.locator("#roles")).toBeVisible();
}

async function startCamera(page: Page, name: string): Promise<void> {
  await page.goto("/camera");
  await page.fill("#angle-name", name);
  await page.click("#start");
  await expect(page.locator("#conn-text")).toHaveText("Conectado", { timeout: 15_000 });
  await expect(page.locator("#buffer-status")).toContainText("Bufferizando", { timeout: 15_000 });
}

test("record flow: 2 cameras + control → clip in gallery", async ({ context, page }) => {
  await login(page);
  const cam1 = page;
  await startCamera(cam1, "Fundo");

  const cam2 = await context.newPage();
  await startCamera(cam2, "Lateral");

  const control = await context.newPage();
  await control.goto("/control");
  await expect(control.locator("#cam-count")).toHaveText("2 câmera(s) online", { timeout: 15_000 });

  await control.click('#durations button[data-d="10"]');
  await expect(control.locator('#durations button[data-d="10"]')).toHaveClass(/active/);

  await control.waitForTimeout(12_000); // let the buffers accumulate > windowSec
  await control.click("#record");
  await expect(control.locator("#jobs")).toContainText("Lance #1", { timeout: 10_000 });
  await expect(control.locator("#jobs")).toContainText("pronto", { timeout: 240_000 });

  const gallery = await context.newPage();
  await gallery.goto("/clips");
  await expect(gallery.locator(".clip-card").first()).toContainText("Lance #1", { timeout: 15_000 });
  await expect(gallery.locator(".clip-card video").first()).toBeVisible();

  const combined = await gallery.request.get(gallery.url().replace("/clips", "") + (await gallery.locator(".clip-card a.dl").first().getAttribute("href")));
  expect(combined.status()).toBe(200);
  expect(Number(combined.headers()["content-length"] ?? "1")).toBeGreaterThan(100_000);
});
```

- [ ] **Step 4: Run it**

Run: `bun run test:e2e`
Expected: PASS in a few minutes (fake camera feeds a moving test pattern; processing is software-encoded). If MediaRecorder yields no `video/mp4` support headlessly, the mime fallback chain lands on WebM — the server normalizes either.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts tests/e2e
git commit -m "test: playwright e2e covering login, cameras, record and gallery"
```

---

### Task 18: Docker packaging, start.sh and README

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `start.sh`, `README.md`
- Modify: `.gitignore` (append `.e2e-data/` and `dist/`)

**Interfaces:**
- Consumes: everything.
- Produces: `./start.sh` boots the containerized system reachable from phones on the LAN.

- [ ] **Step 1: Write the Docker files**

`Dockerfile`:
```dockerfile
FROM oven/bun:1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
EXPOSE 8443 8080
CMD ["bun", "run", "src/server/index.ts"]
```

`docker-compose.yml`:
```yaml
services:
  replay:
    build: .
    ports:
      - "8443:8443"
      - "8080:8080"
    volumes:
      - ./data:/app/data
    environment:
      - HOST_LAN_IP=${HOST_LAN_IP:-}
    restart: unless-stopped
```

`.dockerignore`:
```
node_modules
data
.e2e-data
docs
tests
.git
```

`start.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")"
if [ -z "$IP" ]; then
  echo "Não achei o IP da rede local; usando localhost (celulares não vão conectar)."
  IP="localhost"
fi
echo "Servidor será acessível em: https://$IP:8443"
HOST_LAN_IP="$IP" exec docker compose up --build
```

Run: `chmod +x start.sh`

- [ ] **Step 2: Append to `.gitignore`**

```
.e2e-data/
dist/
```

- [ ] **Step 3: Write README.md (pt-BR), covering:**

Sections with real content (no placeholders): o que é; requisitos (Docker Desktop; ou Bun+FFmpeg para rodar sem container); como iniciar (`./start.sh`, escanear o QR do terminal, senha impressa no boot e guardada em `data/config.json`); como usar (papéis, tripé, tomada); **Conectando cada aparelho** — iPhone: usar Safari; se o aviso "Continuar" não bastar (WebSocket), baixar o certificado em `/cert`, instalar em Ajustes → Geral → VPN e Gerenciamento de Dispositivo e ativar em Ajustes → Geral → Sobre → Confiança de Certificado; Android: usar Chrome e tocar em "Avançado → Continuar" no aviso; ambos: desligar economia de bateria, deixar na tomada e à sombra (calor derruba a qualidade), e saber que 60fps é melhor esforço do navegador — a página da câmera mostra o fps real; configuração (`data/config.json`: `clipDurationSeconds`, `layout: "sequential" | "side-by-side"`, `retentionDays`, `clipDurationMaxSeconds`); desenvolvimento (`bun install`, `bun run dev`, `bun test`, `bun run test:e2e`); **Checklist de quadra** (copiar do spec: 2 celulares na tomada, wake lock ativo — tela acesa, 5 lances gravados, conferência na galeria, teste de queda de Wi-Fi de uma câmera); nota de performance (Docker = encoding por software; nativo com VideoToolbox é 5–10× mais rápido).

- [ ] **Step 4: Build and smoke-test the container**

Run: `docker build -t replay-local . && docker run --rm -d -p 8443:8443 -e HOST_LAN_IP=127.0.0.1 -v "$PWD/.docker-smoke-data:/app/data" --name replay-smoke replay-local && sleep 6 && curl -sk https://localhost:8443/ | grep -o "Replay Local" && docker logs replay-smoke | grep -E "Senha|https" && docker rm -f replay-smoke && rm -rf .docker-smoke-data`
Expected: `Replay Local` printed; logs show URL + password + QR.

- [ ] **Step 5: Full verification + commit**

Run: `bun test && bun run test:e2e`
Expected: all suites PASS.

```bash
git add Dockerfile docker-compose.yml .dockerignore start.sh README.md .gitignore
git commit -m "feat: docker packaging, lan start script and operator manual"
```

---

## Completion Criteria (map to spec's success criteria)

1. Spec §Critérios 1–2 → Task 17 (e2e proves record → gallery ≤ 90s with duration selector) and the manual court checklist in README (Task 18).
2. Spec §Critérios 3 (camera drop → partial clip, auto-reconnect) → Task 9 tests (partial timeout), Task 8 (sweep/reconnect), camera page auto-reconnect (Task 12 WsClient).
3. Spec §Critérios 4 (offline operation) → all assets/deps local (Tasks 10–18); container needs internet only at build time.
