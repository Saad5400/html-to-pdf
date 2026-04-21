import { describe, expect, it, vi } from 'vitest';

// Stub bullmq so JobsService can be constructed without a live Redis.
const addCalls: { jobId: string; data: unknown }[] = [];
const removeCalls: string[] = [];
let nextGetJob: { id: string; returnvalue?: unknown; getState: () => Promise<string>; timestamp: number; failedReason?: string; finishedOn?: number } | null = null;

vi.mock('bullmq', () => {
  class FakeQueue {
    constructor() {}
    async add(_name: string, data: unknown, opts: { jobId: string }): Promise<void> {
      addCalls.push({ jobId: opts.jobId, data });
    }
    async remove(jobId: string): Promise<void> {
      removeCalls.push(jobId);
    }
    async getJob(): Promise<typeof nextGetJob> {
      return nextGetJob;
    }
    async close(): Promise<void> {}
  }
  class FakeQueueEvents {
    async close(): Promise<void> {}
  }
  return { Queue: FakeQueue, QueueEvents: FakeQueueEvents };
});

class FakeRedis {
  store = new Map<string, string>();
  duplicate(): FakeRedis {
    return new FakeRedis();
  }
  async set(key: string, value: string, _ex: 'EX', _ttl: number, mode?: 'NX'): Promise<'OK' | null> {
    if (mode === 'NX' && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

vi.mock('ioredis', () => {
  return { default: FakeRedis };
});

const { JobsService, idempotencyHash, closeAllRedis } = await import('@/services/queue/index.js');
const { ConvertRequestSchema } = await import('@/schemas/convert.js');
const { loadConfig } = await import('@/config/index.js');

describe('JobsService.enqueue', () => {
  const config = loadConfig({ REDIS_URL: 'redis://stub' });
  const body = ConvertRequestSchema.parse({ html: '<p>x</p>' });

  it('enqueues a fresh job', async () => {
    addCalls.length = 0;
    removeCalls.length = 0;
    const svc = new JobsService(config);
    const out = await svc.enqueue('job_abc1', { request: body });
    expect(out).toEqual({ jobId: 'job_abc1', deduped: false });
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]?.jobId).toBe('job_abc1');
    await svc.close();
    await closeAllRedis();
  });

  it('returns existing jobId when idempotency key is reused', async () => {
    addCalls.length = 0;
    removeCalls.length = 0;
    const svc = new JobsService(config);
    const first = await svc.enqueue('job_first1', {
      request: body,
      apiKeyId: 'tenant-1',
      idempotencyKey: 'idem-1',
    });
    expect(first).toEqual({ jobId: 'job_first1', deduped: false });

    const second = await svc.enqueue('job_secnd1', {
      request: body,
      apiKeyId: 'tenant-1',
      idempotencyKey: 'idem-1',
    });
    expect(second).toEqual({ jobId: 'job_first1', deduped: true });
    // Lost-race rollback: second job was added but immediately removed.
    expect(removeCalls).toContain('job_secnd1');
    await svc.close();
    await closeAllRedis();
  });

  it('keeps separate keyspaces per tenant', async () => {
    const svc = new JobsService(config);
    const a = await svc.enqueue('job_a', { request: body, apiKeyId: 'tenant-A', idempotencyKey: 'k1' });
    const b = await svc.enqueue('job_b', { request: body, apiKeyId: 'tenant-B', idempotencyKey: 'k1' });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(false);
    await svc.close();
    await closeAllRedis();
  });

  it('reads job state via getJob', async () => {
    const svc = new JobsService(config);
    nextGetJob = {
      id: 'job_read',
      timestamp: 1234,
      finishedOn: 5678,
      getState: async () => 'completed',
    };
    const rec = await svc.get('job_read');
    expect(rec?.status).toBe('completed');
    expect(rec?.createdAt).toContain('1970-01-01');
    nextGetJob = null;
    await svc.close();
    await closeAllRedis();
  });

  it('returns undefined when bullmq has no record', async () => {
    const svc = new JobsService(config);
    nextGetJob = null;
    const rec = await svc.get('job_missing');
    expect(rec).toBeUndefined();
    await svc.close();
    await closeAllRedis();
  });

  it('idempotencyHash refuses anonymous traffic', () => {
    expect(() => idempotencyHash(undefined, 'k', body)).toThrow(/apiKeyId is required/);
  });
});
