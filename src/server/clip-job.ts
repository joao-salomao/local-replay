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
    return { jobId: status.jobId };
  }

  uploadDir(jobId: string): string | null {
    const job = this.active.get(jobId);
    return job && job.status.state === "capturing" ? job.dir : null;
  }

  addUpload(jobId: string, cameraId: string, angle: RawAngle): boolean {
    const job = this.active.get(jobId);
    if (!job || job.status.state !== "capturing") return false;
    if (job.delivered.has(cameraId)) return true; // idempotent: this camera already delivered
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
      let finalState: "ready" | "error" = "error";
      let errorMsg = "";
      try {
        const meta = await this.process(job);
        finalState = meta.state === "ready" ? "ready" : "error";
        if (finalState === "error") errorMsg = meta.errors.join("; ") || "processing failed";
      } catch (e) {
        errorMsg = e instanceof Error ? e.message : String(e);
      }
      job.status.state = finalState;
      if (finalState === "error") job.status.error = errorMsg;
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
