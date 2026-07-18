import type { LogEntry } from "@shared/protocol";

/**
 * Bounded ring buffer of the most recent log entries, so a control page that connects (or
 * re-opens the log viewer) after some lines were already emitted can still backfill history
 * instead of only seeing lines from that moment forward. See `routes.ts`'s `GET /api/logs` (reads
 * it) and `server/index.ts`'s log sink wiring (writes to it).
 */
export class LogBuffer {
  private buf: LogEntry[] = [];
  private readonly capacity: number;

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  /** Drops the oldest entry once `capacity` is exceeded — simple array shift over a true circular
   * index, which is plenty cheap at the capacities this is actually used at (low hundreds). */
  push(e: LogEntry): void {
    this.buf.push(e);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  /** Oldest → newest. Returns a fresh array each call, safe for a caller to hold onto or mutate
   * without affecting the buffer (mirrors `Hub.cameras()`'s copy-out convention). */
  entries(): LogEntry[] {
    return [...this.buf];
  }
}
