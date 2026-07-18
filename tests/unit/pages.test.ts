import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPages } from "@server/pages";

describe("buildPages", () => {
  it("bundles the four page entrypoints and serves html + whitelisted assets", async () => {
    const out = mkdtempSync(join(tmpdir(), "replay-dist-"));
    const pages = await buildPages("src/web", out);
    expect(pages.html("login")).toContain("<script");
    expect(pages.html("camera").length).toBeGreaterThan(0);
    for (const name of ["login.js", "camera.js", "control.js", "clips.js", "app.css"]) {
      expect(pages.assetFile(name)).not.toBeNull();
    }
    expect(pages.assetFile("../secret")).toBeNull();
    expect(pages.assetFile("evil.js")).toBeNull();
  }, 30_000);

  it("throws when Bun.build fails to bundle an entrypoint", async () => {
    // A webDir with all four required entrypoints present (so entry *resolution* succeeds) but
    // one entrypoint importing a module that doesn't exist, so Bun.build itself returns
    // `success: false` with logs instead of throwing at entry-resolution time — exercising
    // buildPages's own `if (!result.success) throw ...` guard, not some earlier failure mode.
    const webDir = mkdtempSync(join(tmpdir(), "replay-web-broken-"));
    mkdirSync(join(webDir, "camera"), { recursive: true });
    mkdirSync(join(webDir, "control"), { recursive: true });
    mkdirSync(join(webDir, "clips"), { recursive: true });
    writeFileSync(join(webDir, "login.ts"), 'import "./this-module-does-not-exist-xyz";\n');
    writeFileSync(join(webDir, "camera", "camera.ts"), "export {};\n");
    writeFileSync(join(webDir, "control", "control.ts"), "export {};\n");
    writeFileSync(join(webDir, "clips", "clips.ts"), "export {};\n");
    const out = mkdtempSync(join(tmpdir(), "replay-dist-broken-"));
    await expect(buildPages(webDir, out)).rejects.toThrow(/page bundling failed/);
  }, 30_000);
});
