import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/index.js';
import filesRoute from '@/routes/files.js';
import { LocalStorage } from '@/services/storage/local.js';

describe('GET /v1/files/:key signed download', () => {
  let dir: string;
  let storage: LocalStorage;
  let app: ReturnType<typeof Fastify>;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'files-test-'));
    config = loadConfig({
      LOCAL_STORAGE_DIR: dir,
      SIGNED_URL_SECRET: 'this-is-a-test-secret-with-length',
    });
    storage = new LocalStorage(config);
    await storage.put('docs/hello.pdf', Buffer.from('%PDF-1.4 hello'), 'application/pdf');
    app = Fastify();
    await app.register(filesRoute, { storage, config });
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('serves a file with valid signature', async () => {
    const url = await storage.signedUrl('docs/hello.pdf', 60);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body).toContain('PDF-1.4 hello');
  });

  it('rejects expired signature', async () => {
    const url = await storage.signedUrl('docs/hello.pdf', -1);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(410);
  });

  it('rejects tampered signature', async () => {
    const url = await storage.signedUrl('docs/hello.pdf', 60);
    const tampered = url.replace(/sig=.*$/, 'sig=AAAAAAAAAAAA');
    const res = await app.inject({ method: 'GET', url: tampered });
    expect(res.statusCode).toBe(403);
  });

  it('rejects request missing signature', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/files/docs%2Fhello.pdf' });
    expect(res.statusCode).toBe(400);
  });
});
