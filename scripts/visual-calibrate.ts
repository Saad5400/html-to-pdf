/**
 * Visual fidelity calibration.
 *
 * Runs the visual-compare helper across every fixture in
 * test/fixtures/visual at multiple pixelmatch sensitivity settings and
 * prints a table of similarities. Used to pick the e2e threshold honestly
 * — i.e. based on measurements, not a guess.
 *
 * Run: npx tsx scripts/visual-calibrate.ts
 * Artifacts: tmp/visual-calibrate/ (diff + html + pdf PNGs)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pino } from 'pino';
import { loadConfig } from '../src/config/index.js';
import { BrowserPool, PdfRenderer } from '../src/services/pdf/index.js';
import { fixtures } from '../test/fixtures/visual/index.js';
import { closeScreenshotBrowser, compareHtmlAndPdf } from '../test/helpers/visual-compare.js';

const logger = pino({ level: 'silent' });
const outDir = path.resolve('tmp/visual-calibrate');

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

  const thresholds = [0.05, 0.1, 0.15, 0.2, 0.3];
  const report: Array<Record<string, unknown>> = [];

  try {
    for (const fixture of fixtures) {
      // eslint-disable-next-line no-console
      console.log(`\n=== ${fixture.name} ===`);
      const pdfRes = await renderer.render({
        html: fixture.html,
        options: {
          format: 'A4',
          // Margins live inside the body via padding in the fixture CSS so
          // the screenshot (no @page support) and PDF agree on geometry.
          margin: { top: '0', right: '0', bottom: '0', left: '0' },
          preferCSSPageSize: false,
          printBackground: true,
        } as never,
      });

      // Save the PDF for human inspection.
      const pdfPath = path.join(outDir, `${fixture.name}.pdf`);
      await fs.writeFile(pdfPath, pdfRes.pdf);

      const row: Record<string, unknown> = { fixture: fixture.name, pages: pdfRes.pages };

      for (const threshold of thresholds) {
        const result = await compareHtmlAndPdf({
          fixture: `${fixture.name}-t${threshold}`,
          html: fixture.html,
          pdfBuf: pdfRes.pdf,
          options: {
            pixelMatchThreshold: threshold,
            diffDir: path.join(outDir, `t${String(threshold).replace('.', '_')}`),
            saveArtifacts: threshold === 0.2,
          },
        });
        row[`worst@${threshold}`] = result.worstSimilarity.toFixed(4);
        row[`mean@${threshold}`] = result.meanSimilarity.toFixed(4);
        // eslint-disable-next-line no-console
        console.log(
          `  threshold=${threshold} pages=${result.pages.length} ` +
            `worst=${result.worstSimilarity.toFixed(4)} mean=${result.meanSimilarity.toFixed(4)}`,
        );
        for (const p of result.pages) {
          // eslint-disable-next-line no-console
          console.log(
            `    page ${p.pageIndex + 1}: sim=${p.similarity.toFixed(4)} ` +
              `diffPx=${p.diffPixels}/${p.totalPixels}`,
          );
        }
      }
      report.push(row);
    }
  } finally {
    await closeScreenshotBrowser();
    await pool.stop();
  }

  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nArtifacts: ${outDir}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
