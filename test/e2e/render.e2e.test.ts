import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/index.js';
import { BrowserPool, countPdfPages, PdfRenderer } from '@/services/pdf/index.js';

const logger = pino({ level: 'silent' });

describe('PdfRenderer (e2e — requires Chromium)', () => {
  const config = loadConfig({ ALLOW_PRIVATE_NETWORKS: 'true', BROWSER_POOL_SIZE: '1' });
  let pool: BrowserPool;
  let renderer: PdfRenderer;

  beforeAll(async () => {
    pool = new BrowserPool({
      size: config.BROWSER_POOL_SIZE,
      idleTtlMs: config.BROWSER_IDLE_TTL_MS,
      logger,
    });
    await pool.start();
    renderer = new PdfRenderer(pool, config, logger);
  });

  afterAll(async () => {
    await pool.stop();
  });

  it('renders simple HTML to a valid PDF', async () => {
    const out = await renderer.render({
      html: '<!doctype html><html><body><h1>Hello</h1><p>World</p></body></html>',
    });
    expect(out.bytes).toBeGreaterThan(500);
    expect(out.pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(out.pages).toBeGreaterThanOrEqual(1);
    expect(countPdfPages(out.pdf)).toBe(out.pages);
  }, 60_000);

  it('honors page break CSS', async () => {
    const html = `
      <!doctype html><html><head><style>
        .pb { page-break-after: always; }
      </style></head><body>
      <div class="pb">A</div><div class="pb">B</div><div>C</div>
      </body></html>`;
    const out = await renderer.render({ html, options: { format: 'A4' } as never });
    expect(out.pages).toBeGreaterThanOrEqual(3);
  }, 60_000);
});
