import { describe, expect, it } from 'vitest';
import { hmacSign, hmacVerify, sha256Hex } from '@/lib/hash.js';

describe('hash utils', () => {
  it('sha256 produces stable lowercase hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hmac signs and verifies', () => {
    const sig = hmacSign('secret', 'payload');
    expect(hmacVerify('secret', 'payload', sig)).toBe(true);
    expect(hmacVerify('secret', 'payload', sig + 'x')).toBe(false);
    expect(hmacVerify('wrong', 'payload', sig)).toBe(false);
  });
});
