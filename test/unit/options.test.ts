import { describe, expect, it } from 'vitest';
import { ConvertOptionsSchema, ConvertRequestSchema } from '@/schemas/convert.js';
import { buildPdfOptions } from '@/services/pdf/options.js';

describe('ConvertOptionsSchema', () => {
  it('applies defaults', () => {
    const opts = ConvertOptionsSchema.parse({});
    expect(opts.format).toBe('A4');
    expect(opts.printBackground).toBe(true);
    expect(opts.scale).toBe(1);
    expect(opts.waitUntil).toBe('networkidle');
    expect(opts.emulateMedia).toBe('print');
  });

  it('rejects bad scale', () => {
    expect(() => ConvertOptionsSchema.parse({ scale: 5 })).toThrow();
  });

  it('rejects bad margin units', () => {
    expect(() => ConvertOptionsSchema.parse({ margin: { top: '10kg' } })).toThrow();
  });

  it('accepts numeric margins', () => {
    const o = ConvertOptionsSchema.parse({ margin: { top: 12, bottom: 12 } });
    expect(o.margin?.top).toBe(12);
  });
});

describe('ConvertRequestSchema', () => {
  it('requires exactly one of url/html', () => {
    expect(() => ConvertRequestSchema.parse({})).toThrow(/exactly one/);
    expect(() =>
      ConvertRequestSchema.parse({ url: 'https://e.com', html: '<p/>' }),
    ).toThrow(/exactly one/);
    expect(() => ConvertRequestSchema.parse({ url: 'https://e.com' })).not.toThrow();
    expect(() => ConvertRequestSchema.parse({ html: '<p/>' })).not.toThrow();
  });
});

describe('buildPdfOptions', () => {
  it('translates margins to px when numeric', () => {
    const opts = ConvertOptionsSchema.parse({ margin: { top: 10, left: '1in' } });
    const pdf = buildPdfOptions(opts);
    expect(pdf.margin?.top).toBe('10px');
    expect(pdf.margin?.left).toBe('1in');
  });

  it('omits undefined optional keys', () => {
    const opts = ConvertOptionsSchema.parse({});
    const pdf = buildPdfOptions(opts);
    expect(pdf.headerTemplate).toBeUndefined();
    expect(pdf.pageRanges).toBeUndefined();
  });
});
