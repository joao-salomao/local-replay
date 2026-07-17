import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type PageName = "login" | "camera" | "control" | "clips";
export type PageAssets = {
  html(page: PageName): string;
  assetFile(name: string): string | null;
};

const ASSET_WHITELIST = new Set(["login.js", "camera.js", "control.js", "clips.js", "app.css"]);

export async function buildPages(webDir: string, outDir: string): Promise<PageAssets> {
  mkdirSync(outDir, { recursive: true });
  const entry = (p: PageName) => (p === "login" ? join(webDir, "login.ts") : join(webDir, p, `${p}.ts`));
  const result = await Bun.build({
    entrypoints: (["login", "camera", "control", "clips"] as PageName[]).map(entry),
    outdir: outDir,
    target: "browser",
    naming: "[name].[ext]",
    minify: false,
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
