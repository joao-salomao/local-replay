import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class Auth {
  constructor(
    private secret: string,
    private password: () => string,
  ) {}

  static load(dataDir: string, password: () => string): Auth {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "session-secret");
    if (!existsSync(path)) {
      writeFileSync(path, randomBytes(32).toString("hex"));
      chmodSync(path, 0o600);
    }
    return new Auth(readFileSync(path, "utf8").trim(), password);
  }

  login(password: string, nowMs: number): string | null {
    const expected = Buffer.from(this.password());
    const given = Buffer.from(password);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const exp = String(nowMs + SESSION_TTL_MS);
    return `${exp}.${this.sign(exp)}`;
  }

  verify(token: string | undefined, nowMs: number): boolean {
    if (!token) return false;
    const [exp, sig] = token.split(".");
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < nowMs) return false;
    const good = this.sign(exp);
    const sigBuf = Buffer.from(sig);
    const goodBuf = Buffer.from(good);
    return sigBuf.length === goodBuf.length && timingSafeEqual(sigBuf, goodBuf);
  }

  cookieFor(token: string): string {
    return `session=${token}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }
}

export function tokenFromCookie(header: string | null): string | undefined {
  return /(?:^|;\s*)session=([^;]+)/.exec(header ?? "")?.[1];
}

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  allow(key: string, nowMs: number): boolean {
    const h = this.hits.get(key);
    if (!h || nowMs >= h.resetAt) {
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    h.count += 1;
    return h.count <= this.limit;
  }
}
