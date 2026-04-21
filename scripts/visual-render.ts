/**
 * Visual smoke test: render a battery of real-world HTML samples to PDFs
 * under ./tmp/visual/ and print a per-sample report (bytes, pages, sha).
 *
 * Run: npx tsx scripts/visual-render.ts
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pino } from 'pino';
import { loadConfig } from '../src/config/index.js';
import { sha256Hex } from '../src/lib/hash.js';
import { BrowserPool, PdfRenderer } from '../src/services/pdf/index.js';

interface Sample {
  name: string;
  request:
    | { html: string; baseUrl?: string; options?: Record<string, unknown> }
    | { url: string; options?: Record<string, unknown> };
  options?: Record<string, unknown>;
}

const samples: Sample[] = [
  {
    name: '01-hello-world',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8"><title>Hello</title>
        <style>body{font-family:system-ui;margin:40px} h1{color:#2563eb}</style></head>
        <body><h1>Hello, world!</h1><p>This is a baseline render.</p></body></html>`,
    },
  },
  {
    name: '02-typography-and-colors',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:Georgia,serif;background:#fafafa;color:#222;padding:48px}
        h1{font-weight:300;letter-spacing:.02em;color:#0ea5e9}
        h2{border-bottom:2px solid #e11d48;padding-bottom:.25em}
        code{background:#fde68a;padding:1px 4px;border-radius:3px}
        blockquote{border-left:4px solid #10b981;margin:0;padding-left:1em;color:#374151}
      </style></head><body>
        <h1>Document Title</h1><h2>Section</h2>
        <p>Lorem ipsum dolor sit <code>amet</code> consectetur adipiscing elit.</p>
        <blockquote>“Production-ready” is a sentence-long claim with paragraph-long evidence.</blockquote>
      </body></html>`,
    },
  },
  {
    name: '03-page-breaks',
    request: {
      html: `<!doctype html><html><head><style>
        .page{height:90vh;display:flex;align-items:center;justify-content:center;font-size:48px;page-break-after:always}
        .page:last-child{page-break-after:auto}
      </style></head><body>
        <div class="page" style="background:#fee2e2">Page 1</div>
        <div class="page" style="background:#dbeafe">Page 2</div>
        <div class="page" style="background:#dcfce7">Page 3</div>
        <div class="page" style="background:#fef3c7">Page 4</div>
      </body></html>`,
      options: { format: 'A4' },
    },
  },
  {
    name: '04-svg-and-tables',
    request: {
      html: `<!doctype html><html><head><style>
        body{font-family:system-ui;padding:32px}
        table{width:100%;border-collapse:collapse;margin-top:24px}
        th,td{border:1px solid #e5e7eb;padding:8px;text-align:left}
        thead{background:#f3f4f6}
      </style></head><body>
        <h1>Quarterly Report</h1>
        <svg width="320" height="120" viewBox="0 0 320 120">
          <rect x="10" y="40" width="40" height="60" fill="#3b82f6"/>
          <rect x="60" y="20" width="40" height="80" fill="#10b981"/>
          <rect x="110" y="50" width="40" height="50" fill="#f59e0b"/>
          <rect x="160" y="10" width="40" height="90" fill="#ef4444"/>
          <rect x="210" y="30" width="40" height="70" fill="#8b5cf6"/>
        </svg>
        <table><thead><tr><th>Quarter</th><th>Revenue</th><th>Growth</th></tr></thead>
        <tbody>
          <tr><td>Q1</td><td>$1.2M</td><td>+8%</td></tr>
          <tr><td>Q2</td><td>$1.5M</td><td>+25%</td></tr>
          <tr><td>Q3</td><td>$1.8M</td><td>+20%</td></tr>
          <tr><td>Q4</td><td>$2.1M</td><td>+17%</td></tr>
        </tbody></table></body></html>`,
    },
  },
  {
    name: '05-header-footer-template',
    request: {
      html: `<!doctype html><html><body style="font-family:system-ui;padding:24px">
        <h1>Long document</h1>${'<p>Paragraph filler. </p>'.repeat(120)}
      </body></html>`,
    },
    options: {
      displayHeaderFooter: true,
      headerTemplate:
        '<div style="font-size:9px;width:100%;text-align:center;color:#6b7280">html-to-pdf demo</div>',
      footerTemplate:
        '<div style="font-size:9px;width:100%;text-align:center;color:#6b7280">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      margin: { top: '60px', bottom: '60px', left: '40px', right: '40px' },
    },
  },
  {
    name: '06-landscape-and-scale',
    request: {
      html: `<!doctype html><html><body style="margin:0">
        <div style="background:linear-gradient(135deg,#0ea5e9,#8b5cf6);color:white;padding:60px;height:100vh;font-family:system-ui">
          <h1 style="font-size:64px">Landscape</h1>
          <p style="font-size:24px">Wide-format layout with scale=0.8</p>
        </div></body></html>`,
    },
    options: { landscape: true, scale: 0.8, format: 'A4' },
  },
  {
    name: '07-print-media-emulation',
    request: {
      html: `<!doctype html><html><head><style>
        @media screen { .x { color: red } }
        @media print  { .x { color: green } }
      </style></head><body><p class="x">If green, print media is active.</p></body></html>`,
    },
  },
  {
    name: '08-real-url-example-com',
    request: { url: 'https://example.com' },
  },
];

async function main(): Promise<void> {
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    BROWSER_POOL_SIZE: '2',
    ALLOW_PRIVATE_NETWORKS: 'false',
  });
  const logger = pino({ level: 'silent' });
  const pool = new BrowserPool({
    size: config.BROWSER_POOL_SIZE,
    idleTtlMs: config.BROWSER_IDLE_TTL_MS,
    logger,
  });
  await pool.start();
  const renderer = new PdfRenderer(pool, config, logger);

  const outDir = path.resolve('tmp/visual');
  await fs.mkdir(outDir, { recursive: true });

  const report: Array<Record<string, unknown>> = [];
  for (const s of samples) {
    const start = Date.now();
    try {
      const req = { ...s.request, ...(s.options ? { options: s.options } : {}) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await renderer.render(req as any);
      const file = path.join(outDir, `${s.name}.pdf`);
      await fs.writeFile(file, res.pdf);
      const sha = sha256Hex(res.pdf);
      report.push({
        sample: s.name,
        ok: true,
        bytes: res.bytes,
        pages: res.pages,
        ms: Date.now() - start,
        sha8: sha.slice(0, 8),
        file: path.relative(process.cwd(), file),
      });
    } catch (err) {
      report.push({
        sample: s.name,
        ok: false,
        ms: Date.now() - start,
        error: (err as Error).message,
      });
    }
  }

  await pool.stop();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
