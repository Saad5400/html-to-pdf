import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import sensible from '@fastify/sensible';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/index.js';
import authPlugin from '@/plugins/auth.js';
import errorHandler from '@/plugins/error-handler.js';
import jobsRoute from '@/routes/jobs.js';
import { ApiKeyService } from '@/services/auth/api-key.js';
import type { ConvertJobResult } from '@/services/queue/index.js';
import type { JobRecord, StorageAdapter } from '@/types/index.js';

interface PersistedResult {
  jobId: string;
  status: 'completed' | 'failed';
  storageKey?: string;
  bytes?: number;
  pages?: number;
  sha256?: string;
  finishedAt: string;
  apiKeyId?: string;
}

class FakeJobs {
  queue = {
    async getJob(): Promise<{ returnvalue?: ConvertJobResult } | undefined> {
      return undefined;
    },
    async close(): Promise<void> {},
  };
  events = { async close(): Promise<void> {} };
  redis = {} as never;
  liveRecord: JobRecord | undefined;
  enqueueResult: { jobId: string; deduped: boolean } = { jobId: 'job_x', deduped: false };
  liveReturnValue: ConvertJobResult | undefined;
  async enqueue(): Promise<{ jobId: string; deduped: boolean }> {
    return this.enqueueResult;
  }
  async get(): Promise<JobRecord | undefined> {
    return this.liveRecord;
  }
  async close(): Promise<void> {}
}

class FakeStore {
  persisted: PersistedResult | undefined;
  async writeCompleted(): Promise<void> {}
  async writeFailed(): Promise<void> {}
  async read(): Promise<PersistedResult | undefined> {
    return this.persisted;
  }
  hydrate(rec: JobRecord, p: PersistedResult): JobRecord {
    rec.status = p.status;
    rec.finishedAt = p.finishedAt;
    if (p.status === 'completed' && p.storageKey) {
      rec.result = {
        storageKey: p.storageKey,
        bytes: p.bytes ?? 0,
        pages: p.pages ?? 0,
        sha256: p.sha256 ?? '',
        downloadUrl: '',
        expiresAt: '',
      };
    }
    return rec;
  }
}

class FakeStorage implements StorageAdapter {
  async put(): Promise<void> {}
  async get(): Promise<Buffer> {
    return Buffer.from('');
  }
  async delete(): Promise<void> {}
  async exists(): Promise<boolean> {
    return true;
  }
  async signedUrl(key: string): Promise<string> {
    return `/signed?key=${encodeURIComponent(key)}`;
  }
}

async function buildAppForJobs(): Promise<{
  app: ReturnType<typeof Fastify>;
  jobs: FakeJobs;
  store: FakeStore;
}> {
  const config = loadConfig({ API_KEYS: 'test-key' });
  const jobs = new FakeJobs();
  const store = new FakeStore();
  const storage = new FakeStorage();
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  app.decorate('metrics', { renderErrors: { labels: () => ({ inc: () => undefined }) } } as never);
  await app.register(authPlugin, { apiKeys: new ApiKeyService(config), required: true });
  await app.register(errorHandler);
  await app.register(jobsRoute, {
    jobs: jobs as never,
    jobStore: store as never,
    storage,
    config,
  });
  await app.ready();
  return { app, jobs, store };
}

describe('jobs route GET /v1/jobs/:id', () => {
  let h: Awaited<ReturnType<typeof buildAppForJobs>>;

  beforeEach(async () => {
    h = await buildAppForJobs();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it('returns 404 when neither BullMQ nor JobStore has the id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/jobs/job_aaaaaaaaaaaaaaaaaaaaa',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('falls back to JobStore after BullMQ eviction', async () => {
    h.store.persisted = {
      jobId: 'job_b',
      status: 'completed',
      storageKey: 'pdfs/x.pdf',
      bytes: 100,
      pages: 1,
      sha256: 'abc',
      finishedAt: '2026-01-01T00:00:00.000Z',
    };
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/jobs/job_bbbbbbbbbbbbbbbbbbbbb',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.result.storageKey).toBe('pdfs/x.pdf');
    expect(body.result.downloadUrl).toContain('signed?key=');
    expect(body.result.expiresAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('populates downloadUrl from BullMQ live returnvalue when present', async () => {
    h.jobs.liveRecord = {
      id: 'job_c',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    h.jobs.queue.getJob = async () => ({
      returnvalue: { storageKey: 'pdfs/c.pdf', bytes: 1, pages: 1, sha256: 'def' },
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/jobs/job_ccccccccccccccccccccc',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.downloadUrl).toContain('signed?key=');
  });

  it('POST /v1/jobs rejects private webhookUrl via SSRF guard', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: { html: '<p/>', webhookUrl: 'http://127.0.0.1/hook' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error || res.json().message).toBeDefined();
  });

  it('POST /v1/jobs returns deduped:true when JobsService says so', async () => {
    h.jobs.enqueueResult = { jobId: 'existing-1', deduped: true };
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json', 'idempotency-key': 'key-1234567890' },
      payload: { html: '<p/>' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ jobId: 'existing-1', deduped: true, status: 'deduped' });
  });
});
