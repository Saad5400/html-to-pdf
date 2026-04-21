import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/index.js';
import filesRoute from '@/routes/files.js';
import healthRoute from '@/routes/health.js';
import { ApiKeyService } from '@/services/auth/api-key.js';
import { BrowserPool } from '@/services/pdf/index.js';
import { LocalStorage } from '@/services/storage/local.js';
import { pino } from 'pino';

const logger = pino({ level: 'silent' });

describe('config guards', () => {
  it('throws when STORAGE_DRIVER=s3 without S3_BUCKET', () => {
    expect(() => loadConfig({ STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });
  it('throws in production with default SIGNED_URL_SECRET', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SIGNED_URL_SECRET/);
  });
  it('accepts production with explicit SIGNED_URL_SECRET', () => {
    const c = loadConfig({ NODE_ENV: 'production', SIGNED_URL_SECRET: 'real-strong-secret-of-len' });
    expect(c.NODE_ENV).toBe('production');
  });
});

describe('ApiKeyService.verify', () => {
  it('returns undefined for empty token', async () => {
    const svc = new ApiKeyService(loadConfig({ API_KEYS: 'k1,k2' }));
    expect(await svc.verify('')).toBeUndefined();
  });
  it('returns undefined for unknown key', async () => {
    const svc = new ApiKeyService(loadConfig({ API_KEYS: 'k1,k2' }));
    expect(await svc.verify('not-a-key')).toBeUndefined();
  });
  it('returns record for known key (cached on subsequent calls)', async () => {
    const svc = new ApiKeyService(loadConfig({ API_KEYS: 'good-key' }));
    const first = await svc.verify('good-key');
    expect(first?.id).toBe('bootstrap');
    const second = await svc.verify('good-key');
    expect(second).toBe(first);
  });
});

describe('LocalStorage put error path', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-extras-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('rejects keys with backslashes / unicode / path traversal', async () => {
    const config = loadConfig({ LOCAL_STORAGE_DIR: dir });
    const s = new LocalStorage(config);
    await expect(s.put('foo\\bar.pdf', Buffer.from('x'), 'application/pdf')).rejects.toThrow();
    await expect(s.put('foo/€.pdf', Buffer.from('x'), 'application/pdf')).rejects.toThrow();
    await expect(s.put('a/./b.pdf', Buffer.from('x'), 'application/pdf')).rejects.toThrow();
    await expect(s.put('a//b.pdf', Buffer.from('x'), 'application/pdf')).rejects.toThrow();
  });
});

describe('files route edge: STORAGE_DRIVER=s3 returns 404 for /v1/files', () => {
  it('local route 404s when driver is s3 (signed-URL not local-served)', async () => {
    const config = loadConfig({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'test',
      SIGNED_URL_SECRET: 'a-test-secret-of-sufficient-length',
    });
    const app = Fastify();
    // Pass a stub storage; route should refuse to serve regardless.
    await app.register(filesRoute, {
      storage: { get: async () => Buffer.from('x') } as never,
      config,
    });
    const res = await app.inject({ method: 'GET', url: '/v1/files/foo.pdf?exp=99999999&sig=AAAA' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 when underlying storage.get throws', async () => {
    const config = loadConfig({ SIGNED_URL_SECRET: 'a-test-secret-of-sufficient-length' });
    const storage = new LocalStorage(config);
    const url = await storage.signedUrl('does/not/exist.pdf', 60);
    const app = Fastify();
    await app.register(filesRoute, { storage, config });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('health route degraded states', () => {
  it('returns 503 when redis ping fails', async () => {
    const pool = new BrowserPool({ size: 1, idleTtlMs: 60_000, logger });
    const fakeRedis = { ping: async () => { throw new Error('no redis'); } } as never;
    const app = Fastify();
    await app.register(healthRoute, { pool, redis: fakeRedis });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { checks: { redis: { ok: boolean } } };
    expect(body.checks.redis.ok).toBe(false);
    await app.close();
    await pool.stop();
  });

  it('returns 503 when pool.start fails', async () => {
    const pool = new BrowserPool({ size: 1, idleTtlMs: 60_000, logger });
    // Force start to throw on the next call.
    (pool as unknown as { start: () => Promise<void> }).start = async () => {
      throw new Error('chromium failed to launch');
    };
    const app = Fastify();
    await app.register(healthRoute, { pool });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { checks: { browser: { ok: boolean } } };
    expect(body.checks.browser.ok).toBe(false);
    await app.close();
  });
});
