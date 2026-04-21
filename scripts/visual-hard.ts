/**
 * "Hard content" rendering battery — challenging samples to stress-test
 * production fidelity of the html-to-pdf renderer.
 *
 * Run: npx tsx scripts/visual-hard.ts
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

// 1×1 transparent PNG (for header image) base64 data URL
const TINY_LOGO_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVQ4T2NkYGD4z0AEYBxVSF9gVCF9gRGtEAB+ZQEBoa5vkgAAAABJRU5ErkJggg==';

const samples: Sample[] = [
  {
    name: '01-web-fonts',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Pacifico&family=Roboto+Mono:wght@400;700&display=swap');
  body{padding:40px;background:#fff;color:#111}
  .pacifico{font-family:'Pacifico',cursive;font-size:48px;color:#7c3aed}
  .mono{font-family:'Roboto Mono',monospace;font-size:18px;background:#f3f4f6;padding:6px 10px;border-radius:6px;display:inline-block}
  .fallback{font-family:serif;font-size:48px;color:#64748b}
  .label{font-family:system-ui;color:#475569;font-size:14px;margin-top:24px}
</style></head><body>
<h1 class="pacifico">Pacifico web font render</h1>
<p class="label">If the line above is a flowing script style, the web font loaded. If it is a generic serif/sans, it fell back.</p>
<p class="mono">const x = "Roboto Mono 700";</p>
<p class="label">Compare below (generic serif baseline):</p>
<p class="fallback">Fallback serif baseline</p>
</body></html>`,
      options: { waitUntil: 'networkidle' },
    },
  },
  {
    name: '02-emoji',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{font-family:system-ui;padding:40px}
  .row{font-size:72px;line-height:1.2;margin:12px 0}
  .label{color:#475569}
</style></head><body>
<h1>Emoji rendering</h1>
<div class="row">😀 🌍 🚀 🎨</div>
<div class="row">👨‍👩‍👧‍👦 🏳️‍🌈 👩🏽‍💻</div>
<p class="label">Top row: simple single-codepoint emoji. Bottom row: ZWJ sequences (family, rainbow flag, woman technologist w/ skin tone).</p>
</body></html>`,
    },
  },
  {
    name: '03-rtl-arabic-hebrew',
    request: {
      html: `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
  body{font-family:system-ui;padding:40px;line-height:1.8}
  .box{border:1px solid #cbd5e1;padding:16px;margin:12px 0}
  h1{color:#0ea5e9}
  .ltr-inside{direction:ltr;unicode-bidi:embed}
</style></head><body>
<h1>اتجاه النص من اليمين إلى اليسار</h1>
<div class="box" dir="rtl" lang="ar">
  <p>هذا نص عربي طويل يُستخدم للتحقّق من صحة تدفّق النص من اليمين إلى اليسار. الأرقام: 12345 والكلمة الإنجليزية <span class="ltr-inside">Production</span> داخل الجملة.</p>
</div>
<div class="box" dir="rtl" lang="he">
  <p>זהו טקסט עברי לבדיקת כיווניות מימין לשמאל. מספרים: 67890 ומילה באנגלית <span class="ltr-inside">Ready</span> בתוך המשפט.</p>
</div>
<div class="box" dir="ltr" lang="en">
  <p>English control line: left-to-right baseline.</p>
</div>
</body></html>`,
    },
  },
  {
    name: '04-cjk',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{font-family:system-ui,"Noto Sans CJK SC","Noto Sans CJK JP","Noto Sans CJK KR",sans-serif;padding:40px}
  .row{margin:16px 0;font-size:28px}
  .tag{display:inline-block;width:100px;color:#64748b;font-size:14px}
</style></head><body>
<h1>CJK glyph coverage</h1>
<div class="row"><span class="tag">Chinese:</span>你好，世界！今天天气很好。</div>
<div class="row"><span class="tag">Japanese:</span>こんにちは世界。今日はいい天気です。</div>
<div class="row"><span class="tag">Korean:</span>안녕하세요 세계. 오늘 날씨가 좋네요.</div>
<div class="row"><span class="tag">Mixed:</span>中文 日本語 한국어 — 123 ABC</div>
</body></html>`,
    },
  },
  {
    name: '05-math-katex',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.body)"></script>
<style>body{font-family:system-ui;padding:40px;line-height:1.6}</style>
</head><body>
<h1>Math notation (KaTeX)</h1>
<p>Inline: \\(E = mc^2\\) and \\(\\int_0^\\infty e^{-x^2} dx = \\tfrac{\\sqrt{\\pi}}{2}\\).</p>
<p>Display:</p>
<p>\\[\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}\\]</p>
<p>\\[\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\\begin{pmatrix}x\\\\y\\end{pmatrix} = \\begin{pmatrix}ax+by\\\\cx+dy\\end{pmatrix}\\]</p>
<p>If this text is unrendered TeX source, KaTeX failed to load (network blocked or CDN blocked).</p>
</body></html>`,
      options: { waitUntil: 'networkidle', waitForTimeoutMs: 2000 },
    },
  },
  {
    name: '06-flex-grid-complex',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{font-family:system-ui;margin:0;padding:24px;background:#f8fafc}
  .grid{display:grid;grid-template-columns:repeat(12,1fr);grid-template-rows:auto auto auto;gap:12px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
  .hero{grid-column:span 12;background:linear-gradient(135deg,#0ea5e9,#6366f1);color:#fff}
  .a{grid-column:span 4}.b{grid-column:span 4}.c{grid-column:span 4}
  .flex{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .chip{padding:4px 10px;border-radius:999px;background:#e0f2fe;color:#075985;font-size:12px}
  .wide{grid-column:span 8}.narrow{grid-column:span 4;background:#fef3c7}
  .cols{column-count:3;column-gap:24px;margin-top:16px}
  .cols p{break-inside:avoid}
</style></head><body>
<div class="grid">
  <div class="card hero"><h1>Dashboard</h1><p>Complex flex + grid combo</p></div>
  <div class="card a"><h3>Alpha</h3><div class="flex"><span class="chip">one</span><span class="chip">two</span><span class="chip">three</span></div></div>
  <div class="card b"><h3>Beta</h3><div class="flex"><span class="chip">alpha</span><span class="chip">beta</span><span class="chip">gamma</span><span class="chip">delta</span></div></div>
  <div class="card c"><h3>Gamma</h3><div class="flex"><span class="chip">x</span><span class="chip">y</span></div></div>
  <div class="card wide"><h3>Wide column</h3>
    <div class="cols">
      ${Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i + 1}. ${'Lorem ipsum dolor sit amet. '.repeat(6)}</p>`).join('')}
    </div>
  </div>
  <div class="card narrow"><h3>Narrow</h3><p>Yellow sidebar with flex content.</p></div>
</div>
</body></html>`,
    },
  },
  {
    name: '07-long-table',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{font-family:system-ui;padding:32px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left}
  thead{background:#f3f4f6;display:table-header-group}
  tr{page-break-inside:avoid}
  tr:nth-child(even) td{background:#fafafa}
</style></head><body>
<h1>Long table — should cross page boundaries with repeated header</h1>
<table>
  <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Role</th><th>Dept</th><th>Status</th></tr></thead>
  <tbody>
  ${Array.from({ length: 150 }, (_, i) => {
    const n = i + 1;
    return `<tr><td>${n}</td><td>User ${n}</td><td>user${n}@example.com</td><td>${['Admin', 'Editor', 'Viewer', 'Analyst'][n % 4]}</td><td>${['Eng', 'Sales', 'Ops', 'HR', 'Finance'][n % 5]}</td><td>${n % 3 === 0 ? 'Inactive' : 'Active'}</td></tr>`;
  }).join('')}
  </tbody>
</table>
</body></html>`,
    },
  },
  {
    name: '08-page-rules-landscape',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8">
<style>
  @page { size: A4 landscape; margin: 2cm; }
  body{font-family:system-ui;margin:0}
  h1{color:#059669}
  .band{background:#d1fae5;padding:24px;border-left:6px solid #059669}
  .pg{page-break-after:always;height:90vh;display:flex;align-items:center;justify-content:center;font-size:40px;background:#ecfdf5}
  .pg:last-child{page-break-after:auto}
</style></head><body>
<h1>@page { size: A4 landscape; margin: 2cm }</h1>
<div class="band">The page should be landscape A4 with a 2cm margin on all sides.</div>
<div class="pg">Page A</div>
<div class="pg">Page B</div>
</body></html>`,
      options: { preferCSSPageSize: true },
    },
  },
  {
    name: '09-svg-chart',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8">
<style>body{font-family:system-ui;padding:32px}</style></head><body>
<h1>SVG chart (paths + text + gradients)</h1>
<svg viewBox="0 0 600 320" width="720" xmlns="http://www.w3.org/2000/svg" font-family="system-ui" font-size="12">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#60a5fa" stop-opacity=".8"/>
      <stop offset="100%" stop-color="#60a5fa" stop-opacity=".05"/>
    </linearGradient>
  </defs>
  <!-- Axes -->
  <line x1="50" y1="20" x2="50" y2="280" stroke="#94a3b8"/>
  <line x1="50" y1="280" x2="580" y2="280" stroke="#94a3b8"/>
  <!-- Gridlines + y labels -->
  ${[0, 1, 2, 3, 4]
    .map((i) => {
      const y = 280 - i * 60;
      return `<line x1="50" y1="${y}" x2="580" y2="${y}" stroke="#e2e8f0" stroke-dasharray="2 3"/><text x="40" y="${y + 4}" text-anchor="end" fill="#475569">${i * 25}</text>`;
    })
    .join('')}
  <!-- Area chart path -->
  <path d="M 60,240 L 110,180 L 160,200 L 210,140 L 260,90 L 310,120 L 360,70 L 410,110 L 460,60 L 510,100 L 560,50 L 560,280 L 60,280 Z" fill="url(#g1)" stroke="none"/>
  <polyline points="60,240 110,180 160,200 210,140 260,90 310,120 360,70 410,110 460,60 510,100 560,50" fill="none" stroke="#2563eb" stroke-width="2"/>
  <!-- Dots + labels -->
  ${[
    [60, 240],
    [110, 180],
    [160, 200],
    [210, 140],
    [260, 90],
    [310, 120],
    [360, 70],
    [410, 110],
    [460, 60],
    [510, 100],
    [560, 50],
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="#1d4ed8"/>`)
    .join('')}
  <text x="315" y="310" text-anchor="middle" fill="#0f172a" font-weight="600">Monthly growth (arbitrary units)</text>
</svg>
</body></html>`,
    },
  },
  {
    name: '10-header-footer-images',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{font-family:system-ui;padding:0 8px}
  h1{color:#0f172a}
  p{line-height:1.55}
</style></head><body>
<h1>Report with header/footer (image + page numbers)</h1>
${'<p>Body paragraph with filler text to guarantee multiple pages. Lorem ipsum dolor sit amet, consectetur adipiscing elit. </p>'.repeat(80)}
</body></html>`,
    },
    options: {
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:9px;width:100%;padding:0 20px;display:flex;align-items:center;justify-content:space-between;color:#475569">
        <div style="display:flex;align-items:center;gap:6px"><img src="${TINY_LOGO_DATAURL}" width="12" height="12" style="display:inline-block"/><span>html-to-pdf visual-hard</span></div>
        <span class="date"></span>
      </div>`,
      footerTemplate: `<div style="font-size:9px;width:100%;padding:0 20px;display:flex;align-items:center;justify-content:space-between;color:#475569">
        <span class="title"></span>
        <span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`,
      margin: { top: '70px', bottom: '60px', left: '40px', right: '40px' },
    },
  },
  {
    name: '11-print-only-toggle',
    request: {
      html: `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{font-family:system-ui;padding:40px}
  .only-screen{display:block;color:#dc2626;font-weight:700;font-size:20px}
  .only-print{display:none;color:#059669;font-weight:700;font-size:20px}
  @media print {
    .only-screen{display:none !important}
    .only-print{display:block !important}
  }
  .box{border:1px solid #cbd5e1;padding:12px;margin:12px 0}
</style></head><body>
<h1>Print media toggling</h1>
<div class="box only-screen">SCREEN ONLY — if you see this in the PDF, print media is NOT active.</div>
<div class="box only-print">PRINT ONLY — if you see this (and not the red one) print media IS active.</div>
<p>Expected in PDF: only the green "PRINT ONLY" block is visible.</p>
</body></html>`,
    },
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

  const outDir = path.resolve('tmp/visual-hard');
  await fs.mkdir(outDir, { recursive: true });

  const report: Array<Record<string, unknown>> = [];
  for (const s of samples) {
    const start = Date.now();
    try {
      const inlineOpts = (s.request as { options?: Record<string, unknown> }).options ?? {};
      const reqOptions = { ...inlineOpts, ...(s.options ?? {}) };
      const req = {
        ...s.request,
        ...(Object.keys(reqOptions).length ? { options: reqOptions } : {}),
      };
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
