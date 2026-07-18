/**
 * Runs pushed tasks strictly one at a time, in submission order — used by `clip-job.ts` to keep
 * ffmpeg processing for multiple clips from running concurrently (ffmpeg is CPU/memory heavy;
 * this bounds it to one job at a time on what's typically a modest local machine).
 */
export class SerialQueue {
  private chain: Promise<void> = Promise.resolve();

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
