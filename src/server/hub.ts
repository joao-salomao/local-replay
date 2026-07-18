import type { ServerWebSocket } from "bun";
import { logger } from "./log";
import type { CameraInfo, ClientMessage, ServerMessage } from "../shared/protocol";

export type WSData = { role?: "camera" | "control"; cameraId?: string };
export const TOPIC_ALL = "all";
export const TOPIC_CAMERAS = "cameras";
export const OFFLINE_AFTER_MS = 10_000;

const log = logger("hub");

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
          info: { id, name: msg.name, online: true, width: 0, height: 0, fps: 0 },
          lastSeen: nowMs,
        });
        const reply: ServerMessage = { type: "registered", cameraId: id };
        ws.send(JSON.stringify(reply));
        log.info("camera registered", { id, name: msg.name });
      } else {
        log.debug("control registered");
      }
      this.onStateChanged();
      return;
    }
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
        cam.info.fps !== msg.fps;
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
        // sweep only ever detects timeouts (going offline); a camera coming back online is
        // always observed first via message(), which logs it there.
        if (!online) log.info("camera offline", { id: cam.info.id, name: cam.info.name });
      }
    }
    if (changed) this.onStateChanged();
  }
}
