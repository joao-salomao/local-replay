export type BufferFile = { startMs: number; durationMs: number };

export function cycleSeconds(clipDurationSeconds: number, minCycleSeconds: number): number {
  return Math.max(minCycleSeconds, clipDurationSeconds);
}

export function selectFilesForWindow<T extends BufferFile>(
  files: T[],
  windowStartMs: number,
  windowEndMs: number,
): T[] {
  return files
    .filter((f) => f.startMs < windowEndMs && f.startMs + f.durationMs > windowStartMs)
    .sort((a, b) => a.startMs - b.startMs);
}

export function computeCutWindow(
  files: BufferFile[],
  windowStartMs: number,
  windowEndMs: number,
): { startSec: number; durationSec: number } {
  if (files.length === 0) throw new Error("computeCutWindow: no files");
  const sorted = [...files].sort((a, b) => a.startMs - b.startMs);
  let elapsed = 0;
  const spans = sorted.map((f) => {
    const span = { mediaStartMs: elapsed, startMs: f.startMs, durationMs: f.durationMs };
    elapsed += f.durationMs;
    return span;
  });
  const totalMs = elapsed;
  const toMediaMs = (ts: number): number => {
    for (const s of spans) {
      if (ts < s.startMs) return s.mediaStartMs; // inside a gap → snap forward
      if (ts <= s.startMs + s.durationMs) return s.mediaStartMs + (ts - s.startMs);
    }
    return totalMs;
  };
  const startMs = toMediaMs(windowStartMs);
  const endMs = toMediaMs(windowEndMs);
  return { startSec: startMs / 1000, durationSec: Math.max(0, endMs - startMs) / 1000 };
}
