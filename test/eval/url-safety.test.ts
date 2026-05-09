/**
 * url-safety.ts tests — SSRF gate for the Cat 11 fixture fetcher.
 *
 * Mirrors the threat model from PR #4 review (#108 in upstream gbrain): the
 * fetcher reads contributor-controlled URLs from `fixtures.json`, so we need
 * a gate that blocks file:/, private IPs, metadata hostnames, IPv6 loopback,
 * and the common bypass encodings before any HTTP call goes out.
 */

import { describe, test, expect } from 'bun:test';
import {
  parseOctet,
  hostnameToOctets,
  isPrivateIpv4,
  isInternalUrl,
  assertSafeUrl,
} from '../../eval/cli/url-safety.ts';

describe('parseOctet', () => {
  test('decimal', () => { expect(parseOctet('127')).toBe(127); });
  test('hex', () => { expect(parseOctet('0x7f')).toBe(127); });
  test('octal', () => { expect(parseOctet('0177')).toBe(127); });
  test('rejects mixed garbage', () => {
    expect(parseOctet('0x')).toBeNaN();
    expect(parseOctet('08')).toBeNaN(); // not a valid octal digit
    expect(parseOctet('12a')).toBeNaN();
  });
});

describe('hostnameToOctets', () => {
  test('dotted decimal', () => { expect(hostnameToOctets('127.0.0.1')).toEqual([127, 0, 0, 1]); });
  test('single decimal (= 127.0.0.1)', () => {
    expect(hostnameToOctets('2130706433')).toEqual([127, 0, 0, 1]);
  });
  test('hex form (= 127.0.0.1)', () => {
    expect(hostnameToOctets('0x7f000001')).toEqual([127, 0, 0, 1]);
  });
  test('per-octet hex/octal', () => {
    expect(hostnameToOctets('0x7f.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(hostnameToOctets('0177.0.0.1')).toEqual([127, 0, 0, 1]);
  });
  test('returns null for non-IP hostnames', () => {
    expect(hostnameToOctets('arxiv.org')).toBeNull();
  });
});

describe('isPrivateIpv4', () => {
  test('classifies common private/reserved ranges', () => {
    expect(isPrivateIpv4([127, 0, 0, 1])).toBe(true);     // loopback
    expect(isPrivateIpv4([10, 0, 0, 1])).toBe(true);      // RFC1918
    expect(isPrivateIpv4([172, 16, 0, 1])).toBe(true);    // RFC1918
    expect(isPrivateIpv4([172, 31, 255, 254])).toBe(true);
    expect(isPrivateIpv4([172, 32, 0, 1])).toBe(false);   // outside 172.16/12
    expect(isPrivateIpv4([192, 168, 1, 1])).toBe(true);   // RFC1918
    expect(isPrivateIpv4([169, 254, 169, 254])).toBe(true); // AWS metadata
    expect(isPrivateIpv4([100, 64, 0, 1])).toBe(true);    // CGNAT (Tailscale)
    expect(isPrivateIpv4([0, 0, 0, 0])).toBe(true);       // unspecified
  });
  test('passes public addresses through', () => {
    expect(isPrivateIpv4([8, 8, 8, 8])).toBe(false);
    expect(isPrivateIpv4([151, 101, 0, 1])).toBe(false);  // archive.org-ish
  });
});

describe('isInternalUrl', () => {
  test('blocks non-http(s) schemes', () => {
    expect(isInternalUrl('file:///etc/passwd')).toBe(true);
    expect(isInternalUrl('data:text/plain,hello')).toBe(true);
    expect(isInternalUrl('ftp://example.com/x')).toBe(true);
    expect(isInternalUrl('javascript:alert(1)')).toBe(true);
    expect(isInternalUrl('blob:https://example.com/uuid')).toBe(true);
  });

  test('blocks malformed URLs (fail-closed)', () => {
    expect(isInternalUrl('not a url')).toBe(true);
    expect(isInternalUrl('')).toBe(true);
  });

  test('blocks loopback by name and number', () => {
    expect(isInternalUrl('http://localhost/')).toBe(true);
    expect(isInternalUrl('http://api.localhost/')).toBe(true);
    expect(isInternalUrl('http://127.0.0.1/')).toBe(true);
    expect(isInternalUrl('http://127.0.0.1./')).toBe(true);  // trailing dot
    expect(isInternalUrl('http://[::1]/')).toBe(true);
    expect(isInternalUrl('http://[::]/')).toBe(true);
  });

  test('blocks IP-encoding bypasses', () => {
    expect(isInternalUrl('http://2130706433/')).toBe(true);     // single decimal
    expect(isInternalUrl('http://0x7f000001/')).toBe(true);     // hex
    expect(isInternalUrl('http://0177.0.0.1/')).toBe(true);     // per-octet octal
    expect(isInternalUrl('http://0x7f.0.0.1/')).toBe(true);     // per-octet hex
  });

  test('blocks RFC1918 + link-local + CGNAT + metadata', () => {
    expect(isInternalUrl('http://10.0.0.1/')).toBe(true);
    expect(isInternalUrl('http://172.16.0.1/')).toBe(true);
    expect(isInternalUrl('http://192.168.1.1/')).toBe(true);
    expect(isInternalUrl('http://169.254.169.254/latest/meta-data/')).toBe(true);
    expect(isInternalUrl('http://100.64.0.1/')).toBe(true);
    expect(isInternalUrl('http://metadata.google.internal/')).toBe(true);
    expect(isInternalUrl('http://metadata/')).toBe(true);
  });

  test('blocks IPv4-mapped IPv6', () => {
    expect(isInternalUrl('http://[::ffff:127.0.0.1]/')).toBe(true);
    expect(isInternalUrl('http://[::ffff:7f00:1]/')).toBe(true);
  });

  test('blocks IPv6 ULA + link-local', () => {
    expect(isInternalUrl('http://[fc00::1]/')).toBe(true);
    expect(isInternalUrl('http://[fd12:3456:789a::1]/')).toBe(true);
    expect(isInternalUrl('http://[fe80::1]/')).toBe(true);
  });

  test('allows the legitimate fixture origins', () => {
    expect(isInternalUrl('https://arxiv.org/pdf/2204.02311v1.pdf')).toBe(false);
    expect(isInternalUrl('https://ar5iv.labs.arxiv.org/html/2204.02311v1')).toBe(false);
    expect(isInternalUrl('https://en.wikipedia.org/wiki/Albert_Einstein?oldid=1')).toBe(false);
    expect(isInternalUrl('https://archive.org/download/x/y.mp3')).toBe(false);
    expect(isInternalUrl('https://ia600607.us.archive.org/7/items/x/y.mp3')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  test('throws for blocked URLs', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(/blocked URL/);
    expect(() => assertSafeUrl('http://127.0.0.1/')).toThrow(/blocked URL/);
  });
  test('passes for public https', () => {
    expect(() => assertSafeUrl('https://arxiv.org/x.pdf')).not.toThrow();
  });
});
