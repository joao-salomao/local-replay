export type NtpSample = { clientSent: number; serverTime: number; clientReceived: number };

/** Offset such that serverTime ≈ clientTime + offset. Median across samples. */
export function computeOffset(samples: NtpSample[]): number {
  if (samples.length === 0) throw new Error("computeOffset: no samples");
  const offsets = samples
    .map((s) => s.serverTime - (s.clientSent + s.clientReceived) / 2)
    .sort((a, b) => a - b);
  return offsets[Math.floor(offsets.length / 2)]!;
}
