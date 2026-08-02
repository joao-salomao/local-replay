import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPages } from "@server/pages";

/** Mirrors pages.ts's STATIC_ASSETS: buildPages copies each by name out of `web/assets`, so a
 * fixture webDir has to provide all of them or the copy throws before the assertions are reached. */
const STATIC_ASSET_NAMES = [
  "app.css",
  "favicon.svg",
  "favicon-16.png",
  "favicon-32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "manifest.webmanifest",
];

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

  it("copies every static asset into the out dir and whitelists it", async () => {
    const out = mkdtempSync(join(tmpdir(), "replay-dist-brand-"));
    const pages = await buildPages("src/web", out);
    for (const name of STATIC_ASSET_NAMES) {
      // Both halves matter: the whitelist is what lets `/assets/:name` resolve the name at all,
      // and the copy is what puts a readable file behind it. Missing either one is a 404/500.
      expect(pages.assetFile(name)).not.toBeNull();
      expect(existsSync(join(out, name))).toBe(true);
    }
  }, 30_000);

  it("stamps every asset URL in the shells with a per-file content hash", async () => {
    const out = mkdtempSync(join(tmpdir(), "replay-dist-stamp-"));
    const pages = await buildPages("src/web", out);
    for (const page of ["login", "camera", "control", "clips"] as const) {
      const html = pages.html(page);
      // Every /assets/… the markup emits has to carry a stamp, not just the ones spot-checked
      // below: a single unstamped URL is exactly what a cache holds across a deploy, which is the
      // failure this mechanism exists to prevent. Collect them all and assert on each.
      const urls = [...html.matchAll(/\/assets\/[\w.-]+(\?v=[0-9a-f]{8})?/g)];
      expect(urls.length).toBeGreaterThan(0);
      for (const [url, version] of urls) {
        if (!version) throw new Error(`${page}: unstamped asset URL ${url}`);
      }
      expect(html).toMatch(/\/assets\/app\.css\?v=[0-9a-f]{8}/);
    }
    expect(pages.html("login")).toMatch(/\/assets\/login\.js\?v=[0-9a-f]{8}/);
    expect(pages.html("camera")).toMatch(/\/assets\/favicon\.svg\?v=[0-9a-f]{8}/);
  }, 30_000);

  it("changes an asset's stamp only when that asset's bytes change", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "replay-web-stamp-"));
    for (const p of ["camera", "control", "clips"]) mkdirSync(join(webDir, p), { recursive: true });
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "login.ts"), "export {};\n");
    for (const p of ["camera", "control", "clips"]) {
      writeFileSync(join(webDir, p, `${p}.ts`), "export {};\n");
      writeFileSync(
        join(webDir, p, "index.html"),
        `<link rel="stylesheet" href="/assets/app.css"><script src="/assets/${p}.js"></script>`,
      );
    }
    writeFileSync(join(webDir, "index.html"), '<link rel="stylesheet" href="/assets/app.css">');
    // Seed every static asset first, then give app.css the content this test actually varies —
    // the loop would otherwise overwrite it and the stamp could never change.
    for (const name of STATIC_ASSET_NAMES) writeFileSync(join(webDir, "assets", name), name);
    writeFileSync(join(webDir, "assets", "app.css"), "body{color:red}\n");

    const stampFor = (html: string) => html.match(/app\.css\?v=([0-9a-f]{8})/)![1];
    const first = stampFor(
      (await buildPages(webDir, mkdtempSync(join(tmpdir(), "d1-")))).html("login"),
    );

    // Rebuilt from identical bytes: the stamp must hold, or every restart would invalidate every
    // client's cache and `immutable` would buy nothing.
    const rebuilt = stampFor(
      (await buildPages(webDir, mkdtempSync(join(tmpdir(), "d2-")))).html("login"),
    );
    expect(rebuilt).toBe(first);

    writeFileSync(join(webDir, "assets", "app.css"), "body{color:blue}\n");
    const changed = stampFor(
      (await buildPages(webDir, mkdtempSync(join(tmpdir(), "d3-")))).html("login"),
    );
    expect(changed).not.toBe(first);
  }, 30_000);

  it("gives every role page a link back to the role picker", async () => {
    const out = mkdtempSync(join(tmpdir(), "replay-dist-back-"));
    const pages = await buildPages("src/web", out);
    // The role pages are reached by assignment to location.href, never as a nested route, so the
    // browser's own back affordance is the only other way out — and there isn't one in a
    // standalone/home-screen launch. Losing this link strands the operator on the page.
    for (const page of ["camera", "control", "clips"] as const) {
      expect(pages.html(page)).toContain('class="back"');
      expect(pages.html(page)).toContain('href="/"');
    }
    expect(pages.html("login")).not.toContain('class="back"');
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
