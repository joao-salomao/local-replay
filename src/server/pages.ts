import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type PageName = "login" | "camera" | "control" | "clips";
export type PageAssets = {
  html(page: PageName): string;
  assetFile(name: string): string | null;
};

// Explicit allowlist of servable built filenames. `assetFile` is reachable via routes.ts's
// `/assets/:name` with a user-supplied `:name` — an allowlist is a simpler, stronger guard than
// trying to path-traversal-proof an arbitrary filename, and is checked independently of it.
const ASSET_WHITELIST = new Set(["login.js", "camera.js", "control.js", "clips.js", "app.css"]);

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
  copyFileSync(join(webDir, "shared", "app.css"), join(outDir, "app.css"));

  const htmlByPage: Record<PageName, string> = {
    login: readFileSync(join(webDir, "index.html"), "utf8"),
    camera: readFileSync(join(webDir, "camera", "index.html"), "utf8"),
    control: readFileSync(join(webDir, "control", "index.html"), "utf8"),
    clips: readFileSync(join(webDir, "clips", "index.html"), "utf8"),
  };
  return {
    html: (page) => htmlByPage[page],
    assetFile: (name) => (ASSET_WHITELIST.has(name) ? resolve(outDir, name) : null),
  };
}
