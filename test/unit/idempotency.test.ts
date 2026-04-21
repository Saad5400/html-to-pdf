import { describe, expect, it } from 'vitest';
import { ConvertRequestSchema } from '@/schemas/convert.js';
import { idempotencyHash } from '@/services/queue/index.js';

describe('idempotencyHash', () => {
  const body = ConvertRequestSchema.parse({ html: '<p>x</p>' });

  it('is stable for the same inputs', () => {
    expect(idempotencyHash('tenant-a', 'k1', body)).toBe(idempotencyHash('tenant-a', 'k1', body));
  });

  it('changes when tenant changes', () => {
    expect(idempotencyHash('tenant-a', 'k1', body)).not.toBe(
      idempotencyHash('tenant-b', 'k1', body),
    );
  });

  it('changes when key changes', () => {
    expect(idempotencyHash('tenant-a', 'k1', body)).not.toBe(
      idempotencyHash('tenant-a', 'k2', body),
    );
  });

  it('changes when body changes', () => {
    const other = ConvertRequestSchema.parse({ html: '<p>y</p>' });
    expect(idempotencyHash('tenant-a', 'k1', body)).not.toBe(
      idempotencyHash('tenant-a', 'k1', other),
    );
  });
});
