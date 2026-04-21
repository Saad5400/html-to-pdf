/**
 * Per-key in-process semaphore. Limits concurrent operations sharing a key
 * (e.g. URL host) so one tenant can't pin all worker slots against a single
 * upstream and DoS it.
 */
export class KeyedSemaphore {
  private active = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();

  constructor(private readonly limit: number) {}

  async acquire(key: string): Promise<() => void> {
    const inUse = this.active.get(key) ?? 0;
    if (inUse < this.limit) {
      this.active.set(key, inUse + 1);
      return this.releaser(key);
    }
    return new Promise<() => void>((resolve) => {
      const queue = this.waiters.get(key) ?? [];
      queue.push(() => resolve(this.releaser(key)));
      this.waiters.set(key, queue);
    });
  }

  private releaser(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.waiters.get(key);
      const next = queue?.shift();
      if (next) {
        if (queue && !queue.length) this.waiters.delete(key);
        next();
      } else {
        const inUse = (this.active.get(key) ?? 1) - 1;
        if (inUse <= 0) this.active.delete(key);
        else this.active.set(key, inUse);
      }
    };
  }

  inFlight(key: string): number {
    return this.active.get(key) ?? 0;
  }

  pending(key: string): number {
    return this.waiters.get(key)?.length ?? 0;
  }
}
