/**
 * Dump visual fixtures + side-by-side renders for visual inspection.
 *
 * Writes:
 *   tmp/visual-inspect/<fixture>.html      — the fixture, openable in a browser
 *   tmp/visual-inspect/<fixture>.pdf       — produced by PdfRenderer
 *   tmp/visual-inspect/<fixture>-html.png  — HTML screenshot at A4 (1588x2246)
 *   tmp/visual-inspect/<fixture>-pdf.png   — PDF page 1 rasterized at A4
 *   tmp/visual-inspect/<fixture>-diff.png  — pixel diff
 *   tmp/visual-inspect/index.html          — a viewer page linking everything
 *
 * Run: npx tsx scripts/visual-dump.ts
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pino } from 'pino';
import { loadConfig } from '../src/config/index.js';
import { BrowserPool, PdfRenderer } from '../src/services/pdf/index.js';
import { fixtures } from '../test/fixtures/visual/index.js';
import { closeScreenshotBrowser, compareHtmlAndPdf } from '../test/helpers/visual-compare.js';

const outDir = path.resolve('tmp/visual-inspect');
const logger = pino({ level: 'silent' });

async function main(): Promise<void> {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const config = loadConfig({
    LOG_LEVEL: 'silent',
    BROWSER_POOL_SIZE: '1',
    ALLOW_PRIVATE_NETWORKS: 'true',
  });
  const pool = new BrowserPool({
    size: config.BROWSER_POOL_SIZE,
    idleTtlMs: config.BROWSER_IDLE_TTL_MS,
    logger,
  });
  await pool.start();
  const renderer = new PdfRenderer(pool, config, logger);

  const rows: Array<{ name: string; similarity: number }> = [];

  try {
    for (const fixture of fixtures) {
      await fs.writeFile(path.join(outDir, `${fixture.name}.html`), fixture.html);

      const pdfRes = await renderer.render({
        html: fixture.html,
        options: {
          format: 'A4',
          margin: { top: '0', right: '0', bottom: '0', left: '0' },
          preferCSSPageSize: false,
          printBackground: true,
        } as never,
      });
      await fs.writeFile(path.join(outDir, `${fixture.name}.pdf`), pdfRes.pdf);

      const result = await compareHtmlAndPdf({
        fixture: fixture.name,
        html: fixture.html,
        pdfBuf: pdfRes.pdf,
        options: {
          pixelMatchThreshold: 0.2,
          diffDir: outDir,
          saveArtifacts: true,
          pageLimit: 1,
        },
      });

      rows.push({ name: fixture.name, similarity: result.worstSimilarity });
      // eslint-disable-next-line no-console
      console.log(`${fixture.name}: similarity = ${result.worstSimilarity.toFixed(4)}`);
    }
  } finally {
    await closeScreenshotBrowser();
    await pool.stop();
  }

  // Tiny viewer page so a human can flip through results in one tab.
  const viewer = `<!doctype html>
<html><head><meta charset="utf-8"><title>Visual fidelity inspector</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
  h1 { margin: 0 0 16px; font-weight: 600; }
  .fixture { margin-bottom: 40px; padding: 16px; background: #1e293b; border-radius: 8px; }
  .meta { display: flex; gap: 12px; align-items: baseline; margin-bottom: 12px; }
  .name { font-size: 20px; font-weight: 600; }
  .sim  { font-family: monospace; padding: 2px 8px; border-radius: 999px; background: #16a34a; color: #fff; }
  .sim.warn { background: #d97706; }
  .sim.bad  { background: #dc2626; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .grid figure { margin: 0; }
  .grid figcaption { font-size: 12px; color: #94a3b8; margin-bottom: 4px; }
  .grid img { width: 100%; border: 1px solid #334155; background: #fff; }
  .links a { color: #93c5fd; margin-right: 12px; font-size: 13px; }
</style></head>
<body>
  <h1>HTML ↔ PDF visual fidelity</h1>
  <p style="color:#94a3b8">Open each fixture's .html file directly in your browser, or compare the three rendered images below. Threshold for the e2e gate is 0.98.</p>
  ${rows
    .map(({ name, similarity }) => {
      const cls = similarity >= 0.98 ? '' : similarity >= 0.95 ? 'warn' : 'bad';
      return `<section class="fixture">
    <div class="meta">
      <span class="name">${name}</span>
      <span class="sim ${cls}">similarity ${similarity.toFixed(4)}</span>
    </div>
    <div class="links">
      <a href="${name}.html" target="_blank">open HTML</a>
      <a href="${name}.pdf" target="_blank">open PDF</a>
    </div>
    <div class="grid">
      <figure><figcaption>HTML screenshot</figcaption><img src="${name}-page1-html.png" alt=""/></figure>
      <figure><figcaption>PDF rasterized</figcaption><img src="${name}-page1-pdf.png" alt=""/></figure>
      <figure><figcaption>Diff (red = mismatch)</figcaption><img src="${name}-page1-diff.png" alt=""/></figure>
    </div>
  </section>`;
    })
    .join('\n')}
</body></html>`;

  await fs.writeFile(path.join(outDir, 'index.html'), viewer);

  // eslint-disable-next-line no-console
  console.log(`\nArtifacts: ${outDir}`);
  // eslint-disable-next-line no-console
  console.log(`Open: ${path.join(outDir, 'index.html')}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
