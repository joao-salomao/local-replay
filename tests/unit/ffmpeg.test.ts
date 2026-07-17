import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  combineSequentialArgs,
  combineSideBySideArgs,
  normalizeCutArgs,
  writeConcatList,
} from "../../src/server/ffmpeg";

describe("writeConcatList", () => {
  it("writes one quoted line per file, escaping single quotes", () => {
    const listPath = join(mkdtempSync(join(tmpdir(), "replay-ffmpeg-")), "list.txt");
    writeConcatList(["/a/b.mp4", "/c/it's.webm"], listPath);
    expect(readFileSync(listPath, "utf8")).toBe("file '/a/b.mp4'\nfile '/c/it'\\''s.webm'");
  });
});

describe("normalizeCutArgs", () => {
  const base = {
    listFile: null,
    input: "/raw/a.webm",
    startSec: 5,
    durationSec: 20,
    width: 1920,
    height: 1080,
    fps: 60,
    hasAudio: true,
    output: "/out/a.mp4",
  };

  it("builds an accurate output-side cut with scale/pad/fps and x264/aac", () => {
    const args = normalizeCutArgs(base).join(" ");
    expect(args).toContain("-i /raw/a.webm");
    expect(args).toContain("-ss 5.000 -t 20.000");
    expect(args).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
    expect(args).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
    expect(args).toContain("fps=60");
    expect(args).toContain("-c:v libx264 -preset veryfast -crf 23");
    expect(args).toContain("-map 0:a:0 -c:a aac -b:a 128k");
    expect(args).toContain("-movflags +faststart /out/a.mp4");
  });

  it("uses the concat demuxer when listFile is set", () => {
    const args = normalizeCutArgs({ ...base, listFile: "/tmp/list.txt", input: null }).join(" ");
    expect(args).toContain("-f concat -safe 0 -i /tmp/list.txt");
  });

  it("injects a silent audio track when hasAudio is false", () => {
    const args = normalizeCutArgs({ ...base, hasAudio: false }).join(" ");
    expect(args).toContain("anullsrc=r=48000:cl=stereo");
    expect(args).toContain("-map 1:a:0");
  });
});

describe("combine builders", () => {
  it("sequential uses concat demuxer with stream copy", () => {
    expect(combineSequentialArgs("/tmp/list.txt", "/out/combined.mp4").join(" ")).toContain(
      "-f concat -safe 0 -i /tmp/list.txt -c copy",
    );
  });

  it("side-by-side stacks two halves at target size", () => {
    const args = combineSideBySideArgs(
      ["/a.mp4", "/b.mp4"],
      { width: 1920, height: 1080, fps: 60 },
      "/out/c.mp4",
    ).join(" ");
    expect(args).toContain("scale=960:1080:force_original_aspect_ratio=decrease");
    expect(args).toContain("hstack=inputs=2");
    expect(args).toContain("-map 0:a:0");
  });
});
