import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '@/config/index.js';
import { hmacSign } from '@/lib/hash.js';
import type { StorageAdapter } from '@/types/index.js';

const KEY_SEGMENT_RE = /^[A-Za-z0-9_\-.]+$/;

function assertValidKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`invalid storage key: ${String(key)}`);
  }
  if (key.startsWith('/')) throw new Error(`invalid storage key: ${key}`);
  const segments = key.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`invalid storage key: ${key}`);
    }
    if (!KEY_SEGMENT_RE.test(seg)) {
      throw new Error(`invalid storage key: ${key}`);
    }
  }
}

function resolveSafe(baseDir: string, key: string): string {
  assertValidKey(key);
  const resolved = path.resolve(baseDir, key);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`path traversal blocked: ${key}`);
  }
  return resolved;
}

export class LocalStorage implements StorageAdapter {
  private readonly baseDir: string;
  private readonly secret: string;
  private readonly publicBaseUrl: string | undefined;

  constructor(config: Config) {
    this.baseDir = path.resolve(config.LOCAL_STORAGE_DIR);
    this.secret = config.SIGNED_URL_SECRET;
    this.publicBaseUrl = config.PUBLIC_BASE_URL;
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<void> {
    const target = resolveSafe(this.baseDir, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  async get(key: string): Promise<Buffer> {
    const target = resolveSafe(this.baseDir, key);
    return fs.readFile(target);
  }

  async delete(key: string): Promise<void> {
    const target = resolveSafe(this.baseDir, key);
    await fs.rm(target, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const target = resolveSafe(this.baseDir, key);
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    assertValidKey(key);
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = hmacSign(this.secret, `${key}:${exp}`);
    const encoded = encodeURIComponent(key);
    const pathPart = `/v1/files/${encoded}?exp=${exp}&sig=${sig}`;
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}${pathPart}`;
    }
    return pathPart;
  }
}
