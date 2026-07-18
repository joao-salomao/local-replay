import { describe, expect, it } from "bun:test";
import { CameraSimulator } from "../helpers/camera-simulator";

describe("CameraSimulator", () => {
  it("connect() rejects when the websocket connection errors (nothing listening on the target port)", async () => {
    // Real integration tests only ever exercise the happy path (connect succeeds); this is the
    // one scenario none of them cover — a connection that fails outright, hitting `ws.onerror`.
    const sim = new CameraSimulator({
      httpBase: "http://127.0.0.1:1",
      wsUrl: "ws://127.0.0.1:1/ws",
      cookie: "",
      name: "Unreachable",
      rawFile: "/dev/null",
      rawDurationMs: 0,
    });
    await expect(sim.connect()).rejects.toThrow("ws error");
  });
});
