import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Hub, OFFLINE_AFTER_MS, type WSData } from "../../src/server/hub";

function fakeWs() {
  const sent: string[] = [];
  const topics: string[] = [];
  const ws = {
    data: {} as WSData,
    send: (m: string) => sent.push(m),
    subscribe: (t: string) => topics.push(t),
  } as unknown as ServerWebSocket<WSData>;
  return { ws, sent, topics };
}

describe("Hub", () => {
  it("registers a camera, replies with its id, and lists it online", () => {
    const hub = new Hub();
    let changes = 0;
    hub.onStateChanged = () => changes++;
    const { ws, sent, topics } = fakeWs();
    hub.open(ws);
    hub.message(ws, JSON.stringify({ type: "register", role: "camera", name: "Fundo" }), 1000);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe("registered");
    expect(ws.data.cameraId).toBe(reply.cameraId);
    expect(topics).toEqual(["all", "cameras"]);
    expect(hub.cameras()).toMatchObject([{ name: "Fundo", online: true }]);
    expect(hub.onlineCameraIds()).toEqual([reply.cameraId]);
    expect(changes).toBe(1);
  });

  it("answers ntp with serverTime and echoes clientTime", () => {
    const hub = new Hub();
    const { ws, sent } = fakeWs();
    hub.open(ws);
    hub.message(ws, JSON.stringify({ type: "ntp", clientTime: 123 }), 5000);
    expect(JSON.parse(sent[0]!)).toEqual({ type: "ntpReply", clientTime: 123, serverTime: 5000 });
  });

  it("updates camera status and marks offline after heartbeat silence", () => {
    const hub = new Hub();
    const { ws, sent } = fakeWs();
    hub.open(ws);
    hub.message(ws, JSON.stringify({ type: "register", role: "camera", name: "A" }), 0);
    void sent;
    hub.message(ws, JSON.stringify({ type: "cameraStatus", width: 1920, height: 1080, fps: 60 }), 1000);
    expect(hub.cameras()[0]).toMatchObject({ width: 1920, fps: 60, online: true });

    hub.sweep(1000 + OFFLINE_AFTER_MS + 1);
    expect(hub.cameras()[0]!.online).toBe(false);
    expect(hub.onlineCameraIds()).toEqual([]);

    hub.message(ws, JSON.stringify({ type: "hb" }), 20_000);
    hub.sweep(20_001);
    expect(hub.cameras()[0]!.online).toBe(true);
  });

  it("removes a camera on close and ignores malformed json", () => {
    const hub = new Hub();
    const { ws } = fakeWs();
    hub.open(ws);
    hub.message(ws, "{not json", 0);
    hub.message(ws, JSON.stringify({ type: "register", role: "camera", name: "A" }), 0);
    hub.close(ws);
    expect(hub.cameras()).toEqual([]);
  });

  it("control registration does not create a camera", () => {
    const hub = new Hub();
    const { ws } = fakeWs();
    hub.open(ws);
    hub.message(ws, JSON.stringify({ type: "register", role: "control" }), 0);
    expect(hub.cameras()).toEqual([]);
    expect(ws.data.role).toBe("control");
  });
});
