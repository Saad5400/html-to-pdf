import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/index.js';
import { BrowserPool, PdfRenderer } from '@/services/pdf/index.js';
import { fixtures } from '../fixtures/visual/index.js';
import {
  closeScreenshotBrowser,
  compareHtmlAndPdf,
  type CompareResult,
} from '../helpers/visual-compare.js';

/**
 * Pixel-level fidelity gate.
 *
 * Threshold rationale (calibrated via scripts/visual-calibrate.ts):
 *   - pixelmatch per-pixel sensitivity: 0.2 (ignores Chromium-vs-pdfjs AA noise)
 *   - assertion bar: 0.98 (worst measured = 0.9935; gives ~1.3pt margin)
 *
 * Each fixture is one A4 page on purpose. Multi-page page-break behavior is
 * covered by render.e2e.test.ts (page-count assertion). The HTML screenshot
 * here is a continuous DOM render; comparing it against PDF page N>1 would
 * mismeasure because Chromium's pagination doesn't always break at the same
 * Y-pixel as a scroll-clipped screenshot.
 */
const SIMILARITY_THRESHOLD = 0.98;
const PIXELMATCH_THRESHOLD = 0.2;
const DIFF_DIR = path.resolve('tmp/visual-diff');

const logger = pino({ level: 'silent' });

describe('Visual fidelity: HTML screenshot vs PDF raster (A4)', () => {
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    BROWSER_POOL_SIZE: '1',
    ALLOW_PRIVATE_NETWORKS: 'true',
  });
  let pool: BrowserPool;
  let renderer: PdfRenderer;

  beforeAll(async () => {
    await fs.rm(DIFF_DIR, { recursive: true, force: true });
    pool = new BrowserPool({
      size: config.BROWSER_POOL_SIZE,
      idleTtlMs: config.BROWSER_IDLE_TTL_MS,
      logger,
    });
    await pool.start();
    renderer = new PdfRenderer(pool, config, logger);
  }, 60_000);

  afterAll(async () => {
    await closeScreenshotBrowser();
    await pool.stop();
  });

  for (const fixture of fixtures) {
    it(
      `[${fixture.name}] PDF matches HTML at >= ${(SIMILARITY_THRESHOLD * 100).toFixed(0)}%`,
      async () => {
        const pdfRes = await renderer.render({
          html: fixture.html,
          options: {
            format: 'A4',
            // @page margin lives on body padding in the fixture so the HTML
            // screenshot (no @page support) and the PDF agree on geometry.
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            preferCSSPageSize: false,
            printBackground: true,
          } as never,
        });

        expect(pdfRes.pdf.subarray(0, 4).toString()).toBe('%PDF');

        const result: CompareResult = await compareHtmlAndPdf({
          fixture: fixture.name,
          html: fixture.html,
          pdfBuf: pdfRes.pdf,
          options: {
            pixelMatchThreshold: PIXELMATCH_THRESHOLD,
            diffDir: DIFF_DIR,
            // Save side-by-side PNGs only on failure; the diff is written
            // unconditionally so a passing run keeps a thin audit trail.
            saveArtifacts: false,
            pageLimit: 1,
          },
        });

        const sim = result.worstSimilarity;
        // Saving HTML/PDF artifacts on failure for forensic comparison.
        if (sim < SIMILARITY_THRESHOLD) {
          await compareHtmlAndPdf({
            fixture: `${fixture.name}-failure`,
            html: fixture.html,
            pdfBuf: pdfRes.pdf,
            options: {
              pixelMatchThreshold: PIXELMATCH_THRESHOLD,
              diffDir: DIFF_DIR,
              saveArtifacts: true,
              pageLimit: 1,
            },
          });
        }

        expect(
          sim,
          `similarity ${sim.toFixed(4)} < ${SIMILARITY_THRESHOLD} ` +
            `for "${fixture.name}"; diffs in ${DIFF_DIR}/`,
        ).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
      },
      90_000,
    );
  }

  it('renders a multi-page document with the expected page count', async () => {
    // Page-break behavior is validated here at the structural level (page
    // count), separate from the pixel-fidelity tests which only compare
    // single-page fixtures.
    const html = `
      <!doctype html><html><head><style>
        @page { size: A4; margin: 0; }
        body { margin: 0; padding: 18mm 16mm; font-family: sans-serif; }
        .page { page-break-after: always; min-height: 250mm; }
        .page:last-child { page-break-after: auto; }
      </style></head><body>
        <section class="page"><h1>Page 1</h1></section>
        <section class="page"><h1>Page 2</h1></section>
        <section class="page"><h1>Page 3</h1></section>
      </body></html>`;

    const out = await renderer.render({
      html,
      options: {
        format: 'A4',
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        printBackground: true,
      } as never,
    });
    expect(out.pages).toBe(3);
  }, 60_000);
});
