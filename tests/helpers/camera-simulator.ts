import type { ServerMessage } from "../../src/shared/protocol";

export class CameraSimulator {
  uploads = 0;
  private ws: WebSocket | null = null;
  private cameraId = "";

  constructor(
    private o: {
      httpBase: string;
      wsUrl: string;
      cookie: string;
      name: string;
      rawFile: string;
      rawDurationMs: number;
    },
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(this.o.wsUrl, {
      headers: { cookie: this.o.cookie },
    } as unknown as string[]);
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
    const hb = setInterval(
      () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "hb" })),
      1000,
    );
    ws.onclose = () => clearInterval(hb);
  }

  private async upload(msg: { jobId: string; t: number; windowSec: number }): Promise<void> {
    const form = new FormData();
    form.append("cameraId", this.cameraId); // id assigned by the hub in the "registered" message
    form.append("angleName", this.o.name);
    form.append(
      "filesMeta",
      JSON.stringify([{ startMs: msg.t - msg.windowSec * 1000 - 1000, mimeType: "video/mp4" }]),
    );
    form.append(
      "file0",
      new Blob([await Bun.file(this.o.rawFile).arrayBuffer()], { type: "video/mp4" }),
      "part0",
    );
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
