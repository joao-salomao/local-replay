/**
 * Shared WebSocket protocol between camera/control web clients and the server (`server/hub.ts`
 * handles `ClientMessage`, `server/index.ts#publishState` and `clip-job.ts` emit `ServerMessage`).
 * Both sides import these types; there is no runtime schema validation beyond `JSON.parse`, so
 * this file is the actual contract.
 */

/** Public, broadcastable snapshot of one camera connection (as shown on the control page). */
export type CameraInfo = {
  id: string;
  name: string;
  online: boolean;
  width: number;
  height: number;
  fps: number;
  /** Label of the physical camera/lens the device is currently capturing with (the getUserMedia
   * video track's `label`, e.g. "FaceTime HD Camera", "Back Camera"); `""` until first reported, or
   * if the browser withholds it. Shown on the control page so the operator can see which hardware
   * each angle is on. */
  deviceLabel: string;
};

/** Lifecycle of one triggered clip job: capturing uploads → processing (ffmpeg) → ready or error. */
export type JobState = "capturing" | "processing" | "ready" | "error";
export type JobStatus = {
  jobId: string;
  clipNumber: number;
  state: JobState;
  error?: string;
  createdAt: number;
};

/** One structured server log line, as streamed to control pages and returned by `GET /api/logs`
 * (see `server/log.ts` for the emit→sink mechanism and `server/log-buffer.ts` for the backlog ring
 * buffer). `seq` is a process-wide monotonic counter, used client-side to dedupe a line that
 * arrives via both the WS stream and the `/api/logs` backlog. */
export type LogEntry = {
  seq: number;
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
  fields?: Record<string, string | number | boolean>;
};

/**
 * Client → server messages.
 * - `register`: first message on a new connection; declares the connection's role. Camera
 *   connections supply a display `name`; the server assigns the actual `cameraId` (see `registered`).
 * - `ntp`: clock-sync probe, answered immediately with `ntpReply` regardless of registration state.
 * - `cameraStatus`: periodic (camera role only) report of actual capture resolution/fps and the
 *   active camera's device `label` (which physical lens/camera the device is capturing with).
 * - `hb`: heartbeat/keepalive with no payload; see `web/shared/ws-client.ts` for why it's sent.
 */
export type ClientMessage =
  | { type: "register"; role: "camera"; name: string }
  | { type: "register"; role: "control" }
  | { type: "ntp"; clientTime: number }
  | { type: "cameraStatus"; width: number; height: number; fps: number; label: string }
  | { type: "hb" };

/**
 * Server → client messages.
 * - `registered`: reply to a camera's `register`, assigning its server-generated `cameraId`.
 * - `ntpReply`: reply to `ntp`, echoing the client's send time alongside the server's clock reading.
 * - `record`: broadcast to camera connections only (TOPIC_CAMERAS) — directs cameras to finish
 *   their current segment and upload the window ending at `t` (see `hub.ts`, `clip-job.ts`).
 * - `removed`: sent to a SINGLE camera connection when the control page removes it — the camera
 *   page redirects back to the role picker (`/`) instead of auto-reconnecting.
 * - `state`: full state broadcast to all connections (TOPIC_ALL) — cameras, config, recent jobs,
 *   free disk. Sent on any real change, not on a fixed interval (see `hub.ts#onStateChanged`).
 * - `jobUpdate`: incremental broadcast to all connections when a single job's status changes,
 *   so clients don't need to wait for the next full `state` message to see progress.
 * - `log`: one server log line, streamed only to control connections (`TOPIC_CONTROLS` — see
 *   `hub.ts`/`log.ts`) as it's emitted; `GET /api/logs` covers the backlog from before a control
 *   page connected.
 */
export type ServerMessage =
  | { type: "registered"; cameraId: string }
  | { type: "ntpReply"; clientTime: number; serverTime: number }
  | { type: "record"; jobId: string; t: number; windowSec: number }
  | { type: "removed" }
  | {
      type: "state";
      cameras: CameraInfo[];
      clipDurationSeconds: number;
      audioSourceName: string | null;
      bufferCycleMinSeconds: number;
      /** Extra seconds the camera buffers beyond the clip duration (`config.ts#bufferMarginSeconds`).
       * Read by `web/camera/camera.ts` and threaded into `cycleSeconds`. */
      bufferMarginSeconds: number;
      /** Server-side upload window, seconds (`config.ts#uploadTimeoutSeconds`) — surfaced so the
       * control page can display and adjust it. Not used by the camera. */
      uploadTimeoutSeconds: number;
      /** Capture resolution/fps the cameras should request (see `config.ts`); the device picks the
       * closest it supports. Read by `web/camera/camera.ts` for its getUserMedia constraints. */
      capture: { width: number; height: number; fps: number };
      jobs: JobStatus[];
      freeDiskGB: number | null;
    }
  | { type: "jobUpdate"; job: JobStatus }
  | { type: "log"; entry: LogEntry };
