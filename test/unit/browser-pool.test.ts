import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

vi.mock('playwright', () => {
  let nextContextId = 0;
  const closedContexts: number[] = [];
  const ctxOf = (id: number): { __id: number; close: () => Promise<void>; clearCookies: () => Promise<void>; clearPermissions: () => Promise<void> } => ({
    __id: id,
    close: vi.fn(async () => {
      closedContexts.push(id);
    }),
    clearCookies: vi.fn(async () => {}),
    clearPermissions: vi.fn(async () => {}),
  });
  const browser = {
    on: vi.fn(),
    close: vi.fn(async () => {}),
    newContext: vi.fn(async () => ctxOf(++nextContextId)),
  };
  return {
    chromium: { launch: vi.fn(async () => browser) },
    __closedContexts: closedContexts,
  };
});

const { BrowserPool, PoolBackpressureError, PoolStoppedError } = await import(
  '@/services/pdf/browser-pool.js'
);

describe('BrowserPool', () => {
  const logger = pino({ level: 'silent' });

  it('caps active contexts at size and queues waiters', async () => {
    const pool = new BrowserPool({ size: 2, idleTtlMs: 60_000, maxQueueDepth: 4, logger });
    const a = await pool.checkout();
    const b = await pool.checkout();
    expect(pool.size().total).toBe(2);
    expect(pool.size().free).toBe(0);

    const cPromise = pool.checkout();
    expect(pool.size().waiters).toBe(1);
    await pool.release(a);
    const c = await cPromise;
    expect(pool.size().waiters).toBe(0);
    expect(c).toBeDefined();

    await pool.release(b);
    await pool.release(c);
    await pool.stop();
  });

  it('throws PoolBackpressureError past maxQueueDepth', async () => {
    const pool = new BrowserPool({ size: 1, idleTtlMs: 60_000, maxQueueDepth: 1, logger });
    const _busy = await pool.checkout();
    const queued = pool.checkout();
    queued.catch(() => {});
    await expect(pool.checkout()).rejects.toThrow(PoolBackpressureError);
    await pool.stop();
  });

  it('rejects pending waiters on stop()', async () => {
    const pool = new BrowserPool({ size: 1, idleTtlMs: 60_000, maxQueueDepth: 4, logger });
    const _busy = await pool.checkout();
    const waiter = pool.checkout();
    await pool.stop();
    await expect(waiter).rejects.toThrow(PoolStoppedError);
  });

  it('discard frees a slot and serves the next waiter', async () => {
    const pool = new BrowserPool({ size: 1, idleTtlMs: 60_000, maxQueueDepth: 4, logger });
    const a = await pool.checkout();
    const waiter = pool.checkout();
    await pool.discard(a);
    const b = await waiter;
    expect(b).toBeDefined();
    await pool.release(b);
    await pool.stop();
  });
});
