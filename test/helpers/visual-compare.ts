/**
 * Visual-fidelity helper: renders the same HTML through Chromium (page
 * screenshot) and through PdfRenderer (PDF -> pdfjs canvas raster), then
 * pixel-compares the two images per A4 page.
 *
 * Intentional choices:
 *  - DPI matched by sizing both rasters to the same target width (default
 *    1588px = A4 at 192 DPI / DPR=2 over a 794px CSS viewport). Avoids
 *    DPI-mismatch noise that would otherwise dominate the diff.
 *  - pdfjs runs with `disableFontFace: true` and `useSystemFonts: true`, so it
 *    rasterizes using the same DejaVu/Liberation system faces Chromium picks.
 *    Without this, pdfjs falls back to its bundled Helvetica/Times outlines
 *    and the diff explodes on every glyph.
 *  - pixelmatch threshold defaults to 0.2 — strict enough to catch layout
 *    drift, loose enough to ignore subpixel AA differences between Chromium's
 *    Skia raster and pdfjs's canvas raster.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type * as Pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// pdfjs assumes a browser environment. The legacy ESM build still wants
// DOMMatrix / Path2D / ImageData on `globalThis`. Install once.
const g = globalThis as unknown as Record<string, unknown>;
if (!g.DOMMatrix) g.DOMMatrix = DOMMatrix;
if (!g.ImageData) g.ImageData = ImageData;
if (!g.Path2D) g.Path2D = Path2D;

type PdfjsModule = typeof Pdfjs;
let pdfjsModule: PdfjsModule | undefined;
async function getPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsModule) {
    pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // pdfjs in Node insists on a workerSrc even when running on the main
    // thread. Point it at the bundled worker module — the legacy build will
    // import it via dynamic import rather than spawn a real Worker.
    const workerUrl = new URL(
      '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      import.meta.url,
    ).href;
    pdfjsModule.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjsModule;
}

// A4 in CSS pixels at 96 DPI.
export const A4_CSS_WIDTH = 794;
export const A4_CSS_HEIGHT = 1123;
// Render at 2x device pixel ratio for sharper text comparison.
export const DEVICE_SCALE = 2;
const TARGET_WIDTH_PX = A4_CSS_WIDTH * DEVICE_SCALE; // 1588

export interface PageCompareResult {
  pageIndex: number;
  width: number;
  height: number;
  diffPixels: number;
  totalPixels: number;
  similarity: number;
  diffPath?: string;
}

export interface CompareResult {
  fixture: string;
  pages: PageCompareResult[];
  worstSimilarity: number;
  meanSimilarity: number;
  pdfPath?: string;
  htmlShotPath?: string;
}

export interface CompareOptions {
  /**
   * Per-pixel sensitivity passed to pixelmatch (0 = exact, 1 = anything goes).
   * 0.2 is calibrated to ignore Chromium-vs-pdfjs AA noise while still
   * catching layout regressions.
   */
  pixelMatchThreshold?: number;
  /** Directory to write diff PNGs to (only written for pages below cutoff). */
  diffDir?: string;
  /** Save html screenshot + pdf page PNGs alongside diffs. */
  saveArtifacts?: boolean;
  /** Override which PDF pages to compare. Default: all. */
  pageLimit?: number;
}

/**
 * Dedicated browser used only for HTML screenshots — created with the same
 * deviceScaleFactor as our PDF raster target so the two images line up
 * pixel-for-pixel. We keep it separate from the production BrowserPool because
 * we need a non-default DPR; the pool's contexts are tuned for PDF output.
 */
let screenshotBrowser: Browser | undefined;
let screenshotContext: BrowserContext | undefined;

async function getScreenshotContext(): Promise<BrowserContext> {
  if (screenshotContext) return screenshotContext;
  screenshotBrowser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  screenshotContext = await screenshotBrowser.newContext({
    viewport: { width: A4_CSS_WIDTH, height: A4_CSS_HEIGHT },
    deviceScaleFactor: DEVICE_SCALE,
    acceptDownloads: false,
    javaScriptEnabled: true,
  });
  return screenshotContext;
}

export async function closeScreenshotBrowser(): Promise<void> {
  if (screenshotContext) {
    await screenshotContext.close().catch(() => {});
    screenshotContext = undefined;
  }
  if (screenshotBrowser) {
    await screenshotBrowser.close().catch(() => {});
    screenshotBrowser = undefined;
  }
}

async function takeHtmlScreenshot(html: string, pageIndex: number): Promise<PNG> {
  const ctx = await getScreenshotContext();
  const page = await ctx.newPage();
  try {
    await page.emulateMedia({ media: 'print', colorScheme: 'light' });
    await page.setContent(html, { waitUntil: 'networkidle' });
    // Match the renderer's font-readiness wait so glyphs are settled.
    await page
      .evaluate(`('fonts' in document) ? document.fonts.ready.then(() => undefined) : undefined`)
      .catch(() => undefined);

    // Scroll to the page's vertical slot, then clip exactly one A4 viewport.
    // `window` here runs in Chromium, not Node — cast away the Node typing.
    await page.evaluate(
      (y: number) => (globalThis as unknown as { scrollTo: (x: number, y: number) => void })
        .scrollTo(0, y),
      pageIndex * A4_CSS_HEIGHT,
    );
    const buf = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: A4_CSS_WIDTH, height: A4_CSS_HEIGHT },
      omitBackground: false,
      scale: 'device',
    });
    return PNG.sync.read(buf);
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => {});
  }
}

