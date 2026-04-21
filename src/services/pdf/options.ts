import type { Page } from 'playwright';
import type { ConvertOptions } from '@/types/index.js';

type PDFOptions = NonNullable<Parameters<Page['pdf']>[0]>;

const toMargin = (v: string | number | undefined): string | undefined => {
  if (v === undefined) return undefined;
  return typeof v === 'number' ? `${v}px` : v;
};

const toDimension = (v: string | number | undefined): string | number | undefined => v;

export function buildPdfOptions(o: ConvertOptions): PDFOptions {
  const out: PDFOptions = {
    format: o.format,
    landscape: o.landscape,
    printBackground: o.printBackground,
    scale: o.scale,
    preferCSSPageSize: o.preferCSSPageSize,
    displayHeaderFooter: o.displayHeaderFooter,
  };
  if (o.headerTemplate !== undefined) out.headerTemplate = o.headerTemplate;
  if (o.footerTemplate !== undefined) out.footerTemplate = o.footerTemplate;
  if (o.pageRanges !== undefined) out.pageRanges = o.pageRanges;
  if (o.width !== undefined) out.width = toDimension(o.width) as never;
  if (o.height !== undefined) out.height = toDimension(o.height) as never;
  if (o.margin) {
    const m: NonNullable<PDFOptions['margin']> = {};
    const t = toMargin(o.margin.top);
    const r = toMargin(o.margin.right);
    const b = toMargin(o.margin.bottom);
    const l = toMargin(o.margin.left);
    if (t !== undefined) m.top = t;
    if (r !== undefined) m.right = r;
    if (b !== undefined) m.bottom = b;
    if (l !== undefined) m.left = l;
    out.margin = m;
  }
  return out;
}
