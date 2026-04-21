import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

export interface SsrfPolicy {
  allowedHosts: string[];
  blockedHosts: string[];
  allowPrivateNetworks: boolean;
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
  /^224\./, // multicast
  /^240\./, // reserved
  /^255\.255\.255\.255$/,
];

function isPrivateV4(addr: string): boolean {
  return PRIVATE_V4.some((re) => re.test(addr));
}

function isPrivateV6(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a === '::1' || a === '::') return true;
  if (a.startsWith('fe80:')) return true; // link-local
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // ULA
  if (a.startsWith('ff')) return true; // multicast
  if (a.startsWith('::ffff:')) {
    const v4 = a.slice('::ffff:'.length);
    if (isIP(v4) === 4) return isPrivateV4(v4);
  }
  return false;
}

export function isPrivateAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 4) return isPrivateV4(addr);
  if (fam === 6) return isPrivateV6(addr);
  return false;
}

/**
 * Normalize a hostname for comparison: lowercase + IDN→Punycode. The URL
 * constructor already converts IDN to ASCII for url.hostname, but allowlist
 * entries supplied by humans may be Unicode (e.g. "münchen.de"). Convert both
 * sides to ASCII so a Unicode allowlist entry matches the URL.hostname form.
 */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  try {
    return new URL(`http://${lower}`).hostname;
  } catch {
    return lower;
  }
}

function hostMatches(host: string, patterns: string[]): boolean {
  const h = normalizeHost(host);
  return patterns.some((p) => {
    const pat = normalizeHost(p.replace(/^\*\./, ''));
    const isWildcard = p.startsWith('*.');
    if (isWildcard) return h === pat || h.endsWith(`.${pat}`);
    return h === pat;
  });
}

export interface ResolvedUrl {
  url: URL;
  addresses: string[];
}

export async function assertSafeUrl(input: string, policy: SsrfPolicy): Promise<ResolvedUrl> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfError('Invalid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SsrfError(`Disallowed protocol: ${url.protocol}`);
  }

  const host = url.hostname;

  if (policy.blockedHosts.length && hostMatches(host, policy.blockedHosts)) {
    throw new SsrfError(`Host is blocked: ${host}`);
  }
  if (policy.allowedHosts.length && !hostMatches(host, policy.allowedHosts)) {
    throw new SsrfError(`Host is not in allowlist: ${host}`);
  }

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      const records = await dns.lookup(host, { all: true, verbatim: true });
      addresses = records.map((r) => r.address);
    } catch (e) {
      throw new SsrfError(`DNS resolution failed for ${host}`);
    }
  }

  if (!policy.allowPrivateNetworks) {
    for (const addr of addresses) {
      if (isPrivateAddress(addr)) {
        throw new SsrfError(`Resolves to private/reserved address: ${addr}`);
      }
    }
  }

  return { url, addresses };
}
