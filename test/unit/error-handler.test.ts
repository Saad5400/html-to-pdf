import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import errorHandler from '@/plugins/error-handler.js';
import { LimitExceededError } from '@/security/limits.js';
import { SsrfError } from '@/security/ssrf.js';
import { RenderError, RenderTimeoutError } from '@/services/pdf/index.js';
import { PoolBackpressureError, PoolStoppedError } from '@/services/pdf/browser-pool.js';

interface ErrSpec {
  path: string;
  err: Error;
  expectedStatus: number;
  expectedError: string;
  expectedHeader?: { name: string; value: string };
}

const cases: ErrSpec[] = [
  { path: '/ssrf', err: new SsrfError('private'), expectedStatus: 400, expectedError: 'ssrf_blocked' },
  { path: '/limit', err: new LimitExceededError('too big'), expectedStatus: 413, expectedError: 'limit_exceeded' },
  { path: '/back', err: new PoolBackpressureError(), expectedStatus: 503, expectedError: 'backpressure', expectedHeader: { name: 'retry-after', value: '5' } },
  { path: '/stopped', err: new PoolStoppedError(), expectedStatus: 503, expectedError: 'shutting_down' },
  { path: '/timeout', err: new RenderTimeoutError(), expectedStatus: 504, expectedError: 'render_timeout' },
  { path: '/render', err: new RenderError('boom'), expectedStatus: 502, expectedError: 'render_failed' },
];

describe('error-handler plugin maps each typed error correctly', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    // Mimic the metrics decoration used by the error-handler.
    app.decorate('metrics', {
      // Accept any label, no-op increment.
      renderErrors: { labels: () => ({ inc: () => undefined }) },
    } as never);
    await app.register(errorHandler);
    for (const c of cases) {
      app.get(c.path, async () => {
        throw c.err;
      });
    }
    app.get('/http', async () => {
      const e = new Error('teapot') as Error & { statusCode: number };
      e.statusCode = 418;
      e.name = 'TeapotError';
      throw e;
    });
    app.get('/raw', async () => {
      throw new Error('mystery');
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  for (const c of cases) {
    it(`maps ${c.err.constructor.name} → ${c.expectedStatus}`, async () => {
      const res = await app.inject({ method: 'GET', url: c.path });
      expect(res.statusCode).toBe(c.expectedStatus);
      expect(res.json().error).toBe(c.expectedError);
      if (c.expectedHeader) {
        expect(res.headers[c.expectedHeader.name]).toBe(c.expectedHeader.value);
      }
    });
  }

  it('passes through plain HTTP-coded errors', async () => {
    const res = await app.inject({ method: 'GET', url: '/http' });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toMatchObject({ error: 'TeapotError', message: 'teapot' });
  });

  it('falls back to 500 for un-typed errors', async () => {
    const res = await app.inject({ method: 'GET', url: '/raw' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('internal_error');
  });

  it('returns 404 for unmounted paths', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
