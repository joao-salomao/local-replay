import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  combineSequentialArgs,
  combineSideBySideArgs,
  normalizeCutArgs,
  runFfmpeg,
  writeConcatList,
} from "@server/ffmpeg";

describe("writeConcatList", () => {
  it("writes one quoted line per file, escaping single quotes", () => {
    const listPath = join(mkdtempSync(join(tmpdir(), "replay-ffmpeg-")), "list.txt");
    writeConcatList(["/a/b.mp4", "/c/it's.webm"], listPath);
    expect(readFileSync(listPath, "utf8")).toBe("file '/a/b.mp4'\nfile '/c/it'\\''s.webm'");
  });

  it("resolves relative paths to absolute (ffmpeg concat resolves entries relative to the list dir, not cwd)", () => {
    const listPath = join(mkdtempSync(join(tmpdir(), "replay-ffmpeg-")), "list.txt");
    writeConcatList(["data/clips/x/raw/t-0.mp4"], listPath);
    expect(readFileSync(listPath, "utf8")).toBe(`file '${resolve("data/clips/x/raw/t-0.mp4")}'`);
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
    expect(args).toContain("-c:v libx264 -preset veryfast -crf 23");
    expect(args).toContain("-map 0:a:0 -c:a aac -b:a 128k");
    expect(args).toContain("-movflags +faststart /out/a.mp4");
  });

  it("resamples to CFR and re-anchors the timeline to 0 after the fps filter (robust against gapped/VFR source timestamps)", () => {
    const args = normalizeCutArgs(base).join(" ");
    // setpts=PTS-STARTPTS must come AFTER fps=N in the filter chain: it re-anchors the CFR-resampled
    // output to start at 0, not after scale/pad (order matters -- see normalizeCutArgs's doc comment).
    expect(args).toContain(
      "-vf scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=60,setpts=PTS-STARTPTS",
    );
    expect(args).toContain("-fps_mode cfr");
  });

  it("hard-caps the video stream to round(durationSec * fps) frames, belt-and-suspenders against a source that lies about its own duration", () => {
    // base: durationSec=20, fps=60 -> exactly 1200 frames.
    expect(normalizeCutArgs(base).join(" ")).toContain("-frames:v 1200");
    // non-integer product rounds rather than truncating (9.96 * 60 = 597.6 -> 598).
    expect(normalizeCutArgs({ ...base, durationSec: 9.96, fps: 60 }).join(" ")).toContain(
      "-frames:v 598",
    );
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

describe("runFfmpeg", () => {
  it("throws with the exit code and stderr tail when ffmpeg exits non-zero (real ffmpeg, real failure)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-ffmpeg-fail-"));
    const missingInput = join(dir, "does-not-exist.mp4");
    await expect(
      runFfmpeg(["-hide_banner", "-y", "-i", missingInput, join(dir, "out.mp4")]),
    ).rejects.toThrow(/ffmpeg exited/);
  });
});

describe("combine builders", () => {
  it("sequential uses concat demuxer with stream copy", () => {
    expect(combineSequentialArgs("/tmp/list.txt", "/out/combined.mp4").join(" ")).toContain(
      "-f concat -safe 0 -i /tmp/list.txt -c copy",
    );
  });

  it("grid: N=2 stays a single side-by-side row at target size", () => {
    const args = combineSideBySideArgs(
      ["/a.mp4", "/b.mp4"],
      { width: 1920, height: 1080, fps: 60 },
      "/out/c.mp4",
    ).join(" ");
    expect(args).toContain("scale=960:1080:force_original_aspect_ratio=decrease");
    expect(args).toContain("xstack=inputs=2:layout=0_0|960_0:fill=black");
    expect(args).toContain("-map 0:a:0");
  });

  it("grid: N=3 tiles ALL three angles into a 2x2 (one empty cell), not just the first two", () => {
    const args = combineSideBySideArgs(
      ["/a.mp4", "/b.mp4", "/c.mp4"],
      { width: 1920, height: 1080, fps: 30 },
      "/out/c.mp4",
    );
    const joined = args.join(" ");
    // The bug was that only the first two angles ever became inputs. Assert all three do.
    expect(args.filter((a) => a === "-i")).toHaveLength(3);
    expect(joined).toContain("/a.mp4");
    expect(joined).toContain("/b.mp4");
    expect(joined).toContain("/c.mp4");
    // 2 cols x 2 rows: uniform 960x540 cells, third pane on the second row, empty 4th filled black.
    expect(joined).toContain("scale=960:540:force_original_aspect_ratio=decrease");
    expect(joined).toContain("xstack=inputs=3:layout=0_0|960_0|0_540:fill=black");
  });

  it("grid: N=4 fills a clean 2x2", () => {
    const joined = combineSideBySideArgs(
      ["/a.mp4", "/b.mp4", "/c.mp4", "/d.mp4"],
      { width: 1920, height: 1080, fps: 30 },
      "/out/c.mp4",
    ).join(" ");
    expect(joined).toContain("xstack=inputs=4:layout=0_0|960_0|0_540|960_540:fill=black");
  });

  it("grid: N=6 becomes 3x2", () => {
    const joined = combineSideBySideArgs(
      ["/a.mp4", "/b.mp4", "/c.mp4", "/d.mp4", "/e.mp4", "/f.mp4"],
      { width: 1920, height: 1080, fps: 30 },
      "/out/c.mp4",
    ).join(" ");
    // cols=ceil(sqrt(6))=3 -> 640-wide cells, rows=2 -> 540-tall cells.
    expect(joined).toContain(
      "xstack=inputs=6:layout=0_0|640_0|1280_0|0_540|640_540|1280_540:fill=black",
    );
  });

  it("grid: audio is mapped from the configured input index, not always the first", () => {
    const joined = combineSideBySideArgs(
      ["/a.mp4", "/b.mp4", "/c.mp4"],
      { width: 1920, height: 1080, fps: 30, audioInputIndex: 2 },
      "/out/c.mp4",
    ).join(" ");
    expect(joined).toContain("-map 2:a:0"); // third camera's audio, not the default -map 0:a:0
  });
});
