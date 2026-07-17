import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function ensureCert(dataDir: string): Promise<{ certPath: string; keyPath: string }> {
  const dir = join(dataDir, "certs");
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  const ipMarker = join(dir, "san-ip");
  const wantedIp = process.env.HOST_LAN_IP ?? "";
  const markedIp = existsSync(ipMarker) ? readFileSync(ipMarker, "utf8") : "";
  if (wantedIp && markedIp !== wantedIp) {
    rmSync(certPath, { force: true }); // IP changed: SAN must match for iOS/Android trust
    rmSync(keyPath, { force: true });
  }
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    const san = wantedIp ? `subjectAltName=DNS:replay.local,IP:${wantedIp}` : "subjectAltName=DNS:replay.local";
    const proc = Bun.spawn(
      [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath, "-days", "3650",
        "-subj", "/CN=replay.local", "-addext", san,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      throw new Error(`openssl failed: ${await new Response(proc.stderr).text()}`);
    }
    writeFileSync(ipMarker, wantedIp);
  }
  return { certPath, keyPath };
}
