/**
 * Runs tasks concurrently across keys and sequentially within a key.
 *
 * A Kafka partition carries many recipients. Processing it one message at a time caps
 * throughput at 1 / provider latency per partition; processing it fully in parallel breaks the
 * per-recipient order that keying by recipient was meant to give. This executor sits between:
 * different recipients go in parallel (up to `concurrency`), messages for the same recipient
 * keep their order.
 */
export class KeyedExecutor {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;
  private readonly pending = new Set<Promise<void>>();
  private firstError: unknown;

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError('concurrency must be a positive integer');
    }
  }

  /** Queues `task` behind earlier tasks with the same key. Never rejects; errors surface in drain(). */
  submit(key: string, task: () => Promise<void>): void {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      await this.acquire();
      try {
        await task();
      } catch (err) {
        if (this.firstError === undefined) this.firstError = err;
      } finally {
        this.release();
      }
    });
    this.tails.set(key, run);
    this.pending.add(run);
    void run.finally(() => {
      this.pending.delete(run);
      if (this.tails.get(key) === run) this.tails.delete(key);
    });
  }

  /** Waits for every submitted task. Rethrows the first task error, if any, and resets it. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    const err = this.firstError;
    this.firstError = undefined;
    if (err !== undefined) throw err;
  }

  get inFlight(): number {
    return this.active;
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      }),
    );
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}
