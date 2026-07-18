/**
 * NTP-style clock sync: estimate the offset between a client's local clock and the server's
 * clock so client-recorded timestamps (e.g. camera buffer file start times) can be compared
 * against each other and against server-issued trigger times on one common timeline.
 */

/** One round-trip sample: client sent an "ntp" request at `clientSent`, server stamped the reply
 * `serverTime`, client received the reply at `clientReceived` (all in each side's own clock). */
export type NtpSample = { clientSent: number; serverTime: number; clientReceived: number };

/**
 * Offset such that serverTime ≈ clientTime + offset, i.e. `serverNow = Date.now() + offset`
 * (see `web/shared/ws-client.ts#serverNow`).
 *
 * Each sample assumes symmetric network latency: the server's clock reading is compared against
 * the midpoint of when the client sent and received the round trip, which cancels out the
 * (assumed-equal) one-way delay in each direction. Taking the MEDIAN across several samples
 * (rather than the mean, or a single sample) filters out samples skewed by asymmetric or jittery
 * latency — e.g. one probe that happened to hit a slow retransmit in one direction only.
 */
export function computeOffset(samples: NtpSample[]): number {
  if (samples.length === 0) throw new Error("computeOffset: no samples");
  const offsets = samples
    .map((s) => s.serverTime - (s.clientSent + s.clientReceived) / 2)
    .sort((a, b) => a - b);
  return offsets[Math.floor(offsets.length / 2)]!;
}
