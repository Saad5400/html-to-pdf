import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/index.js';
import { JobStore } from '@/services/queue/job-store.js';
import type { JobRecord } from '@/types/index.js';

class FakeRedis {
  store = new Map<string, { val: string; exp: number }>();
  async set(key: string, val: string, _ex: 'EX', ttlSec: number): Promise<'OK'> {
    this.store.set(key, { val, exp: Date.now() + ttlSec * 1000 });
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) {
      this.store.delete(key);
      return null;
    }
    return e.val;
  }
}

describe('JobStore', () => {
  const config = loadConfig({});
  it('persists and reads a completed result', async () => {
    const r = new FakeRedis() as never;
    const store = new JobStore(r, config);
    await store.writeCompleted('job_a', 'tenant-1', {
      storageKey: 'pdfs/x.pdf',
      bytes: 100,
      pages: 1,
      sha256: 'abc',
    });
    const back = await store.read('job_a');
    expect(back?.status).toBe('completed');
    expect(back?.storageKey).toBe('pdfs/x.pdf');
    expect(back?.apiKeyId).toBe('tenant-1');
  });

  it('persists a failure', async () => {
    const r = new FakeRedis() as never;
    const store = new JobStore(r, config);
    await store.writeFailed('job_b', undefined, 'render exploded');
    const back = await store.read('job_b');
    expect(back?.status).toBe('failed');
    expect(back?.error).toBe('render exploded');
  });

  it('hydrate fills a JobRecord with persisted fields', async () => {
    const r = new FakeRedis() as never;
    const store = new JobStore(r, config);
    await store.writeCompleted('job_c', 'tenant-2', {
      storageKey: 'pdfs/y.pdf',
      bytes: 200,
      pages: 2,
      sha256: 'def',
    });
    const persisted = (await store.read('job_c'))!;
    const rec: JobRecord = { id: 'job_c', status: 'queued', createdAt: 'x' };
    store.hydrate(rec, persisted);
    expect(rec.status).toBe('completed');
    expect(rec.result?.storageKey).toBe('pdfs/y.pdf');
    expect(rec.result?.pages).toBe(2);
  });
});
