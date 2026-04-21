import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hmacSign, hmacVerify } from '@/lib/hash.js';
import { deliverWebhook } from '@/services/queue/webhook.js';

const logger = pino({ level: 'silent' });

describe('deliverWebhook', () => {
  const policy = { allowedHosts: [], blockedHosts: [], allowPrivateNetworks: true };
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];

  beforeAll(() => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('signs payload with HMAC-SHA256 in t=…,v1=… format', async () => {
    calls.length = 0;
    const ok = await deliverWebhook({
      url: 'http://example.com/hook',
      secret: 'super-secret-key-of-sufficient-length',
      payload: { jobId: 'job_abc', status: 'completed' },
      ssrfPolicy: { ...policy, allowPrivateNetworks: false },
      logger,
      attempts: 1,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    const sig = headers['x-signature']!;
    const ts = headers['x-webhook-timestamp']!;
    expect(sig).toMatch(/^t=\d+,v1=[A-Za-z0-9_-]+$/);
    const body = calls[0]!.init.body as string;
    const expected = hmacSign('super-secret-key-of-sufficient-length', `${ts}.${body}`);
    expect(sig.endsWith(`v1=${expected}`)).toBe(true);
    expect(hmacVerify('super-secret-key-of-sufficient-length', `${ts}.${body}`, expected)).toBe(
      true,
    );
  });

  it('rejects webhook to private host via SSRF guard', async () => {
    await expect(
      deliverWebhook({
        url: 'http://127.0.0.1/hook',
        secret: 'super-secret-key-of-sufficient-length',
        payload: {},
        ssrfPolicy: { allowedHosts: [], blockedHosts: [], allowPrivateNetworks: false },
        logger,
        attempts: 1,
      }),
    ).rejects.toThrow(/private/);
  });
});
