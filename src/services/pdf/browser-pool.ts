import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { Logger } from 'pino';

export interface BrowserPoolOptions {
  size: number;
  idleTtlMs: number;
  maxQueueDepth?: number;
  logger: Logger;
}

export class PoolBackpressureError extends Error {
  constructor() {
    super('Browser pool queue depth exceeded');
    this.name = 'PoolBackpressureError';
  }
}

export class PoolStoppedError extends Error {
  constructor() {
    super('Browser pool stopped');
    this.name = 'PoolStoppedError';
  }
}

interface PoolEntry {
  context: BrowserContext;
  busy: boolean;
  poisoned: boolean;
  lastUsed: number;
}

type Waiter = {
  resolve: (entry: PoolEntry) => void;
  reject: (err: Error) => void;
};

export class BrowserPool {
  private browser: Browser | undefined;
  private entries: PoolEntry[] = [];
  private waiters: Waiter[] = [];
  private sweeper?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private stopped = false;

  constructor(private readonly opts: BrowserPoolOptions) {}

  async start(): Promise<void> {
    if (this.stopped) throw new PoolStoppedError();
    if (this.browser) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.opts.logger.info({ size: this.opts.size }, 'launching chromium');
      this.browser = await chromium.launch({
        headless: true,
        args: [
          // --no-sandbox is required when running inside a container without
          // user namespaces. Pair with: non-root user, read-only rootfs, and
          // (in production) a seccomp profile + cgroup memory limits per pod.
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--font-render-hinting=none',
          '--hide-scrollbars',
          '--mute-audio',
          '--disable-background-networking',
          '--disable-extensions',
          '--disable-sync',
          // Site isolation is now ENABLED. The earlier `--disable-features=
          // IsolateOrigins,site-per-process` flag was removed because a URL→
          // PDF service is precisely the workload Chromium's site-isolation
          // sandbox was built to protect. Memory cost is acceptable at our
          // pool sizes (≤4 contexts).
        ],
      });
      this.browser.on('disconnected', () => {
        this.opts.logger.warn('chromium disconnected; poisoning pool');
        for (const e of this.entries) e.poisoned = true;
        // Free entries can be discarded immediately.
        this.entries = this.entries.filter((e) => e.busy);
        this.browser = undefined;
        // Reject queued waiters; they'll re-trigger start() on next checkout.
        const err = new Error('Browser disconnected');
        for (const w of this.waiters.splice(0)) w.reject(err);
      });
      this.sweeper = setInterval(() => void this.sweepIdle(), 30_000);
      this.sweeper.unref?.();
    })().finally(() => {
      delete this.starting;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweeper) clearInterval(this.sweeper);
    const err = new PoolStoppedError();
    for (const w of this.waiters.splice(0)) w.reject(err);
    await Promise.allSettled(this.entries.map((e) => e.context.close()));
    this.entries = [];
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = undefined;
    }
  }

  private async createContext(): Promise<PoolEntry> {
    if (!this.browser) await this.start();
    if (this.stopped) throw new PoolStoppedError();
    const ctx = await this.browser!.newContext({
      acceptDownloads: false,
      bypassCSP: false,
      javaScriptEnabled: true,
    });
    const entry: PoolEntry = { context: ctx, busy: true, poisoned: false, lastUsed: Date.now() };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Atomically claim a free entry by flipping `busy` synchronously, before any
   * await — this prevents the sweeper from closing a context we just selected.
   */
  private claimFreeEntry(): PoolEntry | undefined {
    for (const e of this.entries) {
      if (!e.busy && !e.poisoned) {
        e.busy = true;
        e.lastUsed = Date.now();
        return e;
      }
    }
    return undefined;
  }

  async checkout(): Promise<BrowserContext> {
    if (this.stopped) throw new PoolStoppedError();
    if (!this.browser) await this.start();

    const free = this.claimFreeEntry();
    if (free) return free.context;

    if (this.entries.length < this.opts.size) {
      const entry = await this.createContext();
      return entry.context;
    }
    const cap = this.opts.maxQueueDepth ?? this.opts.size * 4;
    if (this.waiters.length >= cap) throw new PoolBackpressureError();
    return new Promise<BrowserContext>((resolve, reject) => {
      this.waiters.push({
        resolve: (entry) => {
          entry.busy = true;
          entry.lastUsed = Date.now();
          resolve(entry.context);
        },
        reject,
      });
    });
  }

  /**
   * Return a healthy context to the pool. Caller must call discard() instead
   * if the render errored or the context's state is suspect.
   */
  async release(context: BrowserContext): Promise<void> {
    const entry = this.entries.find((e) => e.context === context);
    if (!entry) return;
    if (entry.poisoned || this.stopped || !this.browser) {
      await this.discard(context);
      return;
    }
    // Per-tenant hygiene: clear cookies and permissions between renders.
    // localStorage is bound to context+origin; new origins start fresh.
    await entry.context.clearCookies().catch(() => {});
    await entry.context.clearPermissions().catch(() => {});
    entry.busy = false;
    entry.lastUsed = Date.now();
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(entry);
  }

  /**
   * Drop a context (e.g., after a render crashed or browser disconnected) and
   * pre-emptively serve a queued waiter with a fresh context.
   */
  async discard(context: BrowserContext): Promise<void> {
    const idx = this.entries.findIndex((e) => e.context === context);
    if (idx >= 0) {
      const [removed] = this.entries.splice(idx, 1);
      await removed!.context.close().catch(() => {});
    } else {
      await context.close().catch(() => {});
    }
    if (this.stopped) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      try {
        const entry = await this.createContext();
        waiter.resolve(entry);
      } catch (err) {
        waiter.reject(err as Error);
      }
    }
  }

  private async sweepIdle(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const stale = this.entries.filter(
      (e) => !e.busy && !e.poisoned && now - e.lastUsed > this.opts.idleTtlMs,
    );
    for (const entry of stale) {
      // Re-check just before close: a checkout may have flipped busy.
      if (entry.busy) continue;
      const idx = this.entries.indexOf(entry);
      if (idx >= 0) this.entries.splice(idx, 1);
      await entry.context.close().catch(() => {});
    }
  }

  size(): { total: number; busy: number; free: number; waiters: number } {
    const busy = this.entries.filter((e) => e.busy).length;
    return {
      total: this.entries.length,
      busy,
      free: this.entries.length - busy,
      waiters: this.waiters.length,
    };
  }
}
