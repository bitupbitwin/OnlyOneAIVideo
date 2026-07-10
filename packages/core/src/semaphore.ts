export class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private limit: number) {}

  setLimit(limit: number) {
    this.limit = limit;
    this.drain();
  }

  async acquire(): Promise<() => void> {
    if (this.running < this.limit) {
      this.running += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running += 1;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.running -= 1;
    this.drain();
  }

  private drain() {
    while (this.running < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }
}
