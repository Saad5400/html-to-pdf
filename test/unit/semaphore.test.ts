import { describe, expect, it } from 'vitest';
import { KeyedSemaphore } from '@/lib/semaphore.js';

describe('KeyedSemaphore', () => {
  it('lets up to `limit` callers run per key, queues the rest', async () => {
    const sem = new KeyedSemaphore(2);
    const r1 = await sem.acquire('a');
    const r2 = await sem.acquire('a');
    expect(sem.inFlight('a')).toBe(2);
    expect(sem.pending('a')).toBe(0);

    let unblocked = false;
    const r3p = sem.acquire('a').then((rel) => {
      unblocked = true;
      return rel;
    });
    await new Promise((r) => setImmediate(r));
    expect(unblocked).toBe(false);
    expect(sem.pending('a')).toBe(1);

    r1();
    const r3 = await r3p;
    expect(unblocked).toBe(true);

    r2();
    r3();
    expect(sem.inFlight('a')).toBe(0);
  });

  it('keys are independent', async () => {
    const sem = new KeyedSemaphore(1);
    const ra = await sem.acquire('a');
    const rb = await sem.acquire('b');
    expect(sem.inFlight('a')).toBe(1);
    expect(sem.inFlight('b')).toBe(1);
    ra();
    rb();
  });

  it('double-release is a no-op', async () => {
    const sem = new KeyedSemaphore(1);
    const r = await sem.acquire('x');
    r();
    r();
    expect(sem.inFlight('x')).toBe(0);
  });
});
