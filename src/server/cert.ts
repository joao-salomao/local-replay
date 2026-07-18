import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./log";

const log = logger("cert");

/**
 * Ensures a self-signed TLS cert+key exist for LAN HTTPS mode (`server/index.ts`'s non-proxy
 * branch), regenerating them whenever the configured LAN IP changes.
 *
 * The cert's SAN (Subject Alternative Name) must match the address a client actually connects
 * to, or mobile OSes — iOS/Android are strict about this — will reject it as invalid. `san-ip`
 * records which IP was baked into the SAN of the cert currently on disk; if `HOST_LAN_IP` (e.g.
 * after a DHCP lease change, or moving the host to a different network) no longer matches it, the
 * old cert+key are deleted so a fresh one gets generated below with the new IP.
 */
export async function ensureCert(dataDir: string): Promise<{ certPath: string; keyPath: string }> {
  const dir = join(dataDir, "certs");
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  const ipMarker = join(dir, "san-ip");
  const wantedIp = process.env.HOST_LAN_IP ?? "";
  const hadMarker = existsSync(ipMarker);
  const markedIp = hadMarker ? readFileSync(ipMarker, "utf8") : "";
  const ipChanged = hadMarker && wantedIp !== "" && markedIp !== wantedIp;
  if (wantedIp && markedIp !== wantedIp) {
    rmSync(certPath, { force: true }); // IP changed: SAN must match for iOS/Android trust
    rmSync(keyPath, { force: true });
  }
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    // DNS:replay.local is always included; the raw IP is added too when known, since LAN clients
    // may reach this host by either name (if mDNS resolves) or bare IP.
    const san = wantedIp
      ? `subjectAltName=DNS:replay.local,IP:${wantedIp}`
      : "subjectAltName=DNS:replay.local";
    const proc = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "3650",
        "-subj",
        "/CN=replay.local",
        "-addext",
        san,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      throw new Error(`openssl failed: ${await new Response(proc.stderr).text()}`);
    }
    writeFileSync(ipMarker, wantedIp);
    chmodSync(keyPath, 0o600); // private key: unreadable to other local users/processes
    chmodSync(dir, 0o700);
    if (ipChanged) log.info("cert regenerated (SAN IP changed)", { ip: wantedIp });
    else log.info("cert generated", { certPath });
  } else {
    log.debug("cert reused", { certPath });
  }
  return { certPath, keyPath };
}
