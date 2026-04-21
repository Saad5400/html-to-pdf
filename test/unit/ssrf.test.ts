import { describe, expect, it } from 'vitest';
import { assertSafeUrl, isPrivateAddress, SsrfError } from '@/security/ssrf.js';

describe('isPrivateAddress', () => {
  it('flags ipv4 loopback/private/link-local/CGNAT/multicast', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('224.0.0.1')).toBe(true);
  });

  it('passes public ipv4', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
  });

  it('flags ipv6 loopback/ula/link-local/multicast and v4-mapped private', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('ff02::1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('passes public ipv6', () => {
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  const policy = { allowedHosts: [], blockedHosts: [], allowPrivateNetworks: false };

  it('rejects non-http(s)', async () => {
    await expect(assertSafeUrl('file:///etc/passwd', policy)).rejects.toThrow(SsrfError);
    await expect(assertSafeUrl('ftp://example.com', policy)).rejects.toThrow(SsrfError);
  });

  it('rejects literal private IPs', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/', policy)).rejects.toThrow(/private/);
    await expect(assertSafeUrl('http://169.254.169.254/', policy)).rejects.toThrow(/private/);
  });

  it('honors blocklist', async () => {
    await expect(
      assertSafeUrl('http://metadata.google.internal/x', {
        ...policy,
        blockedHosts: ['metadata.google.internal'],
      }),
    ).rejects.toThrow(/blocked/);
  });

  it('honors allowlist', async () => {
    await expect(
      assertSafeUrl('http://example.com/', { ...policy, allowedHosts: ['other.com'] }),
    ).rejects.toThrow(/allowlist/);
  });

  it('rejects malformed urls', async () => {
    await expect(assertSafeUrl('not-a-url', policy)).rejects.toThrow(/Invalid URL/);
  });
});
