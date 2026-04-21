import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/index.js';
import { LocalStorage } from '@/services/storage/local.js';

describe('LocalStorage', () => {
  let dir: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
    const config = loadConfig({
      LOCAL_STORAGE_DIR: dir,
      SIGNED_URL_SECRET: 'test-secret-of-sufficient-length-please',
    });
    storage = new LocalStorage(config);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('puts, gets, exists, deletes', async () => {
    await storage.put('a/b/c.pdf', Buffer.from('hello'), 'application/pdf');
    expect(await storage.exists('a/b/c.pdf')).toBe(true);
    expect((await storage.get('a/b/c.pdf')).toString()).toBe('hello');
    await storage.delete('a/b/c.pdf');
    expect(await storage.exists('a/b/c.pdf')).toBe(false);
  });

  it('rejects path traversal', async () => {
    await expect(storage.put('../escape.pdf', Buffer.from('x'), 'application/pdf')).rejects.toThrow();
    await expect(storage.put('//absolute', Buffer.from('x'), 'application/pdf')).rejects.toThrow();
  });

  it('signs URLs deterministically', async () => {
    const url = await storage.signedUrl('a/b/c.pdf', 60);
    expect(url).toMatch(/sig=/);
    expect(url).toMatch(/exp=/);
  });
});
