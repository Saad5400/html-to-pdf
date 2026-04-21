/**
 * Minimal-mode boot test: server starts with NO Redis, NO storage, NO queue,
 * NO auth required. POST /v1/convert returns a PDF; /v1/jobs and /v1/files
 * are absent (404). Real Chromium — slow, runs as e2e.
 *
 * Lives under test/integration/ but uses real Chromium so we tag it under e2e.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppHandle } from '@/app.js';
import { loadConfig, resetConfigForTests } from '@/config/index.js';

describe('minimal mode (no Redis, no storage, no auth)', () => {
  let app: AppHandle;

  beforeAll(async () => {
    resetConfigForTests();
    const config = loadConfig({
      MODE: 'minimal',
      LOG_LEVEL: 'silent',
      BROWSER_POOL_SIZE: '1',
    });
    expect(config.features).toEqual({
      queue: false,
      storage: false,
      rateLimit: false,
      auth: false,
    });
    app = await buildApp(config);
    await app.server.ready();
  }, 60_000);

  afterAll(async () => {
    await app.shutdown();
    resetConfigForTests();
  });

  it('POST /v1/convert returns a real PDF without any auth header', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/convert',
      headers: { 'content-type': 'application/json' },
      payload: { html: '<h1>Minimal mode</h1>' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  }, 60_000);

  it('GET /v1/jobs/* is 404 (queue disabled)', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/v1/jobs/job_aaaaaaaaaaaaaaaaaaaaa',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /v1/jobs is 404 (queue disabled)', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'content-type': 'application/json' },
      payload: { html: '<p>x</p>' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/files/* is 404 (storage disabled)', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/v1/files/whatever?exp=1&sig=x',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /health/ready is OK (no redis check expected)', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { checks: Record<string, unknown> };
    expect(body.checks).not.toHaveProperty('redis');
  });

  it('GET /playground returns the HTML page', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/playground' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('html-to-pdf playground');
  });
});
