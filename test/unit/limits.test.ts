import { describe, expect, it } from 'vitest';
import {
  assertContentSize,
  assertHtmlSize,
  assertPageCount,
  LimitExceededError,
} from '@/security/limits.js';

describe('limits', () => {
  it('passes when under limits', () => {
    expect(() => assertHtmlSize('hello', 1024)).not.toThrow();
    expect(() => assertContentSize(100, 1024)).not.toThrow();
    expect(() => assertPageCount(5, 100)).not.toThrow();
  });

  it('throws LimitExceededError when over', () => {
    expect(() => assertHtmlSize('a'.repeat(100), 10)).toThrow(LimitExceededError);
    expect(() => assertContentSize(2048, 1024)).toThrow(LimitExceededError);
    expect(() => assertPageCount(101, 100)).toThrow(LimitExceededError);
  });
});
