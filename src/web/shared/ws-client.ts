import { computeOffset, type NtpSample } from "@shared/clock";
import type { ClientMessage, ServerMessage } from "@shared/protocol";

/**
 * Shared WebSocket client for the camera and control pages: auto-reconnecting `/ws` connection,
 * a keepalive heartbeat, and NTP-style clock sync exposed as `serverNow()`.
 */
export class WsClient {
  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};
  private ws: WebSocket | null = null;
  private offset = 0;
  private samples: NtpSample[] = [];
  private timers: number[] = [];

  /** Opens the connection and (re)arms its timers. On close, auto-reconnects after a fixed 1.5s
   * delay — simple and sufficient for a LAN tool with a handful of clients reconnecting to one
   * local server; there's no remote service to protect from a reconnect storm, so no backoff. */
  connect(): void {
    const ws = new WebSocket(`wss://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.onStatus(true);
      this.syncClock();
      // Heartbeat: keeps the socket alive through NAT/proxy idle-connection timeouts (a common
      // WS gotcha — many routers/load balancers silently drop idle connections after ~30-60s);
      // for camera connections it also doubles as a liveness touch for the server's offline
      // sweep (see hub.ts), though cameraStatus reports (every 5s) already cover that too.
      this.timers.push(window.setInterval(() => this.send({ type: "hb" }), 3_000));
      this.timers.push(window.setInterval(() => this.syncClock(), 5 * 60_000));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === "ntpReply") {
        this.samples.push({
          clientSent: msg.clientTime,
          serverTime: msg.serverTime,
          clientReceived: Date.now(),
        });
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

  /** No-ops if the socket isn't open (e.g. mid-reconnect) — callers don't need to check
   * `readyState` themselves before sending. */
  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Best current estimate of the server's clock, for timestamps that must be comparable across
   * independently-clocked devices (see `shared/clock.ts` and `shared/buffer-window.ts`). */
  serverNow(): number {
    return Date.now() + this.offset;
  }

  /**
   * Fires a burst of 3 NTP probes 150ms apart (rather than one), so `computeOffset`'s median (see
   * clock.ts) can filter out any single sample skewed by one-off network jitter; `samples` only
   * ever uses the latest 3 (`.slice(-3)` in `onmessage`) so the offset tracks current conditions
   * rather than being dragged down by stale samples from long ago. Re-run every 5 minutes (see
   * `connect`) since drift accumulates over a long buffering session.
   */
  private syncClock(): void {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.send({ type: "ntp", clientTime: Date.now() }), i * 150);
    }
  }
}
