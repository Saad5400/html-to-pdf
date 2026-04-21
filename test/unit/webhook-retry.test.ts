import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverWebhook } from '@/services/queue/webhook.js';

const logger = pino({ level: 'silent' });
const policy = { allowedHosts: [], blockedHosts: [], allowPrivateNetworks: true };

describe('deliverWebhook retry behavior', () => {
  const originalFetch = globalThis.fetch;
  let attempts: number;

  beforeEach(() => {
    attempts = 0;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('retries on 5xx with exponential backoff and eventually succeeds', async () => {
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      if (attempts < 3) return new Response(null, { status: 503 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await deliverWebhook({
      url: 'http://example.com/hook',
      secret: 'secret-value-of-sufficient-length',
      payload: { jobId: 'x' },
      ssrfPolicy: policy,
      logger,
      attempts: 5,
      timeoutMs: 100,
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('gives up on non-retriable 4xx (e.g., 404) without retrying', async () => {
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const ok = await deliverWebhook({
      url: 'http://example.com/hook',
      secret: 'secret-value-of-sufficient-length',
      payload: {},
      ssrfPolicy: policy,
      logger,
      attempts: 5,
      timeoutMs: 100,
    });
    expect(ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it('retries on 408/429', async () => {
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      if (attempts === 1) return new Response(null, { status: 429 });
      if (attempts === 2) return new Response(null, { status: 408 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await deliverWebhook({
      url: 'http://example.com/hook',
      secret: 'secret-value-of-sufficient-length',
      payload: {},
      ssrfPolicy: policy,
      logger,
      attempts: 4,
      timeoutMs: 100,
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('gives up after `attempts` exhausted on persistent 5xx', async () => {
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;

    const ok = await deliverWebhook({
      url: 'http://example.com/hook',
      secret: 'secret-value-of-sufficient-length',
      payload: {},
      ssrfPolicy: policy,
      logger,
      attempts: 2,
      timeoutMs: 100,
    });
    expect(ok).toBe(false);
    expect(attempts).toBe(2);
  });

  it('retries on network errors (fetch throws)', async () => {
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      if (attempts < 2) throw new Error('ECONNRESET');
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await deliverWebhook({
      url: 'http://example.com/hook',
      secret: 'secret-value-of-sufficient-length',
      payload: {},
      ssrfPolicy: policy,
      logger,
      attempts: 3,
      timeoutMs: 100,
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(2);
  });
});
