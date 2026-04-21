import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as PdfModule from '@/services/pdf/index.js';
import type * as SsrfModule from '@/security/ssrf.js';

vi.mock('@/services/pdf/index.js', async () => {
  const actual = await vi.importActual<typeof PdfModule>('@/services/pdf/index.js');
  const { assertSafeUrl } = await vi.importActual<typeof SsrfModule>('@/security/ssrf.js');
  class FakeBrowserPool {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    size(): { total: number; busy: number; free: number; waiters: number } {
      return { total: 0, busy: 0, free: 0, waiters: 0 };
    }
  }
  class FakeRenderer {
    async render(req: { url?: string; html?: string }): Promise<{
      pdf: Buffer;
      pages: number;
      bytes: number;
      durationMs: number;
    }> {
      if (req.url) {
        await assertSafeUrl(req.url, {
          allowedHosts: [],
          blockedHosts: [],
          allowPrivateNetworks: false,
        });
      }
      const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >> endobj\n%%EOF');
      return { pdf, pages: 1, bytes: pdf.byteLength, durationMs: 1 };
    }
  }
  return { ...actual, BrowserPool: FakeBrowserPool, PdfRenderer: FakeRenderer };
});

vi.mock('@/services/queue/index.js', () => {
  const fakeRedis = {
    ping: async () => 'PONG',
    quit: async () => 'OK',
    duplicate() {
      return this;
    },
  };
  class FakeJobs {
    queue = { getJob: async () => undefined, close: async () => {} };
    events = { close: async () => {} };
    redis = fakeRedis;
    async enqueue(jobId: string): Promise<{ jobId: string; deduped: boolean }> {
      return { jobId, deduped: false };
    }
    async get(): Promise<undefined> {
      return undefined;
    }
    async close(): Promise<void> {}
  }
  return {
    getRedis: () => fakeRedis,
    closeAllRedis: async () => {},
    JobsService: FakeJobs,
  };
});

vi.mock('@/services/queue/job-store.js', () => {
  class FakeJobStore {
    async writeCompleted(): Promise<void> {}
    async writeFailed(): Promise<void> {}
    async read(): Promise<undefined> {
      return undefined;
    }
    hydrate<T>(rec: T): T {
      return rec;
    }
  }
  return { JobStore: FakeJobStore };
});

vi.mock('@fastify/rate-limit', () => ({
  default: async (app: { addHook: (...args: unknown[]) => void }) => {
    void app;
  },
}));

import { buildApp, type AppHandle } from '@/app.js';
import { loadConfig } from '@/config/index.js';

describe('HTTP API (integration, mocked deps)', () => {
  let app: AppHandle;

  beforeAll(async () => {
    const config = loadConfig({
      API_KEYS: 'test-key',
      LOG_LEVEL: 'silent',
    });
    app = await buildApp(config);
    await app.server.ready();
  });

  afterAll(async () => {
    await app.shutdown();
  });

  it('GET /health/live returns ok', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns ok with mocked redis', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
  });

  it('POST /v1/convert without auth → 401', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/convert',
      payload: { html: '<p>x</p>' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/convert with bad input → 400', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/convert',
      headers: { 'x-api-key': 'test-key' },
      payload: { url: 'https://x.com', html: '<p>x</p>' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/convert with html → returns PDF', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/convert',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: { html: '<p>hi</p>' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-pdf-pages']).toBe('1');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('POST /v1/jobs requires auth and 202s a job', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'x-api-key': 'test-key' },
      payload: { html: '<p>x</p>' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().jobId).toMatch(/^job_/);
  });

  it('GET /metrics exposes prometheus text', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('http_requests_total');
  });

  it('POST /v1/convert URL with private host blocked', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/convert',
      headers: { 'x-api-key': 'test-key' },
      payload: { url: 'http://127.0.0.1/' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ssrf_blocked');
  });
});
