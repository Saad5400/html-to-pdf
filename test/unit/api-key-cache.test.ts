import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@/config/index.js';
import { ApiKeyService } from '@/services/auth/api-key.js';

describe('ApiKeyService bounded TTL cache', () => {
  it('expires cached entries after TTL', async () => {
    const svc = new ApiKeyService(loadConfig({ API_KEYS: 'k1' }));
    const before = await svc.verify('k1');
    expect(before?.id).toBe('bootstrap');
    // Fast-forward >5 minutes (the cache TTL).
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const after = await svc.verify('k1');
    expect(after?.id).toBe('bootstrap');
    expect(after).not.toBe(before); // re-verified, fresh record
    vi.useRealTimers();
  });

  it('serves from cache within TTL (same record reference)', async () => {
    const svc = new ApiKeyService(loadConfig({ API_KEYS: 'k1' }));
    const a = await svc.verify('k1');
    const b = await svc.verify('k1');
    expect(a).toBe(b);
  });
});
