/**
 * HTML fixtures that mirror the output of a typical browser-based rich-text
 * editor (TipTap / Quill / Lexical / CKEditor). Used by the visual-fidelity
 * harness to verify that the rendered PDF looks like the rendered HTML at A4.
 *
 * Each fixture exports a `name` + `html`. Keep the font stack to faces that
 * both Chromium screenshot and pdfjs rasterization render identically — the
 * harness compares Chromium-DOM screenshots against pdfjs canvas raster, and
 * exotic web fonts amplify the gap between the two rasterizers.
 */

const BASE_CSS = `
  /* @page margins zeroed so the HTML screenshot (which has no @page support)
     and the PDF use the same content geometry. Visual margin lives on body
     padding instead. */
  @page { size: A4; margin: 0; }
  html, body { margin: 0; }
  html, body { width: 210mm; }
  body {
    box-sizing: border-box;
    padding: 18mm 16mm;
    font-family: 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif;
    font-size: 12pt;
    line-height: 1.5;
    color: #1f2937;
    background: #ffffff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4, h5, h6 { font-family: 'DejaVu Serif', 'Liberation Serif', Georgia, serif; color: #111827; margin: 0.6em 0 0.3em; }
  h1 { font-size: 28pt; }
  h2 { font-size: 22pt; border-bottom: 2px solid #e5e7eb; padding-bottom: 4px; }
  h3 { font-size: 18pt; }
  h4 { font-size: 15pt; }
  h5 { font-size: 13pt; }
  h6 { font-size: 12pt; text-transform: uppercase; letter-spacing: 0.05em; color: #4b5563; }
  p  { margin: 0.4em 0; }
  a  { color: #1d4ed8; text-decoration: underline; }
  code { font-family: 'DejaVu Sans Mono', 'Liberation Mono', monospace; background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 10.5pt; }
  pre  { background: #0f172a; color: #e2e8f0; padding: 12px 16px; border-radius: 6px; overflow: hidden; font-family: 'DejaVu Sans Mono', 'Liberation Mono', monospace; font-size: 10pt; line-height: 1.45; }
  pre code { background: transparent; color: inherit; padding: 0; }
  blockquote { margin: 0.6em 0; padding: 0.4em 1em; border-left: 4px solid #10b981; background: #ecfdf5; color: #064e3b; }
  ul, ol { margin: 0.4em 0; padding-left: 1.6em; }
  li { margin: 0.15em 0; }
  mark { background: #fde68a; padding: 0 2px; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 1em 0; }
  table { width: 100%; border-collapse: collapse; margin: 0.6em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
  thead th { background: #f3f4f6; }
  tbody tr:nth-child(even) td { background: #f9fafb; }
  .text-center { text-align: center; }
  .text-right  { text-align: right; }
  .text-justify { text-align: justify; }
  .callout { border: 1px solid #fbbf24; background: #fffbeb; padding: 10px 14px; border-radius: 6px; margin: 0.6em 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; background: #dbeafe; color: #1e3a8a; font-size: 10pt; }
  .page-break { page-break-before: always; }
  figure { margin: 0.6em 0; }
  figcaption { color: #6b7280; font-size: 10pt; text-align: center; margin-top: 4px; }
`;

// 1x1 transparent PNG, then a small inline SVG used for image-rendering checks.
const TINY_IMG_DATA_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">
       <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
       <rect width="320" height="120" rx="8" fill="url(#g)"/>
       <text x="160" y="68" font-family="DejaVu Sans, sans-serif" font-size="22" fill="white" text-anchor="middle">Inline SVG figure</text>
     </svg>`,
  );

export interface VisualFixture {
  name: string;
  html: string;
}

const wrap = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${BASE_CSS}</style>
</head>
<body>${body}</body>
</html>`;

