import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function hmacVerify(secret: string, payload: string, signature: string): boolean {
  // Hash both sides to a fixed-length digest so length differences (and the
  // string content of `signature`) don't leak via fast-path branches.
  const expected = createHash('sha256').update(hmacSign(secret, payload)).digest();
  const got = createHash('sha256').update(signature).digest();
  return timingSafeEqual(expected, got);
}

/**
 * Stable JSON serializer for hashing. Object keys are sorted recursively and
 * `undefined` values are dropped — same value semantics as JSON.stringify but
 * order-independent so two semantically-equal payloads hash identically.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
