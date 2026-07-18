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
 * - `cameraStatus`: periodic (camera role only) report of actual capture resolution/fps.
 * - `hb`: heartbeat/keepalive with no payload; see `web/shared/ws-client.ts` for why it's sent.
 */
export type ClientMessage =
  | { type: "register"; role: "camera"; name: string }
  | { type: "register"; role: "control" }
  | { type: "ntp"; clientTime: number }
  | { type: "cameraStatus"; width: number; height: number; fps: number }
  | { type: "hb" };

/**
 * Server → client messages.
 * - `registered`: reply to a camera's `register`, assigning its server-generated `cameraId`.
 * - `ntpReply`: reply to `ntp`, echoing the client's send time alongside the server's clock reading.
 * - `record`: broadcast to camera connections only (TOPIC_CAMERAS) — directs cameras to finish
 *   their current segment and upload the window ending at `t` (see `hub.ts`, `clip-job.ts`).
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
  | {
      type: "state";
      cameras: CameraInfo[];
      clipDurationSeconds: number;
      audioSourceName: string | null;
      bufferCycleMinSeconds: number;
      jobs: JobStatus[];
      freeDiskGB: number | null;
    }
  | { type: "jobUpdate"; job: JobStatus }
  | { type: "log"; entry: LogEntry };
