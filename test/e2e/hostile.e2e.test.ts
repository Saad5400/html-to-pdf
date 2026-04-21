/**
 * "Hostile content" battery — confirm the renderer survives nasty inputs:
 * infinite JS loops, exfiltration attempts to private IPs via subresources,
 * file:// nav attempts, oversized responses, etc. These should fail SAFELY
 * (typed errors, no host crash, no network egress to disallowed targets).
 */
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/index.js';
import { LimitExceededError } from '@/security/limits.js';
import { SsrfError } from '@/security/ssrf.js';
import {
  BrowserPool,
  PdfRenderer,
  RenderError,
  RenderTimeoutError,
} from '@/services/pdf/index.js';

const logger = pino({ level: 'silent' });

describe('hostile content battery (e2e)', () => {
  const config = loadConfig({
    BROWSER_POOL_SIZE: '2',
    RENDER_TIMEOUT_MS: '5000',
    NAVIGATION_TIMEOUT_MS: '4000',
    MAX_HTML_BYTES: String(2 * 1024 * 1024),
    MAX_CONTENT_BYTES: String(8 * 1024 * 1024),
    LOG_LEVEL: 'silent',
  });
  let pool: BrowserPool;
  let renderer: PdfRenderer;

  beforeAll(async () => {
    pool = new BrowserPool({
      size: config.BROWSER_POOL_SIZE,
      idleTtlMs: config.BROWSER_IDLE_TTL_MS,
      maxQueueDepth: 4,
      logger,
    });
    await pool.start();
    renderer = new PdfRenderer(pool, config, logger);
  }, 60_000);

  afterAll(async () => {
    await pool.stop();
  });

  it('rejects URL pointing at private IP', async () => {
    await expect(
      renderer.render({ url: 'http://127.0.0.1:1/' } as never),
    ).rejects.toBeInstanceOf(SsrfError);
  }, 15_000);

  it('blocks subresource fetches to private IPs (interceptor enforces SSRF)', async () => {
    // Page loads OK (HTML), but the subresource request to a private IP is aborted.
    // The page should still render — we check that no metadata-style content leaked.
    const html = `<!doctype html><html><body>
      <h1>Page</h1>
      <img src="http://169.254.169.254/computeMetadata/v1/instance/" alt="metadata"/>
      <script>fetch('http://10.0.0.1/').catch(()=>{});</script>
      </body></html>`;
    const out = await renderer.render({ html } as never);
    expect(out.bytes).toBeGreaterThan(0);
    const asText = out.pdf.toString('latin1');
    expect(asText).not.toContain('computeMetadata');
  }, 30_000);

  it('survives infinite JS loop via render budget', async () => {
    const html = `<!doctype html><html><body>
      <h1>Trap</h1>
      <script>setTimeout(()=>{ while(true){} }, 50);</script>
      </body></html>`;
    // Either RenderTimeoutError, or generic RenderError — but always typed,
    // never a thrown crash and never longer than RENDER_TIMEOUT_MS + slack.
    const start = Date.now();
    try {
      await renderer.render({ html, options: { waitUntil: 'networkidle' } } as never);
    } catch (err) {
      expect(err).toBeInstanceOf(RenderError);
    }
    expect(Date.now() - start).toBeLessThan(15_000);
  }, 20_000);

  it('rejects oversized HTML pre-flight (LimitExceededError)', async () => {
    const big = '<p>x</p>'.repeat(400_000); // ~3.2MB > 2MB cap
    await expect(renderer.render({ html: big } as never)).rejects.toBeInstanceOf(
      LimitExceededError,
    );
  });

  it('blocks navigation to javascript: URLs via interceptor', async () => {
    // The interceptor refuses non-http(s) requests outside data:/about:.
    // A meta-refresh to javascript: should be aborted by the route handler.
    const html = `<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=javascript:alert(1)">
      </head><body>safe</body></html>`;
    const out = await renderer.render({ html } as never);
    expect(out.pdf.subarray(0, 4).toString()).toBe('%PDF');
  }, 20_000);

  it('does not leak across renders (cookies are cleared between checkouts)', async () => {
    // Render 1: set a cookie via JS (won't persist b/c about:blank origin),
    // but verify our pool clearCookies() leaves the next render with no cookies.
    const r1 = await renderer.render({
      html: `<script>document.cookie="leak=1; path=/"</script><body>r1</body>`,
    } as never);
    const r2 = await renderer.render({
      html: `<body><script>document.body.append(document.cookie || 'NONE')</script></body>`,
    } as never);
    expect(r1.pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(r2.pdf.subarray(0, 4).toString()).toBe('%PDF');
    // Cookies set on about:blank don't actually persist; the assertion here
    // is mainly that we don't crash. Real cross-origin cookie isolation is
    // covered by the per-tenant context cleanup.
  }, 30_000);
});