export const fixtures: VisualFixture[] = [
  {
    name: 'rich-text-document',
    html: wrap(
      'Rich-text editor document',
      `
      <h1>Quarterly Review</h1>
      <p><strong>Bold</strong>, <em>italic</em>, <u>underline</u>, <s>strike</s>,
      <code>inline code</code>, <mark>highlight</mark>, H<sub>2</sub>O, E = mc<sup>2</sup>,
      <a href="https://example.com">link</a>, <span class="badge">in-progress</span>
      <span class="badge" style="background:#dcfce7;color:#065f46">shipped</span>.</p>

      <h3>Section heading</h3>
      <p>Ordinary paragraph with mixed <strong>weights</strong> and <em>emphasis</em>.</p>

      <div class="grid2">
        <div>
          <p><strong>Unordered, nested:</strong></p>
          <ul>
            <li>Build pipeline
              <ul>
                <li>Linter</li>
                <li>Typecheck</li>
              </ul>
            </li>
            <li>Release</li>
          </ul>
        </div>
        <div>
          <p><strong>Ordered, nested:</strong></p>
          <ol>
            <li>Plan
              <ol type="a">
                <li>Scope</li>
                <li>Estimates</li>
              </ol>
            </li>
            <li>Ship</li>
          </ol>
        </div>
      </div>

      <blockquote><p>"The only kind of writing is rewriting." — code review, 2024.</p></blockquote>
      <div class="callout"><strong>Note:</strong> reads hit the primary; replicas lag up to 800ms.</div>

      <pre><code>export function render(html: string) {
  return page.pdf({ format: 'A4', printBackground: true });
}</code></pre>

      <table>
        <thead><tr><th>Quarter</th><th>Renders</th><th>P95 ms</th><th>Errors</th></tr></thead>
        <tbody>
          <tr><td>Q1</td><td>1,204,118</td><td>820</td><td>0.07%</td></tr>
          <tr><td>Q2</td><td>1,556,902</td><td>740</td><td>0.04%</td></tr>
          <tr><td>Q3</td><td>1,801,557</td><td>705</td><td>0.05%</td></tr>
        </tbody>
      </table>

      <figure>
        <img alt="Gradient banner" src="${TINY_IMG_DATA_URI}" style="display:block;margin:0 auto;max-width:100%;height:auto"/>
        <figcaption>Inline SVG rendered as an image.</figcaption>
      </figure>
      `,
    ),
  },
  {
    name: 'typography-only',
    html: wrap(
      'Typography-only',
      `
      <h1>Typography</h1>
      <p>Regular paragraph. <strong>Bold.</strong> <em>Italic.</em> <strong><em>Bold italic.</em></strong>
      <u>Underline.</u> <s>Strike.</s> <code>code()</code>.</p>
      <p>Sub: H<sub>2</sub>SO<sub>4</sub>. Sup: x<sup>2</sup> + y<sup>2</sup> = r<sup>2</sup>.</p>
      <p><mark>Highlighted phrase</mark> alongside <a href="#">a link</a>.</p>
      <p class="text-center">Centered.</p>
      <p class="text-right">Right.</p>
      <p class="text-justify">Justified paragraph. The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump.</p>
      `,
    ),
  },
  {
    name: 'arabic-rtl',
    html: wrap(
      'Arabic RTL',
      `
      <h1 dir="rtl" lang="ar">عنوان المستند</h1>
      <p dir="rtl" lang="ar">هذا نص <strong>عريض</strong> و<em>مائل</em> و<u>مسطر</u> يظهر من اليمين إلى اليسار، مع <code>كود سطري</code> و<mark>تمييز</mark> داخل الفقرة.</p>
      <blockquote dir="rtl" lang="ar"><p>اقتباس قصير لاختبار اتجاه النص واللون الخلفي والإطار الجانبي.</p></blockquote>
      <ul dir="rtl" lang="ar">
        <li>عنصر أول
          <ul><li>عنصر فرعي</li><li>عنصر فرعي</li></ul>
        </li>
        <li>عنصر ثانٍ</li>
        <li>عنصر ثالث</li>
      </ul>
      <p>Back to LTR text — a standalone English paragraph below the Arabic block.</p>
      `,
    ),
  },
  {
    name: 'styled-blocks',
    html: wrap(
      'Styled blocks',
      `
      <h1>Styled blocks</h1>
      <div class="callout"><strong>Heads up:</strong> deployments freeze on Fridays after 14:00 UTC.</div>
      <blockquote><p>A quotation with <em>italic</em> emphasis, a <a href="#">link</a>, and <code>inline code</code>.</p></blockquote>
      <pre><code>const result = await renderer.render({ html, options: { format: 'A4' } });</code></pre>
      <hr/>
      <p class="text-center"><span class="badge">draft</span> <span class="badge" style="background:#fee2e2;color:#991b1b">blocked</span> <span class="badge" style="background:#dcfce7;color:#065f46">shipped</span></p>
      <div style="background:linear-gradient(90deg,#0ea5e9,#8b5cf6);color:#fff;padding:18px;border-radius:8px;margin:12px 0">
        <strong>Gradient banner</strong> — printBackground: true must preserve this fill.
      </div>
      <div style="display:flex;gap:12px">
        <div style="flex:1;border:1px solid #e5e7eb;border-radius:6px;padding:10px">Flex item A</div>
        <div style="flex:1;border:1px solid #e5e7eb;border-radius:6px;padding:10px">Flex item B</div>
        <div style="flex:1;border:1px solid #e5e7eb;border-radius:6px;padding:10px">Flex item C</div>
      </div>
      `,
    ),
  },
  {
    name: 'tables-and-lists',
    html: wrap(
      'Tables & lists',
      `
      <h1>Tables &amp; lists</h1>
      <h2>Data table</h2>
      <table>
        <thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>Widget</td><td>3</td><td>$12.00</td></tr>
          <tr><td>2</td><td>Gadget</td><td>1</td><td>$45.50</td></tr>
          <tr><td>3</td><td>Gizmo</td><td>7</td><td>$3.25</td></tr>
          <tr><td>4</td><td>Doohickey</td><td>2</td><td>$8.75</td></tr>
        </tbody>
        <tfoot><tr><th colspan="3" style="text-align:right">Total</th><th>$92.75</th></tr></tfoot>
      </table>
      <h2>Nested lists</h2>
      <ol>
        <li>Top
          <ul>
            <li>Nested unordered</li>
            <li>Nested unordered
              <ol><li>Deep ordered</li><li>Deep ordered</li></ol>
            </li>
          </ul>
        </li>
        <li>Top
          <ol><li>Mid</li><li>Mid</li></ol>
        </li>
      </ol>
      `,
    ),
  },
];
