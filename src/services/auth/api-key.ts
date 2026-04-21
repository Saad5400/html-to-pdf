import argon2 from 'argon2';
import type { Config } from '@/config/index.js';
import type { ApiKeyRecord } from '@/types/index.js';

interface CacheEntry {
  rec: ApiKeyRecord;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 1024;

export class ApiKeyService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly bootstrapKeys: string[];

  constructor(config: Config) {
    this.bootstrapKeys = config.API_KEYS;
  }

  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, { type: argon2.argon2id });
  }

  async verify(plaintext: string): Promise<ApiKeyRecord | undefined> {
    if (!plaintext) return undefined;
    const cached = this.cache.get(plaintext);
    if (cached && cached.expiresAt > Date.now()) return cached.rec;
    if (cached) this.cache.delete(plaintext);
    for (const k of this.bootstrapKeys) {
      if (constantEq(plaintext, k)) {
        const rec: ApiKeyRecord = { id: 'bootstrap', label: 'env', hash: '' };
        this.put(plaintext, rec);
        return rec;
      }
    }
    return undefined;
  }

  private put(key: string, rec: ApiKeyRecord): void {
    if (this.cache.size >= CACHE_MAX) {
      // Evict oldest entry — simple bounded cache.
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, { rec, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

import { createHash, timingSafeEqual } from 'node:crypto';

function constantEq(a: string, b: string): boolean {
  // Pad to a fixed-length sha256 digest to avoid leaking length via early-return.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
