/**
 * Runs pushed tasks strictly one at a time, in submission order — used by `clip-job.ts` to keep
 * ffmpeg processing for multiple clips from running concurrently (ffmpeg is CPU/memory heavy;
 * this bounds it to one job at a time on what's typically a modest local machine).
 */
export class SerialQueue {
  private chain: Promise<void>;

  // Explicit constructor (rather than a class-field initializer) is deliberate: Bun 1.3.1's
  // function-coverage counter always reserves one "found" function slot for a class's
  // constructor, but only ever marks it "hit" if the constructor is user-written — a class with
  // only a field initializer and no explicit constructor is structurally stuck below 100%
  // function coverage no matter how thoroughly it's tested (verified with a throwaway repro).
  // Giving SerialQueue a real constructor body fixes that for real, since every test already goes
  // through `new SerialQueue()`.
  constructor() {
    this.chain = Promise.resolve();
  }

  /**
   * Queues `task` to run after everything already queued. Two subtleties make this correct:
   * - `this.chain.then(task, task)` runs `task` once the previous entry SETTLES, whether it
   *   resolved or rejected — so one task's failure doesn't stall every task queued after it.
   * - `this.chain` is then reassigned to a version of that same run with both outcomes mapped to
   *   a resolved `undefined` (`run.then(() => {}, () => {})`), so the internal chain itself can
   *   never become a rejected promise — if it did, EVERY future `push` would immediately see a
   *   rejected chain and never serialize properly again.
   *
   * The returned promise is the real, unmapped result of `task` — callers still see its actual
   * success or failure; only the internal bookkeeping chain swallows errors.
   */
  push(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}
