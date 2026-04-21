import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/index.js';

describe('loadConfig', () => {
  it('applies defaults from empty env', () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(3000);
    expect(c.STORAGE_DRIVER).toBe('local');
    expect(c.RATE_LIMIT_PER_MIN).toBe(60);
  });

  it('parses CSVs', () => {
    const c = loadConfig({ API_KEYS: 'a, b ,c', BLOCKED_URL_HOSTS: 'x.com,y.com' });
    expect(c.API_KEYS).toEqual(['a', 'b', 'c']);
    expect(c.BLOCKED_URL_HOSTS).toEqual(['x.com', 'y.com']);
  });

  it('requires S3_BUCKET when STORAGE_DRIVER=s3', () => {
    expect(() => loadConfig({ STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });

  it('parses booleans loosely', () => {
    expect(loadConfig({ ALLOW_PRIVATE_NETWORKS: 'true' }).ALLOW_PRIVATE_NETWORKS).toBe(true);
    expect(loadConfig({ ALLOW_PRIVATE_NETWORKS: '0' }).ALLOW_PRIVATE_NETWORKS).toBe(false);
  });
});
