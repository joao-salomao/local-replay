import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCert } from "../../src/server/cert";

describe("ensureCert", () => {
  it("generates cert+key once and reuses them after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-cert-"));
    const first = await ensureCert(dir);
    expect(readFileSync(first.certPath, "utf8")).toContain("BEGIN CERTIFICATE");
    expect(readFileSync(first.keyPath, "utf8")).toContain("PRIVATE KEY");
    const mtime = statSync(first.certPath).mtimeMs;
    const second = await ensureCert(dir);
    expect(second.certPath).toBe(first.certPath);
    expect(statSync(second.certPath).mtimeMs).toBe(mtime);
  }, 30_000);

  it("regenerates cert+key when HOST_LAN_IP changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-cert-"));
    process.env.HOST_LAN_IP = "192.168.0.10";
    const first = await ensureCert(dir);
    const before = readFileSync(first.certPath, "utf8");
    process.env.HOST_LAN_IP = "192.168.0.20";
    const second = await ensureCert(dir);
    expect(readFileSync(second.certPath, "utf8")).not.toBe(before);
    process.env.HOST_LAN_IP = "192.168.0.20";
    const third = await ensureCert(dir);
    expect(readFileSync(third.certPath, "utf8")).toBe(readFileSync(second.certPath, "utf8"));
    delete process.env.HOST_LAN_IP;
  }, 30_000);

  it("writes the private key with owner-only permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-cert-"));
    const { keyPath } = await ensureCert(dir);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  }, 30_000);
});