async function rasterizePdfPage(pdfBuf: Buffer, pageIndex: number): Promise<PNG> {
  const pdfjs = await getPdfjs();
  // pdfjs accepts a Uint8Array; cloning to avoid transferring our caller's buffer.
  const data = new Uint8Array(pdfBuf);
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    if (pageIndex >= doc.numPages) {
      throw new Error(`PDF has ${doc.numPages} pages; requested page index ${pageIndex}`);
    }
    const pdfPage = await doc.getPage(pageIndex + 1);
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const scale = TARGET_WIDTH_PX / baseViewport.width;
    const viewport = pdfPage.getViewport({ scale });
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // pdfjs draws transparent where there's no content. Fill white so the
    // diff against an HTML screenshot (which has a white body) is fair.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    // pdfjs's TS types disagree with @napi-rs/canvas's context, but the
    // runtime API matches. Cast through `unknown` to silence the structural
    // mismatch (and avoid pulling DOM lib into tsconfig just for this).
    await pdfPage.render({
      canvas: null,
      canvasContext: ctx,
      viewport,
    } as unknown as Parameters<typeof pdfPage.render>[0]).promise;
    pdfPage.cleanup();
    const pngBuffer = canvas.toBuffer('image/png');
    return PNG.sync.read(pngBuffer);
  } finally {
    await doc.cleanup();
    await doc.destroy();
  }
}

function cropToCommon(a: PNG, b: PNG): { a: PNG; b: PNG; width: number; height: number } {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  if (a.width === width && a.height === height && b.width === width && b.height === height) {
    return { a, b, width, height };
  }
  const crop = (src: PNG): PNG => {
    if (src.width === width && src.height === height) return src;
    const out = new PNG({ width, height });
    PNG.bitblt(src, out, 0, 0, width, height, 0, 0);
    return out;
  };
  return { a: crop(a), b: crop(b), width, height };
}

export async function compareHtmlAndPdf(args: {
  fixture: string;
  html: string;
  pdfBuf: Buffer;
  options?: CompareOptions;
}): Promise<CompareResult> {
  const opts: Required<CompareOptions> = {
    pixelMatchThreshold: 0.2,
    diffDir: '',
    saveArtifacts: false,
    pageLimit: Number.POSITIVE_INFINITY,
    ...args.options,
  };

  const pdfjs = await getPdfjs();
  const probe = await pdfjs.getDocument({ data: new Uint8Array(args.pdfBuf), verbosity: 0 })
    .promise;
  const pageCount = Math.min(probe.numPages, opts.pageLimit);
  await probe.cleanup();
  await probe.destroy();

  const pages: PageCompareResult[] = [];
  try {
    for (let i = 0; i < pageCount; i += 1) {
      const [htmlPng, pdfPng] = await Promise.all([
        takeHtmlScreenshot(args.html, i),
        rasterizePdfPage(args.pdfBuf, i),
      ]);
      const { a, b, width, height } = cropToCommon(htmlPng, pdfPng);
      const diff = new PNG({ width, height });
      const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
        threshold: opts.pixelMatchThreshold,
        includeAA: false,
        alpha: 0.1,
      });
      const totalPixels = width * height;
      const similarity = 1 - diffPixels / totalPixels;

      let diffPath: string | undefined;
      if (opts.diffDir) {
        await fs.mkdir(opts.diffDir, { recursive: true });
        const prefix = `${args.fixture}-page${i + 1}`;
        diffPath = path.join(opts.diffDir, `${prefix}-diff.png`);
        await fs.writeFile(diffPath, PNG.sync.write(diff));
        if (opts.saveArtifacts) {
          await fs.writeFile(
            path.join(opts.diffDir, `${prefix}-html.png`),
            PNG.sync.write(a),
          );
          await fs.writeFile(
            path.join(opts.diffDir, `${prefix}-pdf.png`),
            PNG.sync.write(b),
          );
        }
      }

      pages.push({
        pageIndex: i,
        width,
        height,
        diffPixels,
        totalPixels,
        similarity,
        ...(diffPath ? { diffPath } : {}),
      });
    }

    const worst = pages.reduce((m, p) => Math.min(m, p.similarity), 1);
    const mean = pages.reduce((s, p) => s + p.similarity, 0) / Math.max(1, pages.length);
    return {
      fixture: args.fixture,
      pages,
      worstSimilarity: worst,
      meanSimilarity: mean,
    };
  } finally {
    /* Caller is responsible for closeScreenshotBrowser() at suite teardown. */
  }
}
