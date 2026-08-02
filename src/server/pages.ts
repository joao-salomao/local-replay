import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type PageName = "login" | "camera" | "control" | "clips";
export type PageAssets = {
  html(page: PageName): string;
  assetFile(name: string): string | null;
};

// Everything under `web/assets` — the stylesheet, the favicon set, the PWA icons and manifest.
// Copied rather than bundled: nothing imports these, they're referenced by URL from the HTML
// shells and from the manifest. That is what the directory means, and the split against
// `web/shared` is what keeps this list honest — `shared` holds modules the pages import, `assets`
// holds files served verbatim, so a file's location tells you how it reaches the browser.
const STATIC_ASSETS = [
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

// Explicit allowlist of servable built filenames. `assetFile` is reachable via routes.ts's
// `/assets/:name` with a user-supplied `:name` — an allowlist is a simpler, stronger guard than
// trying to path-traversal-proof an arbitrary filename, and is checked independently of it.
const ASSET_WHITELIST = new Set([
  "login.js",
  "camera.js",
  "control.js",
  "clips.js",
  ...STATIC_ASSETS,
]);

/** Content hash, short enough to keep URLs readable — this only has to change when bytes do, so
 * it needs no cryptographic strength and no collision headroom beyond a build's handful of files. */
const versionOf = (path: string) =>
  createHash("sha1").update(readFileSync(path)).digest("hex").slice(0, 8);

/**
 * Rewrites every `/assets/<name>` URL in `html` to `/assets/<name>?v=<hash>`.
 *
 * Filenames are stable across builds, so without this a cache holds `app.css` and keeps serving
 * yesterday's bytes under today's name — the failure this pairs with `immutable` in routes.ts to
 * make impossible. The hash is per file rather than one build-wide stamp, so rebuilding only
 * invalidates what actually changed instead of every asset on every restart.
 *
 * Names with no stamp are left alone, which is what keeps the manifest's own icon URLs (rewritten
 * nowhere, since the manifest is copied verbatim) from being silently half-processed: they stay
 * unversioned, and routes.ts serves unversioned URLs as `no-cache`. PWA icons change about never,
 * so the tradeoff is one revalidation against threading the rewrite through a second file format.
 */
function stampAssetUrls(html: string, versions: Map<string, string>): string {
  return html.replace(/\/assets\/([\w.-]+)/g, (url, name: string) => {
    const version = versions.get(name);
    return version ? `${url}?v=${version}` : url;
  });
}

/**
 * Bundles the four web entrypoints (one per `PageName`) with `Bun.build` and reads their static
 * HTML shells, returning an in-memory accessor `routes.ts` uses to serve pages/assets without
 * touching the filesystem per request. Minification is deliberately off — this is a local/LAN
 * tool where bundle size barely matters, and keeping stack traces/DevTools output readable is
 * worth more than the size win. Throws if bundling fails, so a broken build fails fast at boot
 * rather than serving broken JS to clients.
 */
export async function buildPages(webDir: string, outDir: string): Promise<PageAssets> {
  mkdirSync(outDir, { recursive: true });
  const entry = (p: PageName) =>
    p === "login" ? join(webDir, "login.ts") : join(webDir, p, `${p}.ts`);
  const result = await Bun.build({
    entrypoints: (["login", "camera", "control", "clips"] as PageName[]).map(entry),
    outdir: outDir,
    target: "browser",
    naming: "[name].[ext]",
    minify: false,
    // Bun.build defaults to `throw: true`, which rejects with its own raw AggregateError on any
    // bundling failure — bypassing the `result.success` check below entirely (it would never see
    // a `false` value; the throw already happened). `throw: false` makes failures come back as
    // data instead, so the check below is live and can wrap them in one readable message
    // aggregating every entrypoint's errors, rather than surfacing Bun's own less-readable one.
    throw: false,
  });
  if (!result.success) {
    throw new Error(`page bundling failed: ${result.logs.map(String).join("\n")}`);
  }
  for (const name of STATIC_ASSETS) {
    copyFileSync(join(webDir, "assets", name), join(outDir, name));
  }

  // Hashed after every file is in place, so the stamps describe what is actually being served.
  const versions = new Map([...ASSET_WHITELIST].map((n) => [n, versionOf(join(outDir, n))]));

  const shell = (...path: string[]) =>
    stampAssetUrls(readFileSync(join(webDir, ...path), "utf8"), versions);
  const htmlByPage: Record<PageName, string> = {
    login: shell("index.html"),
    camera: shell("camera", "index.html"),
    control: shell("control", "index.html"),
    clips: shell("clips", "index.html"),
  };
  return {
    html: (page) => htmlByPage[page],
    assetFile: (name) => (ASSET_WHITELIST.has(name) ? resolve(outDir, name) : null),
  };
}
