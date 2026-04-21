import { describe, expect, it } from 'vitest';
import { assertSafeUrl, SsrfError } from '@/security/ssrf.js';

describe('SSRF allowlist normalization (IDN/Punycode)', () => {
  const policy = (allow: string[], block: string[] = []) => ({
    allowedHosts: allow,
    blockedHosts: block,
    allowPrivateNetworks: true, // we want to focus on hostname matching, not DNS
  });

  it('allowlist Unicode entry matches Unicode URL (round-tripped to punycode)', async () => {
    // "münchen.de" punycode is "xn--mnchen-3ya.de"
    await expect(
      assertSafeUrl('http://xn--mnchen-3ya.de/', policy(['münchen.de'])),
    ).resolves.toBeDefined();
  });

  it('allowlist punycode entry also matches the same URL', async () => {
    await expect(
      assertSafeUrl('http://xn--mnchen-3ya.de/', policy(['xn--mnchen-3ya.de'])),
    ).resolves.toBeDefined();
  });

  it('rejects look-alike non-allowlisted host', async () => {
    await expect(
      assertSafeUrl('http://munchen.de/', policy(['xn--mnchen-3ya.de'])),
    ).rejects.toThrow(SsrfError);
  });

  it('wildcard allowlist matches subdomains and apex', async () => {
    // Use www.example.com — actually resolves in DNS, unlike api.example.com.
    await expect(
      assertSafeUrl('http://www.example.com/', policy(['*.example.com'])),
    ).resolves.toBeDefined();
    await expect(
      assertSafeUrl('http://example.com/', policy(['*.example.com'])),
    ).resolves.toBeDefined();
  });

  it('wildcard does not match unrelated suffix', async () => {
    await expect(
      assertSafeUrl('http://evil-example.com/', policy(['*.example.com'])),
    ).rejects.toThrow(SsrfError);
  });

  it('case-insensitive matching', async () => {
    await expect(
      assertSafeUrl('http://EXAMPLE.com/', policy(['example.com'])),
    ).resolves.toBeDefined();
  });

  it('blocklist matches Unicode→punycode forms', async () => {
    await expect(
      assertSafeUrl('http://xn--mnchen-3ya.de/', policy([], ['münchen.de'])),
    ).rejects.toThrow(/blocked/);
  });
});
