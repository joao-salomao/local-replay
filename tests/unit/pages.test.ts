import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPages } from "../../src/server/pages";

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
});
