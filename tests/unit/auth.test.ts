import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, RateLimiter, SESSION_TTL_MS, tokenFromCookie } from "@server/auth";

const tmp = () => mkdtempSync(join(tmpdir(), "replay-auth-"));

describe("Auth", () => {
  it("rejects a wrong password and accepts the right one", () => {
    const auth = Auth.load(tmp(), () => "segredo");
    expect(auth.login("errada", 0)).toBeNull();
    const token = auth.login("segredo", 0);
    expect(token).not.toBeNull();
    expect(auth.verify(token!, 1000)).toBe(true);
  });

  it("expires tokens after the TTL and rejects tampering", () => {
    const auth = Auth.load(tmp(), () => "s");
    const token = auth.login("s", 0)!;
    expect(auth.verify(token, SESSION_TTL_MS + 1)).toBe(false);
    const [exp, sig] = token.split(".");
    expect(auth.verify(`${Number(exp) + 9999}.${sig}`, 0)).toBe(false);
    expect(auth.verify(undefined, 0)).toBe(false);
    expect(auth.verify("garbage", 0)).toBe(false);
  });

  it("returns false (not throw) for a multi-byte signature with equal string length", () => {
    const auth = Auth.load(tmp(), () => "s");
    const [exp] = auth.login("s", 0)!.split(".");
    expect(auth.verify(`${exp}.${"é" + "0".repeat(63)}`, 0)).toBe(false);
  });

  it("persists the secret so tokens survive a restart", () => {
    const dir = tmp();
    const token = Auth.load(dir, () => "s").login("s", 0)!;
    expect(Auth.load(dir, () => "s").verify(token, 1000)).toBe(true);
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
