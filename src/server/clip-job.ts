import type { JobStatus } from "../shared/protocol";
import type { ConfigStore } from "./config";
import type { Hub } from "./hub";
import { logger } from "./log";
import { processClip, type RawAngle } from "./pipeline";
import type { SerialQueue } from "./queue";
import type { ClipMeta, Storage } from "./storage";

const log = logger("job");

/**
 * Coordinates one triggered clip end-to-end: pick the online cameras expected to upload, wait for
 * their uploads (or a timeout), then hand off to `pipeline.ts` for ffmpeg processing. This is
 * where the "capturing → processing → ready|error" lifecycle (see `protocol.ts#JobState`) is
 * actually driven.
 */

export type TriggerResult = { jobId: string } | { error: "cooldown" | "no-cameras" };

/** Dependency-injection bag. `hub` is narrowed to just `onlineCameraIds` (not the full `Hub`) so
 * it's trivial to fake in tests; `processFn`/`uploadTimeoutMs`/`cooldownMs` are test-only
 * overrides letting tests swap in a fake `processClip` and shrink real-world timeouts. */
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

/** In-flight job state. `expected` is the fixed roster of camera IDs that were online at trigger
 * time (a camera connecting later is never added); `delivered` tracks which of them have actually
 * uploaded so far — finalize-on-completion is exactly `delivered ⊇ expected`. */
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

  /** Most recent jobs, newest first. Capped by the same slice `recent` itself is maintained at
   * (20) — an unbounded list would leak memory over a long session, and the UI only ever shows a
   * handful (`control.ts` displays 5), so 20 is generous headroom without being unbounded. */
  jobs(): JobStatus[] {
    return this.recent.slice(0, 20);
  }

  /**
   * Starts a new clip job for every camera currently online. Rejects with `"cooldown"` (checked
   * first, before touching storage/hub state — cheap protection against rapid button-mashing) or
   * `"no-cameras"`. On success: eagerly creates the clip directory (so `publishRecord` can tell
   * cameras where to upload, and `uploadDir` can validate uploads, before any bytes exist),
   * freezes `expected` to the cameras online right now, and arms a fallback timer that finalizes
   * the job with whatever arrived even if some expected camera never uploads.
   */
  trigger(nowMs: number): TriggerResult {
    if (nowMs - this.lastTriggerAt < (this.deps.cooldownMs ?? 2000)) return { error: "cooldown" };
    const cameraIds = this.deps.hub.onlineCameraIds();
    if (cameraIds.length === 0) return { error: "no-cameras" };
    this.lastTriggerAt = nowMs;

    const clipNumber = this.deps.storage.nextClipNumber();
    const dir = this.deps.storage.createClipDir(clipNumber, nowMs);
    const windowSec = this.deps.config.value.clipDurationSeconds;
    const status: JobStatus = {
      jobId: crypto.randomUUID(),
      clipNumber,
      state: "capturing",
      createdAt: nowMs,
    };
    const job: ActiveJob = {
      status,
      dir,
      t: nowMs,
      windowSec,
      expected: new Set(cameraIds),
      delivered: new Set(),
      angles: [],
      timer: setTimeout(() => this.finalize(status.jobId), this.deps.uploadTimeoutMs ?? 30_000),
    };
    this.active.set(status.jobId, job);
    this.recent.unshift(status);
    this.recent = this.recent.slice(0, 20);
    this.deps.publishRecord(status.jobId, job.t, windowSec);
    this.deps.onUpdate({ ...status });
    log.info("trigger", {
      jobId: status.jobId,
      clipNumber,
      windowSec,
      cameras: cameraIds.length,
    });
    return { jobId: status.jobId };
  }

  /** Upload target directory for `jobId`, or `null` once the job is no longer `"capturing"`
   * (unknown jobId, or already finalized) — `routes.ts` turns `null` into a 404 telling a
   * late-arriving upload it missed the window. */
  uploadDir(jobId: string): string | null {
    const job = this.active.get(jobId);
    return job && job.status.state === "capturing" ? job.dir : null;
  }

  /**
   * Records one camera's uploaded angle for `jobId`. Returns `false` (→ 404 in `routes.ts`) if
   * the job is unknown or already finalized.
   *
   * Idempotent per camera: if `cameraId` already delivered for this job, returns `true` without
   * re-adding anything. This matters because `camera.ts`'s upload has its own retry logic — a
   * request that actually succeeded server-side but whose response was lost to the client would
   * otherwise be retried and double-pushed into `job.angles`, corrupting that camera's angle data.
   *
   * Triggers `finalize` as soon as every expected camera has delivered — the happy-path
   * completion, racing against the timeout timer armed in `trigger` (see `finalize` for how that
   * race is resolved safely).
   */
  addUpload(jobId: string, cameraId: string, angle: RawAngle): boolean {
    const job = this.active.get(jobId);
    if (!job || job.status.state !== "capturing") return false;
    if (job.delivered.has(cameraId)) return true; // idempotent: this camera already delivered
    job.angles.push(angle);
    job.delivered.add(cameraId);
    log.debug("upload added", { jobId, cameraId });
    if ([...job.expected].every((id) => job.delivered.has(id))) this.finalize(jobId);
    return true;
  }

  /**
   * Moves a job from "capturing" to "processing" and queues the actual ffmpeg work. Can be
   * invoked from two places that genuinely race — the upload timeout timer, and the last
   * `addUpload` call completing the expected roster — most obviously when the last camera's
   * upload lands right around the timeout boundary.
   *
   * The `job.status.state !== "capturing"` guard is what makes that race safe: whichever caller
   * runs first flips the state to `"processing"`; the other caller's `finalize` then sees a
   * non-"capturing" state and no-ops immediately. Without this guard both callers would proceed —
   * double-queuing the job, double-writing `meta.json`, and firing `onUpdate` twice with
   * potentially interleaved results. This is the single most important invariant in this file.
   */
  private finalize(jobId: string): void {
    const job = this.active.get(jobId);
    if (!job || job.status.state !== "capturing") return;
    clearTimeout(job.timer);
    job.status.state = "processing";
    log.info("processing", { jobId });
    this.deps.onUpdate({ ...job.status });
    // Heavy ffmpeg work is serialized through the shared queue (see queue.ts) rather than run
    // immediately, so several clips finalizing close together don't all process concurrently.
    void this.deps.queue.push(async () => {
      let finalState: "ready" | "error" = "error";
      let errorMsg = "";
      try {
        const meta = await this.process(job);
        finalState = meta.state === "ready" ? "ready" : "error";
        if (finalState === "error") errorMsg = meta.errors.join("; ") || "processing failed";
      } catch (e) {
        // Last-resort safety net: process() already catches pipeline errors internally, so
        // reaching here means something unexpected (e.g. disk full, OOM) — the job still needs to
        // land in a terminal state and notify clients rather than staying "processing" forever.
        errorMsg = e instanceof Error ? e.message : String(e);
      }
      job.status.state = finalState;
      if (finalState === "error") job.status.error = errorMsg;
      this.active.delete(jobId);
      if (finalState === "ready") {
        log.info("ready", { jobId, clipNumber: job.status.clipNumber, angles: job.angles.length });
      } else {
        log.error("job failed", { jobId, error: errorMsg });
      }
      this.deps.onUpdate({ ...job.status });
    });
  }

  /**
   * Runs the ffmpeg pipeline for `job` and always persists the result as `meta.json`, success or
   * failure — `storage.listClips()` discovers clips purely by scanning for that file, so a failed
   * job that never wrote it would be permanently invisible in the gallery with no record it was
   * ever attempted. Zero uploads is reported as a distinct error ("no camera uploads received")
   * rather than going through the pipeline at all. `state` becomes `"ready"` as soon as there's
   * ANY usable output (combined or even a single angle), even alongside a non-empty `errors[]` —
   * matching `pipeline.ts`'s per-angle partial-failure design.
   */
  private async process(job: ActiveJob): Promise<ClipMeta> {
    const meta: ClipMeta = {
      jobId: job.status.jobId,
      clipNumber: job.status.clipNumber,
      t: job.t,
      windowSec: job.windowSec,
      layout: this.deps.config.value.layout,
      state: "error",
      cameras: [],
      outputs: { combined: null, combinedSideBySide: null, angles: {} },
      errors: [],
      createdAt: job.status.createdAt,
    };
    try {
      if (job.angles.length === 0) {
        meta.errors.push("no camera uploads received");
      } else {
        const run = this.deps.processFn ?? processClip;
        const result = await run({
          clipDir: job.dir,
          t: job.t,
          windowSec: job.windowSec,
          angles: job.angles,
          config: this.deps.config.value,
        });
        meta.cameras = result.cameras;
        meta.outputs = result.outputs;
        meta.errors = result.errors;
        if (result.outputs.combined || Object.keys(result.outputs.angles).length > 0)
          meta.state = "ready";
      }
    } catch (e) {
      meta.errors.push(e instanceof Error ? e.message : String(e));
    }
    this.deps.storage.writeMeta(job.dir, meta);
    return meta;
  }
}
