import { describe, expect, it } from "bun:test";
import { Auth, RateLimiter, SESSION_TTL_MS, tokenFromCookie } from "@server/auth";

describe("Auth", () => {
  it("rejects a wrong password and accepts the right one", () => {
    const auth = new Auth("secret", () => "segredo");
    expect(auth.login("errada", 0)).toBeNull();
    const token = auth.login("segredo", 0);
    expect(token).not.toBeNull();
    expect(auth.verify(token!, 1000)).toBe(true);
  });

  it("expires tokens after the TTL and rejects tampering", () => {
    const auth = new Auth("secret", () => "s");
    const token = auth.login("s", 0)!;
    expect(auth.verify(token, SESSION_TTL_MS + 1)).toBe(false);
    const [exp, sig] = token.split(".");
    expect(auth.verify(`${Number(exp) + 9999}.${sig}`, 0)).toBe(false);
    expect(auth.verify(undefined, 0)).toBe(false);
    expect(auth.verify("garbage", 0)).toBe(false);
  });

  it("returns false (not throw) for a multi-byte signature with equal string length", () => {
    const auth = new Auth("secret", () => "s");
    const [exp] = auth.login("s", 0)!.split(".");
    expect(auth.verify(`${exp}.${`é${"0".repeat(63)}`}`, 0)).toBe(false);
  });

  it("two instances with the same secret verify each other's tokens (survives a restart)", () => {
    // The secret now comes from SESSION_SECRET in the env; a stable value across restarts is what
    // keeps existing tokens valid — modeled here by two Auth instances sharing the same secret.
    const token = new Auth("shared-secret", () => "s").login("s", 0)!;
    expect(new Auth("shared-secret", () => "s").verify(token, 1000)).toBe(true);
  });

  it("parses the session cookie", () => {
    expect(tokenFromCookie("theme=dark; session=abc.def; x=1")).toBe("abc.def");
    expect(tokenFromCookie(null)).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit per window, then blocks, then resets", () => {
    const rl = new RateLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) expect(rl.allow("ip", i)).toBe(true);
    expect(rl.allow("ip", 100)).toBe(false);
    expect(rl.allow("other", 100)).toBe(true);
    expect(rl.allow("ip", 60_001)).toBe(true);
  });
});
