import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Password login and stateless session tokens. There is no server-side session store: a session
 * is just `${expiryMs}.${hmac(expiryMs)}`, verified by recomputing the HMAC — so verification
 * needs no lookup, and (unlike a session table) surviving a restart doesn't require any state
 * beyond the HMAC secret, which comes from `SESSION_SECRET` in the environment (see `config.ts`).
 */

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class Auth {
  constructor(
    private secret: string,
    // `password` is a getter (not a value) so `Auth` reads the configured password rather than
    // capturing a copy at construction.
    private password: () => string,
  ) {}

  /**
   * Checks `password` against the configured password and, on success, returns a fresh signed
   * session token (`null` on mismatch). The length check on `expected.length !== given.length`
   * must run BEFORE `timingSafeEqual` because that function throws (rather than returning false)
   * when given buffers of different byte length — and it must compare the `Buffer`s' byte
   * lengths specifically, not the source strings' `.length` (UTF-16 code-unit counts), since
   * those two can disagree for non-ASCII passwords. Guarding with the exact precondition
   * `timingSafeEqual` itself enforces avoids both a crash on mismatched-length input and any
   * observable branching that a string-length proxy could introduce.
   */
  login(password: string, nowMs: number): string | null {
    const expected = Buffer.from(this.password());
    const given = Buffer.from(password);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const exp = String(nowMs + SESSION_TTL_MS);
    return `${exp}.${this.sign(exp)}`;
  }

  /**
   * Validates a `${exp}.${sig}` session token: well-formed and not-yet-expired first (cheap,
   * fails fast on garbage without touching crypto), then re-signs `exp` and compares to `sig`
   * with the same length-pre-check-then-`timingSafeEqual` pattern as `login` (see there for why).
   */
  verify(token: string | undefined, nowMs: number): boolean {
    if (!token) return false;
    const [exp, sig] = token.split(".");
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < nowMs) return false;
    const good = this.sign(exp);
    const sigBuf = Buffer.from(sig);
    const goodBuf = Buffer.from(good);
    return sigBuf.length === goodBuf.length && timingSafeEqual(sigBuf, goodBuf);
  }

  /** `Set-Cookie` value for a session token: HttpOnly (unreadable to page JS, mitigates XSS
   * exfiltration), Secure (HTTPS-only), SameSite=Lax (blocks cross-site POST/fetch use while
   * still allowing normal top-level navigation), `Max-Age` matching `SESSION_TTL_MS`. */
  cookieFor(token: string): string {
    return `session=${token}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }
}

/** Extracts the `session` cookie's value from a raw `Cookie` request header, if present. */
export function tokenFromCookie(header: string | null): string | undefined {
  return /(?:^|;\s*)session=([^;]+)/.exec(header ?? "")?.[1];
}

/**
 * Fixed-window rate limiter (not sliding): each key gets `limit` hits per `windowMs`, and the
 * count resets entirely once `resetAt` passes. Simpler than a sliding window at the cost of
 * allowing a short burst above `limit` right around a window boundary — an accepted tradeoff for
 * login brute-force mitigation, not a hard security boundary against a determined attacker.
 */
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
