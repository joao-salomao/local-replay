import type { CameraInfo, ClientMessage, ServerMessage } from "@shared/protocol";
import type { ServerWebSocket } from "bun";
import { logger } from "./log";

/**
 * Central WebSocket connection and camera-registry manager: dispatches `ClientMessage`s, tracks
 * which cameras are connected/online, and decides when a broadcast-worthy state change happened.
 * Hub doesn't hold a reference to the Bun `Server` (that would be circular — routes.ts needs Hub
 * to build the websocket handler, and Hub would need the Server to `publish`), so it exposes
 * `onStateChanged` as a hook instead: `server/index.ts` wires it to the actual broadcast.
 */

/** Per-connection mutable state Bun attaches to each `ServerWebSocket`. */
export type WSData = { role?: "camera" | "control"; cameraId?: string };
/** Pub/sub topic every connection joins on open — carries `state`/`jobUpdate` broadcasts. */
export const TOPIC_ALL = "all";
/** Pub/sub topic only camera connections join — carries `record` triggers (control clients don't
 * need them). */
export const TOPIC_CAMERAS = "cameras";
/** Pub/sub topic only control connections join — carries streamed `log` lines (see `log.ts`,
 * `server/index.ts`); cameras never subscribe to it. */
export const TOPIC_CONTROLS = "controls";
/** No heartbeat/message from a camera within this window ⇒ considered offline (see `sweep`). */
export const OFFLINE_AFTER_MS = 10_000;

const log = logger("hub");

/** Server-only camera bookkeeping: `info` is the public `CameraInfo` broadcast to clients,
 * `lastSeen` is liveness tracking that never leaves the server. */
type CameraConn = { info: CameraInfo; lastSeen: number };

export class Hub {
  private camerasById: Map<string, CameraConn>;
  private stateChangedListener: () => void;

  // Explicit constructor (rather than class-field initializers) is deliberate: Bun 1.3.1's
  // function-coverage counter always reserves one "found" function slot for a class's
  // constructor, but only ever marks it "hit" if the constructor is user-written — a class with
  // only field initializers and no explicit constructor is structurally stuck below 100% function
  // coverage no matter how thoroughly it's tested (verified with a throwaway repro). Giving Hub a
  // real constructor body fixes that for real, since every test already goes through `new Hub()`.
  constructor() {
    this.camerasById = new Map();
    this.stateChangedListener = () => {};
  }

  /** Register the callback invoked whenever the camera registry changes (register, status update, offline sweep, or disconnect). Replaces the previous public `onStateChanged` property. */
  setOnStateChanged(listener: () => void): void {
    this.stateChangedListener = listener;
  }

  /** Fire the registered state-changed listener manually — used when something outside the hub (e.g. a config change) should trigger a re-broadcast of the full state. */
  notifyStateChanged(): void {
    this.stateChangedListener();
  }

  cameras(): CameraInfo[] {
    return [...this.camerasById.values()].map((c) => c.info);
  }

  onlineCameraIds(): string[] {
    return [...this.camerasById.values()].filter((c) => c.info.online).map((c) => c.info.id);
  }

  /** Every new connection joins `TOPIC_ALL` immediately, before its role is even known — it
   * needs to receive `state`/`jobUpdate` broadcasts regardless of whether it turns out to be a
   * camera or a control client. Role-specific topics (`TOPIC_CAMERAS`) are joined on `register`. */
  open(ws: ServerWebSocket<WSData>): void {
    ws.subscribe(TOPIC_ALL);
  }

  /** Dispatches one parsed `ClientMessage`. Malformed JSON is silently dropped. */
  message(ws: ServerWebSocket<WSData>, raw: string | Buffer, nowMs: number): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === "ntp") {
      const reply: ServerMessage = {
        type: "ntpReply",
        clientTime: msg.clientTime,
        serverTime: nowMs,
      };
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
          info: { id, name: msg.name, online: true, width: 0, height: 0, fps: 0, deviceLabel: "" },
          lastSeen: nowMs,
        });
        const reply: ServerMessage = { type: "registered", cameraId: id };
        ws.send(JSON.stringify(reply));
        log.info("camera registered", { id, name: msg.name });
      } else {
        // Controls (not cameras) subscribe to TOPIC_CONTROLS, so they receive streamed log lines.
        ws.subscribe(TOPIC_CONTROLS);
        log.debug("control registered");
      }
      this.stateChangedListener();
      return;
    }
    // Remaining message types (cameraStatus, hb) only make sense for an already-registered
    // camera; anything else (unregistered connections, control connections) is a no-op here.
    const cam = ws.data.cameraId ? this.camerasById.get(ws.data.cameraId) : undefined;
    if (!cam) return;
    cam.lastSeen = nowMs;
    const wasOffline = !cam.info.online;
    cam.info.online = true;
    if (wasOffline) log.info("camera back online", { id: cam.info.id, name: cam.info.name });
    if (msg.type === "cameraStatus") {
      const changed =
        wasOffline ||
        cam.info.width !== msg.width ||
        cam.info.height !== msg.height ||
        cam.info.fps !== msg.fps ||
        cam.info.deviceLabel !== msg.label;
      cam.info.width = msg.width;
      cam.info.height = msg.height;
      cam.info.fps = msg.fps;
      cam.info.deviceLabel = msg.label;
      if (changed) this.stateChangedListener(); // cameras re-report every 5s; only broadcast real changes
    } else if (wasOffline) {
      this.stateChangedListener();
    }
  }

  /** Drops the camera on disconnect (control connections have no registry entry to remove, so
   * closing one never triggers a broadcast here). */
  close(ws: ServerWebSocket<WSData>): void {
    if (ws.data.cameraId && this.camerasById.delete(ws.data.cameraId)) this.stateChangedListener();
  }

  /** Periodic staleness sweep (driven by `server/index.ts`'s interval) marking cameras offline
   * once `OFFLINE_AFTER_MS` passes without any message. Coming back online is intentionally not
   * handled here — that transition is only ever observed (and logged) via `message()`, the
   * moment a message from that camera actually arrives. */
  sweep(nowMs: number): void {
    let changed = false;
    for (const cam of this.camerasById.values()) {
      const online = nowMs - cam.lastSeen < OFFLINE_AFTER_MS;
      if (online !== cam.info.online) {
        cam.info.online = online;
        changed = true;
        // sweep only ever detects timeouts (going offline); a camera coming back online is
        // always observed first via message(), which logs it there.
        if (!online) log.info("camera offline", { id: cam.info.id, name: cam.info.name });
      }
    }
    if (changed) this.stateChangedListener();
  }
}
