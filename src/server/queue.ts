export class SerialQueue {
  private chain: Promise<void> = Promise.resolve();

  push(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}
