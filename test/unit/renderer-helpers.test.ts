import { describe, expect, it } from 'vitest';
import { injectBaseTag, pinHostToIp } from '@/services/pdf/index.js';

describe('pinHostToIp', () => {
  it('replaces IPv4 hostname and preserves port', () => {
    const out = pinHostToIp('https://example.com:8443/path?x=1', '93.184.216.34');
    expect(out.url).toBe('https://93.184.216.34:8443/path?x=1');
    expect(out.host).toBe('example.com:8443');
  });

  it('wraps IPv6 in brackets', () => {
    const out = pinHostToIp('https://example.com/path', '2606:2800:220:1:248:1893:25c8:1946');
    expect(out.url).toBe('https://[2606:2800:220:1:248:1893:25c8:1946]/path');
    expect(out.host).toBe('example.com');
  });

  it('preserves query, fragment, and pathname encoding', () => {
    const out = pinHostToIp('https://x.com/a%20b?q=1#frag', '1.2.3.4');
    expect(out.url).toBe('https://1.2.3.4/a%20b?q=1#frag');
  });
});

describe('injectBaseTag', () => {
  it('inserts <base> right after an existing <head>', () => {
    const html = '<html><head><title>x</title></head><body/></html>';
    const out = injectBaseTag(html, 'https://e.com/');
    expect(out).toContain('<head><base href="https://e.com/"><title>');
  });

  it('synthesizes <head> when only <html> is present', () => {
    const html = '<html><body>x</body></html>';
    const out = injectBaseTag(html, 'https://e.com/');
    expect(out).toContain('<head><base href="https://e.com/"></head>');
  });

  it('prepends a <head> when neither is present', () => {
    const html = '<p>raw</p>';
    const out = injectBaseTag(html, 'https://e.com/');
    expect(out.startsWith('<head><base href="https://e.com/"></head>')).toBe(true);
  });

  it('escapes double quotes in href', () => {
    const out = injectBaseTag('<p/>', 'https://e.com/"><script>x</script><x ');
    expect(out).not.toContain('"><script>');
    expect(out).toContain('&quot;');
  });
});
