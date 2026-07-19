import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "@server/clip-job";
import { ConfigStore } from "@server/config";
import type { RawAngle } from "@server/pipeline";
import { SerialQueue } from "@server/queue";
import { Storage } from "@server/storage";
import type { JobStatus } from "@shared/protocol";

function setup(
  cameraIds: string[],
  processOk = true,
  writeMetaThrows = false,
  onProcess?: (angles: RawAngle[]) => void,
  opts: { configEnv?: Record<string, string | undefined> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "replay-job-"));
  const updates: JobStatus[] = [];
  const rawUpdates: JobStatus[] = [];
  const records: string[] = [];
  const storage = new Storage(dir);
  if (writeMetaThrows) {
    storage.writeMeta = () => {
      throw new Error("disk full");
    };
  }
  const manager = new JobManager({
    storage,
    config: ConfigStore.load(dir, opts.configEnv ?? { PASSWORD: "x", SESSION_SECRET: "x" }),
    hub: { onlineCameraIds: () => cameraIds },
    queue: new SerialQueue(),
    publishRecord: (jobId) => records.push(jobId),
    onUpdate: (j) => {
      updates.push({ ...j });
      rawUpdates.push(j);
    },
    processFn: async (o) => {
      onProcess?.(o.angles);
      if (!processOk) throw new Error("ffmpeg exploded");
      return {
        outputs: {
          combined: "combined.mp4",
          combinedSideBySide: null,
          angles: { a: "angle-a.mp4" },
        },
        cameras: [],
        errors: [],
      };
    },
    // A fixed override keeps the timeout-driven tests fast; when a test supplies its own configEnv it
    // omits the override so the manager exercises the real config.uploadTimeoutSeconds path instead.
    uploadTimeoutMs: opts.configEnv ? undefined : 60,
    cooldownMs: 20,
  });
  return { manager, updates, rawUpdates, records, dir };
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

  it("finalizes via the configured upload timeout when no override is supplied", async () => {
    // No uploadTimeoutMs override → the fallback timer must read config.uploadTimeoutSeconds
    // (0.05s = 50ms here). With the old hardcoded 30s it would never finalize inside waitFor.
    const { manager, updates } = setup(["cam1"], true, false, undefined, {
      configEnv: { PASSWORD: "x", SESSION_SECRET: "x", UPLOAD_TIMEOUT_SECONDS: "0.05" },
    });
    manager.trigger(1000);
    await waitFor(() => updates.some((u) => u.state === "error")); // no uploads → finalized to error
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

  it("finalizes to error and removes the job when writeMeta throws", async () => {
    const { manager, updates } = setup(["cam1"], true, true);
    const { jobId } = manager.trigger(1000) as { jobId: string };
    manager.addUpload(jobId, "cam1", angle);
    await waitFor(() => updates.some((u) => u.state === "error"));
    expect(manager.addUpload(jobId, "cam1", angle)).toBe(false);
    expect(manager.uploadDir(jobId)).toBeNull();
  });

  it("the capturing snapshot passed to onUpdate is not mutated by later transitions", async () => {
    const { manager, updates, rawUpdates } = setup(["cam1", "cam2"]);
    const { jobId } = manager.trigger(1000) as { jobId: string };
    manager.addUpload(jobId, "cam1", angle);
    manager.addUpload(jobId, "cam2", angle);
    await waitFor(() => updates.some((u) => u.state === "ready"));
    expect(rawUpdates[0]!.state).toBe("capturing");
  });

  it("ignores a duplicate upload from the same camera", async () => {
    const capturedAngles: RawAngle[][] = [];
    const { manager, updates } = setup(["cam1", "cam2"], true, false, (angles) =>
      capturedAngles.push(angles),
    );
    const { jobId } = manager.trigger(1000) as { jobId: string };
    expect(manager.addUpload(jobId, "cam1", angle)).toBe(true);
    // retry from the same camera (e.g. a lost HTTP response after a server-side success)
    expect(manager.addUpload(jobId, "cam1", angle)).toBe(true);
    expect(manager.addUpload(jobId, "cam2", angle)).toBe(true);
    await waitFor(() => updates.some((u) => u.state === "ready"));
    expect(capturedAngles).toHaveLength(1);
    expect(capturedAngles[0]).toHaveLength(2); // cam1 once + cam2, not 3
  });
});
