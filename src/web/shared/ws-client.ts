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
