import { hmacSign } from '@/lib/hash.js';
import { assertSafeUrl, type SsrfPolicy } from '@/security/ssrf.js';
import type { Logger } from 'pino';

export interface WebhookOptions {
  url: string;
  secret: string;
  payload: unknown;
  ssrfPolicy: SsrfPolicy;
  logger: Logger;
  timeoutMs?: number;
  attempts?: number;
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_ATTEMPTS = 4;

/**
 * Deliver a signed webhook with bounded retries and SSRF validation. The
 * receiver verifies via HMAC-SHA256 over `${timestamp}.${body}`, comparing
 * against the `X-Signature` header.
 */
export async function deliverWebhook(opts: WebhookOptions): Promise<boolean> {
  await assertSafeUrl(opts.url, opts.ssrfPolicy);
  const body = JSON.stringify(opts.payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = `t=${ts},v1=${hmacSign(opts.secret, `${ts}.${body}`)}`;
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': sig,
          'x-webhook-timestamp': ts,
          'x-webhook-attempt': String(attempt),
          'user-agent': 'html-to-pdf-webhook/1',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        opts.logger.warn(
          { url: opts.url, status: res.status, attempt },
          'webhook gave non-retriable status; aborting',
        );
        return false;
      }
      opts.logger.warn({ url: opts.url, status: res.status, attempt }, 'webhook non-2xx');
    } catch (err) {
      opts.logger.warn(
        { url: opts.url, err: (err as Error).message, attempt },
        'webhook delivery error',
      );
    }
    if (attempt < attempts) {
      const delay = Math.min(30_000, 500 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return false;
}
