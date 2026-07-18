import { describe, expect, it } from "bun:test";
import { esc } from "../../src/web/shared/esc";

describe("esc", () => {
  it("neutralizes an HTML/JS injection payload", () => {
    const out = esc('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
    expect(out).not.toContain('"');
    expect(out).toContain("&lt;img");
    expect(out).toContain("onerror=");
    expect(out).toContain("&quot;");
  });
  it("escapes all five special characters", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
  it("leaves safe text untouched", () => {
    expect(esc("Fundo — Lateral rede")).toBe("Fundo — Lateral rede");
  });
});
