/**
 * fetch-multimodal.ts tests — Cat 11 fixture-fetcher coverage.
 *
 * Covers:
 *   - sha256OfBuffer / sha256OfFile primitive correctness
 *   - validateManifest accepts well-formed manifests + rejects malformed ones
 *   - fetchBuffer surfaces non-2xx as throws (no silent corruption)
 *   - fetchBuffer rejects oversize responses
 *   - runModality in --check mode: ok / missing / mismatch
 *   - runModality in --fetch mode: skips when hash matches; downloads + verifies
 *     when hash mismatches; mismatched download is reported, not written
 *   - runModality in --bootstrap mode: writes file, mutates manifest hash,
 *     persists manifest to disk
 *   - deriveArxivCanonical strips ar5iv chrome (ltx_document body extraction)
 *   - deriveWikipediaCanonical pulls the page extract from MediaWiki API JSON
 *
 * No network calls — every fetchImpl is injected per-test.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  sha256OfBuffer,
  sha256OfFile,
  validateManifest,
  fetchBuffer,
  runModality,
  deriveArxivCanonical,
  deriveWikipediaCanonical,
  type FixtureManifest,
} from '../../eval/cli/fetch-multimodal.ts';

function tmpRoot(): string {
  const dir = join(tmpdir(), `fetch-multimodal-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifestFile(root: string, modality: 'pdf' | 'html' | 'audio', m: FixtureManifest): void {
  const dir = join(root, modality);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(m, null, 2));
}

// Build a fetch implementation that returns a Map of url→Buffer (or 404).
function stubFetch(map: Map<string, Buffer | { status: number; body?: Buffer }>): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const v = map.get(url);
    if (v === undefined) {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    if (Buffer.isBuffer(v)) {
      return new Response(v as unknown as ArrayBuffer, { status: 200, statusText: 'OK' });
    }
    return new Response(v.body ?? '', { status: v.status, statusText: `HTTP ${v.status}` });
  };
}

// ─── Hash primitives ──────────────────────────────────────────────────

describe('sha256 primitives', () => {
  test('sha256OfBuffer matches a known vector', () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const out = sha256OfBuffer(Buffer.from('hello', 'utf-8'));
    expect(out).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  test('sha256OfFile reads + hashes', () => {
    const root = tmpRoot();
    try {
      const path = join(root, 'sample.bin');
      writeFileSync(path, Buffer.from('hello', 'utf-8'));
      expect(sha256OfFile(path)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Manifest validation ──────────────────────────────────────────────

describe('validateManifest', () => {
  const ok = {
    version: 1,
    license: 'CC-BY-4.0',
    source: 'test',
    items: [
      { name: 'a', path: 'a.pdf', canonical_path: 'canonical/a.txt', sha256: '', source_url: 'https://x' },
    ],
  };

  test('accepts a well-formed manifest', () => {
    expect(() => validateManifest(ok, '/tmp/x')).not.toThrow();
  });

  test('rejects wrong version', () => {
    expect(() => validateManifest({ ...ok, version: 2 }, '/tmp/x')).toThrow(/version must be 1/);
  });

  test('rejects missing license', () => {
    expect(() => validateManifest({ ...ok, license: '' }, '/tmp/x')).toThrow(/license/);
  });

  test('rejects items not an array', () => {
    expect(() => validateManifest({ ...ok, items: 'nope' }, '/tmp/x')).toThrow(/items must be an array/);
  });

  test('rejects item missing required field', () => {
    const bad = { ...ok, items: [{ name: 'a', path: 'a.pdf', sha256: '' }] };
    expect(() => validateManifest(bad, '/tmp/x')).toThrow(/canonical_path/);
  });

  test('rejects duplicate item names', () => {
    const bad = {
      ...ok,
      items: [
        { name: 'a', path: 'a.pdf', canonical_path: 'a.txt', sha256: '', source_url: 'https://x' },
        { name: 'a', path: 'b.pdf', canonical_path: 'b.txt', sha256: '', source_url: 'https://y' },
      ],
    };
    expect(() => validateManifest(bad, '/tmp/x')).toThrow(/appears twice/);
  });

  test('rejects sha256 not a string (must be "" before bootstrap)', () => {
    const bad = {
      ...ok,
      items: [{ ...ok.items[0], sha256: null }],
    };
    expect(() => validateManifest(bad, '/tmp/x')).toThrow(/sha256/);
  });
});

// ─── fetchBuffer ──────────────────────────────────────────────────────

describe('fetchBuffer', () => {
  test('returns body on 200', async () => {
    const fetchImpl = stubFetch(new Map([['https://x', Buffer.from('hello')]]));
    const buf = await fetchBuffer('https://x', { fetchImpl });
    expect(buf.toString()).toBe('hello');
  });

  test('throws on non-2xx', async () => {
    const fetchImpl = stubFetch(new Map([['https://x', { status: 500 }]]));
    await expect(fetchBuffer('https://x', { fetchImpl })).rejects.toThrow(/HTTP 500/);
  });

  test('throws on response too large', async () => {
    const fetchImpl = stubFetch(new Map([['https://x', Buffer.alloc(1024)]]));
    await expect(fetchBuffer('https://x', { fetchImpl, maxBytes: 100 })).rejects.toThrow(/too large/);
  });

  // ─── SSRF gate ─────────────────────────────────────────────────────
  // The fetcher reads contributor-controlled URLs. The gate must reject
  // file:/, private IPs, metadata hostnames, and IP-encoding bypasses
  // *before* any fetch goes out.

  test('rejects file:// URLs without calling fetch', async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response('x');
    };
    await expect(fetchBuffer('file:///etc/passwd', { fetchImpl })).rejects.toThrow(/blocked URL/);
    expect(called).toBe(false);
  });

  test('rejects loopback hosts', async () => {
    const fetchImpl: typeof fetch = async () => new Response('x');
    await expect(fetchBuffer('http://127.0.0.1/admin', { fetchImpl })).rejects.toThrow(/blocked URL/);
    await expect(fetchBuffer('http://[::1]/', { fetchImpl })).rejects.toThrow(/blocked URL/);
    await expect(fetchBuffer('http://localhost/', { fetchImpl })).rejects.toThrow(/blocked URL/);
  });

  test('rejects AWS metadata + IP-encoding bypasses', async () => {
    const fetchImpl: typeof fetch = async () => new Response('x');
    await expect(fetchBuffer('http://169.254.169.254/latest/meta-data/', { fetchImpl }))
      .rejects.toThrow(/blocked URL/);
    await expect(fetchBuffer('http://2130706433/', { fetchImpl })).rejects.toThrow(/blocked URL/);
    await expect(fetchBuffer('http://0x7f000001/', { fetchImpl })).rejects.toThrow(/blocked URL/);
  });

  // ─── Manual redirect walking ──────────────────────────────────────
  // Default fetch follows redirects. We re-validate every Location hop so a
  // public origin returning `302 → http://127.0.0.1/admin` can't probe the
  // maintainer's localhost services during --bootstrap.

  test('follows a same-origin relative redirect (arxiv-style)', async () => {
    // Mirrors arxiv.org/pdf/X.pdf → /pdf/X (relative Location).
    const payload = Buffer.from('pdf-bytes');
    const fetchImpl: typeof fetch = async (input) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u === 'https://arxiv.org/pdf/X.pdf') {
        return new Response(null, { status: 301, headers: { location: '/pdf/X' } });
      }
      if (u === 'https://arxiv.org/pdf/X') {
        return new Response(payload as unknown as ArrayBuffer, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    const buf = await fetchBuffer('https://arxiv.org/pdf/X.pdf', { fetchImpl });
    expect(buf.toString()).toBe('pdf-bytes');
  });

  test('follows a cross-origin absolute redirect (archive.org-style)', async () => {
    const payload = Buffer.from('mp3-bytes');
    const fetchImpl: typeof fetch = async (input) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u === 'https://archive.org/download/x/y.mp3') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://ia600607.us.archive.org/7/items/x/y.mp3' },
        });
      }
      if (u === 'https://ia600607.us.archive.org/7/items/x/y.mp3') {
        return new Response(payload as unknown as ArrayBuffer, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    const buf = await fetchBuffer('https://archive.org/download/x/y.mp3', { fetchImpl });
    expect(buf.toString()).toBe('mp3-bytes');
  });

  test('rejects a redirect into a private IP (SSRF via Location)', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u === 'https://attacker.example/innocuous') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } });
      }
      return new Response('reached', { status: 200 });
    };
    await expect(fetchBuffer('https://attacker.example/innocuous', { fetchImpl }))
      .rejects.toThrow(/blocked URL/);
  });

  test('rejects a redirect into file://', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u === 'https://attacker.example/start') {
        return new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } });
      }
      return new Response('x', { status: 200 });
    };
    await expect(fetchBuffer('https://attacker.example/start', { fetchImpl }))
      .rejects.toThrow(/blocked URL/);
  });

  test('caps redirect chain at maxRedirects', async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n++;
      return new Response(null, {
        status: 302,
        headers: { location: `https://hop-${n}.example/` },
      });
    };
    await expect(fetchBuffer('https://hop-0.example/', { fetchImpl, maxRedirects: 2 }))
      .rejects.toThrow(/Too many redirects/);
  });

  test('errors on redirect with no Location header', async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 302 });
    await expect(fetchBuffer('https://example.com/', { fetchImpl }))
      .rejects.toThrow(/no Location header/);
  });
});

// ─── runModality: --check ─────────────────────────────────────────────

describe('runModality (check mode)', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('reports missing for a fixture not on disk', async () => {
    const m: FixtureManifest = {
      version: 1,
      license: 'PD',
      source: 't',
      items: [{ name: 'a', path: 'a.pdf', canonical_path: 'canonical/a.txt', sha256: 'x', source_url: 'https://x' }],
    };
    writeManifestFile(root, 'pdf', m);
    const { reports } = await runModality(root, 'pdf', 'check');
    expect(reports[0].status).toBe('missing');
  });

  test('reports ok when present and hash matches', async () => {
    const buf = Buffer.from('hello');
    const hash = sha256OfBuffer(buf);
    const m: FixtureManifest = {
      version: 1,
      license: 'PD',
      source: 't',
      items: [{ name: 'a', path: 'a.pdf', canonical_path: 'canonical/a.txt', sha256: hash, source_url: 'https://x' }],
    };
    writeManifestFile(root, 'pdf', m);
    writeFileSync(join(root, 'pdf', 'a.pdf'), buf);
    const { reports } = await runModality(root, 'pdf', 'check');
    expect(reports[0].status).toBe('ok');
  });

  test('reports mismatch when hash differs', async () => {
    const m: FixtureManifest = {
      version: 1,
      license: 'PD',
      source: 't',
      items: [{ name: 'a', path: 'a.pdf', canonical_path: 'canonical/a.txt', sha256: 'WRONG', source_url: 'https://x' }],
    };
    writeManifestFile(root, 'pdf', m);
    writeFileSync(join(root, 'pdf', 'a.pdf'), Buffer.from('hello'));
    const { reports } = await runModality(root, 'pdf', 'check');
    expect(reports[0].status).toBe('mismatch');
  });
});

// ─── runModality: --fetch ────────────────────────────────────────────

describe('runModality (fetch mode)', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('downloads when file missing, hard-fails on hash mismatch', async () => {
    const buf = Buffer.from('payload');
    const fetchImpl = stubFetch(new Map([['https://x', buf]]));
    const m: FixtureManifest = {
      version: 1,
      license: 'PD',
      source: 't',
      items: [{ name: 'a', path: 'a.pdf', canonical_path: 'canonical/a.txt', sha256: 'expected-something-else', source_url: 'https://x' }],
    };
    writeManifestFile(root, 'pdf', m);
    const { reports } = await runModality(root, 'pdf', 'fetch', { fetchImpl });
    expect(reports[0].status).toBe('mismatch');
    // Mismatched download must NOT be written to disk
    expect(existsSync(join(root, 'pdf', 'a.pdf'))).toBe(false);
  });

  test('downloads + writes when hash matches', async () => {
    const buf = Buffer.from('payload');
    const hash = sha256OfBuffer(buf);
    const fetchImpl = stubFetch(new Map([['https://x', buf]]));
    const m: FixtureManifest = {
      version: 1,
      license: 'PD',
      source: 't',
      items: [{ name: 'a', path: 'a.pdf', canonical_path: 'canonical/a.txt', sha256: hash, source_url: 'https://x' }],
    };
    writeManifestFile(root, 'pdf', m);
    const { reports } = await runModality(root, 'pdf', 'fetch', { fetchImpl });
    expect(reports[0].status).toBe('fetched');
    expect(readFileSync(join(root, 'pdf', 'a.pdf')).toString()).toBe('payload');
  });

  test('skips download when present file already matches hash (idempotent)', async () => {
    const buf = Buffer.from('payload');
    const hash = sha256OfBuffer(buf);
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return new Response(buf as unknown as ArrayBuffer, { status: 200 });
    };
    const m: FixtureManifest = {
      version: 1,
      license: 'PD',
      source: 't',
      items: [{ name: 'a', path: 'a.pdf', canonical_path: 'canonical/a.txt', sha256: hash, source_url: 'https://x' }],
    };
    writeManifestFile(root, 'pdf', m);
    writeFileSync(join(root, 'pdf', 'a.pdf'), buf);
    const { reports } = await runModality(root, 'pdf', 'fetch', { fetchImpl });
    expect(reports[0].status).toBe('ok');
    expect(fetchCalled).toBe(false);
  });
});

// ─── runModality: --bootstrap ────────────────────────────────────────

describe('runModality (bootstrap mode)', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('downloads, recomputes hash, and persists manifest', async () => {
    const buf = Buffer.from('fresh content');
    const expected = sha256OfBuffer(buf);
    const fetchImpl = stubFetch(new Map([['https://src', buf]]));
    const m: FixtureManifest = {
      version: 1,
      license: 'PD',
      source: 't',
      items: [{ name: 'a', path: 'a.pdf', canonical_path: 'canonical/a.txt', sha256: '', source_url: 'https://src' }],
    };
    writeManifestFile(root, 'pdf', m);
    const { reports } = await runModality(root, 'pdf', 'bootstrap', { fetchImpl });
    expect(reports[0].status).toBe('updated');
    // Manifest on disk reflects the new hash
    const persisted = JSON.parse(readFileSync(join(root, 'pdf', 'fixtures.json'), 'utf-8'));
    expect(persisted.items[0].sha256).toBe(expected);
    // File is written
    expect(readFileSync(join(root, 'pdf', 'a.pdf'))).toEqual(buf);
  });

  test('reports ok (no-op) when bootstrap re-downloads same bytes', async () => {
    const buf = Buffer.from('stable');
    const hash = sha256OfBuffer(buf);
    const fetchImpl = stubFetch(new Map([['https://src', buf]]));
    const m: FixtureManifest = {
      version: 1,
      license: 'PD',
      source: 't',
      items: [{ name: 'a', path: 'a.pdf', canonical_path: 'canonical/a.txt', sha256: hash, source_url: 'https://src' }],
    };
    writeManifestFile(root, 'pdf', m);
    const { reports } = await runModality(root, 'pdf', 'bootstrap', { fetchImpl });
    expect(reports[0].status).toBe('ok');
  });

  test('reports error when source_url returns non-2xx', async () => {
    const fetchImpl = stubFetch(new Map([['https://src', { status: 500 }]]));
    const m: FixtureManifest = {
      version: 1,
      license: 'PD',
      source: 't',
      items: [{ name: 'a', path: 'a.pdf', canonical_path: 'canonical/a.txt', sha256: '', source_url: 'https://src' }],
    };
    writeManifestFile(root, 'pdf', m);
    const { reports } = await runModality(root, 'pdf', 'bootstrap', { fetchImpl });
    expect(reports[0].status).toBe('error');
    expect(reports[0].message).toContain('source_url');
  });

  test('bootstrap with canonical_url derives canonical text and writes it', async () => {
    const sourceBuf = Buffer.from('fake-pdf-bytes');
    const ar5ivHtml = `
      <!doctype html>
      <html><body>
        <article class="ltx_document">
          <h1>Some Paper Title</h1>
          <p>The body text the canonical pipeline should keep.</p>
        </article>
      </body></html>`;
    const fetchImpl = stubFetch(new Map<string, Buffer>([
      ['https://src/paper.pdf', sourceBuf],
      ['https://ar5iv/paper', Buffer.from(ar5ivHtml)],
    ]));
    const m: FixtureManifest = {
      version: 1,
      license: 'CC-BY-4.0',
      source: 'arXiv',
      items: [
        {
          name: 'paper',
          path: 'paper.pdf',
          canonical_path: 'canonical/paper.txt',
          sha256: '',
          source_url: 'https://src/paper.pdf',
          canonical_url: 'https://ar5iv/paper',
        },
      ],
    };
    writeManifestFile(root, 'pdf', m);
    const { reports } = await runModality(root, 'pdf', 'bootstrap', { fetchImpl });
    expect(reports[0].status).toBe('updated');
    const canonical = readFileSync(join(root, 'pdf', 'canonical', 'paper.txt'), 'utf-8');
    expect(canonical).toContain('Some Paper Title');
    expect(canonical).toContain('canonical pipeline should keep');
  });

  test('bootstrap reports error when canonical_url returns non-2xx', async () => {
    const sourceBuf = Buffer.from('fake-pdf-bytes');
    const fetchImpl = stubFetch(new Map([
      ['https://src/paper.pdf', sourceBuf],
      ['https://ar5iv/paper', { status: 404 }],
    ]));
    const m: FixtureManifest = {
      version: 1,
      license: 'CC-BY-4.0',
      source: 'arXiv',
      items: [
        {
          name: 'paper',
          path: 'paper.pdf',
          canonical_path: 'canonical/paper.txt',
          sha256: '',
          source_url: 'https://src/paper.pdf',
          canonical_url: 'https://ar5iv/paper',
        },
      ],
    };
    writeManifestFile(root, 'pdf', m);
    const { reports } = await runModality(root, 'pdf', 'bootstrap', { fetchImpl });
    expect(reports[0].status).toBe('error');
    expect(reports[0].message).toContain('canonical_url');
  });
});

// ─── Canonical derivation helpers ────────────────────────────────────

describe('deriveArxivCanonical', () => {
  test('extracts ltx_document body and strips chrome', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Junk title</title><style>body{}</style></head>
        <body>
          <header>nav nav nav</header>
          <article class="ltx_document">
            <h1>Real Paper Title</h1>
            <p>The actual paper content.</p>
          </article>
          <footer>copyright stuff</footer>
        </body>
      </html>`;
    const text = deriveArxivCanonical(html);
    expect(text).toContain('Real Paper Title');
    expect(text).toContain('actual paper content');
    // Chrome should not survive — header/footer/title outside the article tag are dropped
    expect(text).not.toContain('Junk title');
    expect(text).not.toContain('nav nav nav');
    expect(text).not.toContain('copyright stuff');
  });

  test('falls back to full strip when no ltx_document tag is present', () => {
    const html = '<html><body><p>fallback prose</p></body></html>';
    const text = deriveArxivCanonical(html);
    expect(text).toContain('fallback prose');
  });

  test('truncates output to MAX_PDF_CANONICAL_BYTES', () => {
    // Build a body with a long stretch of plain text so html→text yields > 25KB.
    const long = 'word '.repeat(20000); // ~100KB
    const html = `<article class="ltx_document">${long}</article>`;
    const text = deriveArxivCanonical(html);
    // 25_000 is the hardcoded cap; allow ≤ 25_000 to keep the test stable
    // even if the cap is later tweaked downward.
    expect(text.length).toBeLessThanOrEqual(25_000);
    // And the cap should actually be hit on this input
    expect(text.length).toBeGreaterThan(20_000);
  });
});

describe('deriveWikipediaCanonical', () => {
  test('pulls extract field from MediaWiki extracts response', () => {
    const json = JSON.stringify({
      query: { pages: { '12345': { title: 'Test', extract: 'Plain   text   with   spaces.' } } },
    });
    expect(deriveWikipediaCanonical(json)).toBe('Plain text with spaces.');
  });

  test('returns empty string when extract is missing', () => {
    const json = JSON.stringify({ query: { pages: { '12345': {} } } });
    expect(deriveWikipediaCanonical(json)).toBe('');
  });

  test('returns empty string when pages absent', () => {
    expect(deriveWikipediaCanonical(JSON.stringify({}))).toBe('');
  });
});
