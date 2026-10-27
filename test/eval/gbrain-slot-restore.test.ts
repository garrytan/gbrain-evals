import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfigPairs, refreshProviderBaseUrls, restoreProbe } from '../../eval/runner/cat40/gbrain-arm.ts';
import { rerankProbe } from '../../eval/runner/cat40-model-ladder.ts';

function home(cfg: Record<string, unknown>): string {
  const h = mkdtempSync(join(tmpdir(), 'slot-home-'));
  mkdirSync(join(h, '.gbrain'));
  writeFileSync(join(h, '.gbrain', 'config.json'), JSON.stringify(cfg));
  return h;
}
const read = (h: string) => JSON.parse(readFileSync(join(h, '.gbrain', 'config.json'), 'utf8'));

describe('refreshProviderBaseUrls (restored slots rerank through the live proxy)', () => {
  test('a snapshot built under an earlier proxy port is pointed at the current one', () => {
    const h = home({ engine: 'pglite', provider_base_urls: { voyage: 'http://127.0.0.1:37547/s1/voyage/v1', google: 'http://x' } });
    expect(refreshProviderBaseUrls(h, 'http://127.0.0.1:41000/s1/voyage/v1')).toBe(true);
    expect(read(h)).toEqual({ engine: 'pglite', provider_base_urls: { voyage: 'http://127.0.0.1:41000/s1/voyage/v1', google: 'http://x' } });
  });
  test('an up-to-date or unset Voyage URL is left alone', () => {
    const same = home({ provider_base_urls: { voyage: 'http://127.0.0.1:41000/s1/voyage/v1' } });
    expect(refreshProviderBaseUrls(same, 'http://127.0.0.1:41000/s1/voyage/v1')).toBe(false);
    const none = home({ engine: 'pglite' });
    expect(refreshProviderBaseUrls(none, 'http://127.0.0.1:41000/s1/voyage/v1')).toBe(false);
    expect(read(none)).toEqual({ engine: 'pglite' });
  });
  test('every start also sets the advertised MCP surface when one is given', () => {
    const h = home({ provider_base_urls: { voyage: 'http://127.0.0.1:41000/s1/voyage/v1' }, mcp: { other: 1 } });
    expect(refreshProviderBaseUrls(h, 'http://127.0.0.1:41000/s1/voyage/v1', 'starter')).toBe(true);
    expect(read(h)).toEqual({ provider_base_urls: { voyage: 'http://127.0.0.1:41000/s1/voyage/v1' }, mcp: { other: 1, advertised_surface: 'starter' } });
    expect(refreshProviderBaseUrls(h, 'http://127.0.0.1:41000/s1/voyage/v1', 'starter')).toBe(false);
  });
  test('a home without a config is a no-op', () => {
    expect(refreshProviderBaseUrls(mkdtempSync(join(tmpdir(), 'slot-home-')), 'http://127.0.0.1:1/v1')).toBe(false);
  });
});

describe('rerankProbe (from GBRA-39\'s #76: fail closed when a slot reaches no reranker)', () => {
  test('passes and restores when the probe search reranks, throws when it does not', async () => {
    const meters: Record<string, Record<string, { requests: number }>> = {};
    let bound = '';
    const unbound: Array<[string, string | undefined]> = [];
    const proxy = { bind: (_s: string, k: string) => { bound = k; }, unbind: (s: string, k?: string) => { unbound.push([s, k]); bound = ''; }, finalize: async (k: string) => ({ byModel: meters[k] ?? {} }) };
    const slot = (id: string, rerank: boolean) => ({ id, restored: 0, client: { call: async () => { meters[bound] = rerank ? { 'voyage:rerank-2.5': { requests: 1 }, 'openai:text-embedding-3-large': { requests: 1 } } : { 'openai:text-embedding-3-large': { requests: 1 } }; return '[]'; } }, async restore() { this.restored++; } });
    const ok = slot('slot0', true);
    await rerankProbe([ok], proxy, 'q');
    expect(ok.restored).toBe(1);
    expect(unbound).toEqual([['slot0', 'rerank-probe:slot0']]);
    const bad = slot('slot1', false);
    await expect(rerankProbe([bad], proxy, 'q')).rejects.toThrow('made no rerank request');
    expect(bad.restored).toBe(0);
  });
});

describe('parseConfigPairs (--gbrain-config, --gbrain-build-config)', () => {
  test('keeps comma-separated values and empty values', () => {
    expect(parseConfigPairs('--gbrain-config', 'entity.names_references=true,entity.record_types=contract,amendment,entity.x=,search.long_page_unit=section'))
      .toEqual([['entity.names_references', 'true'], ['entity.record_types', 'contract,amendment'], ['entity.x', ''], ['search.long_page_unit', 'section']]);
    expect(parseConfigPairs('--gbrain-config', undefined)).toEqual([]);
    expect(() => parseConfigPairs('--gbrain-config', 'amendment,a=b')).toThrow('expects key=value');
    expect(() => parseConfigPairs('--gbrain-config', '=x')).toThrow('expects key=value');
  });
});

describe('restoreProbe (config readback and the F5 slot family)', () => {
  const slot = (o: { config?: Array<[string, string]>; build?: Array<[string, string]>; stored?: Record<string, string>; links: number | null }) => ({
    id: 'slot0', config: o.config ?? [], buildConfig: o.build ?? [], stops: 0, starts: 0,
    async stop() { this.stops++; }, async start() { this.starts++; },
    async configGet(k: string) { return (o.stored ?? Object.fromEntries([...(o.build ?? []), ...(o.config ?? [])]))[k] ?? ''; },
    async ownerPhraseCounts() { return { links: o.links, windows: o.links }; },
  });
  test('records the readback and owner-phrase counts, and restarts the server', async () => {
    const s = slot({ config: [['entity.record_types', 'contract,amendment']], build: [['mentions.owner_phrases', 'true']], links: 12 });
    expect(await restoreProbe([s])).toEqual([{ slot: 'slot0', config: { 'mentions.owner_phrases': 'true', 'entity.record_types': 'contract,amendment' }, owner_phrases: { links: 12, windows: 12 } }]);
    expect([s.stops, s.starts]).toEqual([1, 1]);
  });
  test('refuses an F5 slot with zero owner-phrase links, and an F5-off slot that has some', async () => {
    await expect(restoreProbe([slot({ build: [['mentions.owner_phrases', 'true']], links: 0 })])).rejects.toThrow('holds 0 owner-phrase links');
    await expect(restoreProbe([slot({ build: [['mentions.owner_phrases', 'true']], links: null })])).rejects.toThrow('holds no owner-phrase links');
    await expect(restoreProbe([slot({ links: 3 })])).rejects.toThrow('use the F5-off slot family');
    expect(await restoreProbe([slot({ links: 0 })])).toHaveLength(1);
  });
  test('refuses a key that does not read back as set', async () => {
    await expect(restoreProbe([slot({ config: [['search.long_page_unit', 'section']], stored: { 'search.long_page_unit': 'off' }, links: 0 })])).rejects.toThrow('reads back "off"');
  });
});
