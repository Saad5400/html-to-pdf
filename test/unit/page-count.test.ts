import { describe, expect, it } from 'vitest';
import { countPdfPages } from '@/services/pdf/renderer.js';

describe('countPdfPages', () => {
  it('parses /Type /Pages /Count', () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Kids [] /Count 7 >> endobj');
    expect(countPdfPages(pdf)).toBe(7);
  });

  it('falls back to /Type /Page tally', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj',
    );
    expect(countPdfPages(pdf)).toBe(2);
  });

  it('returns at least 1', () => {
    expect(countPdfPages(Buffer.from('garbage'))).toBe(1);
  });
});
