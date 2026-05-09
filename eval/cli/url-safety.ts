/**
 * SSRF defense helpers for the Cat 11 fixture fetcher.
 *
 * The fetcher consumes contributor-controlled URLs from `fixtures.json`. Without
 * a gate, a manifest entry like `source_url: "file:///etc/passwd"` or
 * `https://attacker/` returning `302 → http://127.0.0.1/admin` would either
 * read local files or probe localhost services on a maintainer's box during
 * `--bootstrap`. The hash check stops *content* tampering, but the request
 * side-effect already happens.
 *
 * Mirrors the posture of `src/core/url-safety.ts` in the upstream gbrain repo
 * (PR #108 by @garagon). Catches the common bypass forms:
 *   - non-http(s) schemes (file:, data:, blob:, ftp:, javascript:)
 *   - IPv4 loopback / RFC1918 / link-local incl. AWS metadata 169.254.169.254
 *   - CGNAT 100.64/10 (Tailscale)
 *   - IPv6 loopback (::1), unspecified (::), ULA fc00::/7, link-local fe80::/10
 *   - IPv4-mapped IPv6 (::ffff:127.0.0.1) in dotted and hextet forms
 *   - Bypass encodings: hex IPs (0x7f000001), octal (0177.0.0.1), single
 *     decimal (2130706433)
 *   - GCP/AWS metadata hostnames
 *
 * Lexical only — does not perform DNS resolution. A public hostname with A
 * records pointing at internal IPs will still slip through; that's an upstream
 * known limitation tracked in TODOS.md (DNS rebinding).
 */

/** Parse an IPv4 octet from decimal, hex (0x prefix), or octal (leading 0) notation. */
export function parseOctet(s: string): number {
  if (s.length === 0) return NaN;
  if (s.startsWith('0x') || s.startsWith('0X')) {
    if (!/^0[xX][0-9a-fA-F]+$/.test(s)) return NaN;
    return parseInt(s, 16);
  }
  if (s.length > 1 && s.startsWith('0')) {
    if (!/^0[0-7]+$/.test(s)) return NaN;
    return parseInt(s, 8);
  }
  if (!/^\d+$/.test(s)) return NaN;
  return parseInt(s, 10);
}

/**
 * Convert an IPv4 hostname to 4 octets. Handles bypass encodings:
 *   - Dotted decimal: 127.0.0.1
 *   - Single decimal: 2130706433 (= 0x7f000001)
 *   - Hex: 0x7f000001
 *   - Per-octet hex/octal: 0x7f.0.0.1, 0177.0.0.1
 * Returns null for non-IP hostnames (caller falls through to hostname checks).
 */
export function hostnameToOctets(hostname: string): number[] | null {
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFFFF) {
      return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    }
    return null;
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFFFF) {
      return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    }
    return null;
  }
  const parts = hostname.split('.');
  if (parts.length === 4) {
    const octets = parts.map(parseOctet);
    if (octets.every(o => Number.isFinite(o) && o >= 0 && o <= 255)) return octets;
  }
  return null;
}

/** Classify an IPv4 address as internal/private/reserved. */
export function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 127) return true;                       // 127.0.0.0/8 loopback
  if (a === 10) return true;                        // 10.0.0.0/8 RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16 RFC1918
  if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local incl. AWS metadata
  if (a === 100 && b >= 64 && b <= 127) return true;// 100.64.0.0/10 CGNAT (Tailscale)
  if (a === 0) return true;                         // 0.0.0.0/8 unspecified
  return false;
}

const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.google',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

/**
 * Returns true if `urlStr` targets an internal/metadata endpoint or uses a
 * non-http(s) scheme. Fail-closed on parse errors (malformed → blocked).
 */
export function isInternalUrl(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;

  let host = url.hostname.toLowerCase();
  if (METADATA_HOSTNAMES.has(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // Strip [..] for IPv6 literals.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === '::1' || host === '::') return true;
  // IPv6 ULA (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;

  // IPv4-mapped IPv6: ::ffff:127.0.0.1 (dotted) or ::ffff:7f00:1 (hextet).
  if (host.startsWith('::ffff:')) {
    const tail = host.slice(7);
    const dotted = hostnameToOctets(tail);
    if (dotted && isPrivateIpv4(dotted)) return true;
    const hextets = tail.split(':');
    if (hextets.length === 2 && hextets.every(h => /^[0-9a-f]{1,4}$/.test(h))) {
      const hi = parseInt(hextets[0], 16);
      const lo = parseInt(hextets[1], 16);
      const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
      if (isPrivateIpv4(octets)) return true;
    }
  }

  const octets = hostnameToOctets(host);
  if (octets && isPrivateIpv4(octets)) return true;

  // Trailing-dot hostnames (`127.0.0.1.`) bypass naive checks.
  if (host.endsWith('.')) {
    const strippedOctets = hostnameToOctets(host.slice(0, -1));
    if (strippedOctets && isPrivateIpv4(strippedOctets)) return true;
  }

  return false;
}

/** Throws with a descriptive message if `urlStr` is internal or non-http(s). */
export function assertSafeUrl(urlStr: string): void {
  if (isInternalUrl(urlStr)) {
    throw new Error(`blocked URL (non-public or non-http(s)): ${urlStr}`);
  }
}
