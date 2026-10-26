/**
 * The Q1 receipt assembler (eval/runner/q1/publish.ts): launch units map to their cell definition (shard suffixes,
 * no prefix collisions between S4 and S4-slice), the last settled lease of a unit wins, external build labels come
 * from the pin table without product names, and the committed publication config names real campaigns, the A21
 * questions, the found-and-fixed appendix and the retired temporal-graph subset (A24 option 1). Lease ids here are invented.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadManifest } from '../../eval/runner/q1/cells/definitions.ts';
import { bundlePins, gbrainBuildLabel, settledLeases, shardConversations, unitCell, type Publication } from '../../eval/runner/q1/publish.ts';
import { GBRAIN_BUILD } from '../../eval/runner/scoreboard.ts';

const ROOT = resolve(import.meta.dir, '../..');
const m = loadManifest();

describe('unitCell', () => {
  test('maps a cell id and its shard units, and nothing else', () => {
    expect(unitCell('s5.ext-markdown-kb.recipe', m.cells)?.id).toBe('s5.ext-markdown-kb.recipe');
    expect(unitCell('s5.ext-markdown-kb.recipe.c12', m.cells)?.id).toBe('s5.ext-markdown-kb.recipe');
    expect(unitCell('s4.gbrain-defaults.shipped-defaults.c1', m.cells)?.id).toBe('s4.gbrain-defaults.shipped-defaults');
    expect(unitCell('s4-slice.ext-markdown-kb.recipe.c0', m.cells)?.id).toBe('s4-slice.ext-markdown-kb.recipe');
    expect(unitCell('s5.ext-markdown-kb.recipe.cx', m.cells)).toBeUndefined();
    expect(unitCell('s5.ext-markdown-kb.recipe-extra', m.cells)).toBeUndefined();
  });
});

describe('settledLeases', () => {
  test('keeps the last settled lease of each unit and ignores unsettled ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'q1-publish-'));
    try {
      const ev = [
        { event: 'reserved', lease_id: 'u.c0-a1-aaaa', cell: 'u.c0', at: '2026-10-01T00:00:00Z' },
        { event: 'settled', lease_id: 'u.c0-a1-aaaa', at: '2026-10-01T01:00:00Z' },
        { event: 'reserved', lease_id: 'u.c0-a2-bbbb', cell: 'u.c0', at: '2026-10-01T02:00:00Z' },
        { event: 'settled', lease_id: 'u.c0-a2-bbbb', at: '2026-10-01T03:00:00Z' },
        { event: 'reserved', lease_id: 'u.c1-a1-cccc', cell: 'u.c1', at: '2026-10-01T00:00:00Z' },
        { event: 'abandoned', lease_id: 'u.c1-a1-cccc', at: '2026-10-01T04:00:00Z' },
      ];
      writeFileSync(join(dir, 'leases.ndjson'), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
      expect([...settledLeases(dir)]).toEqual([['u.c0', { lease: 'u.c0-a2-bbbb', at: '2026-10-01T03:00:00Z' }]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('bundlePins', () => {
  test('labels every external kind by bundle hashes, with no product or package name', () => {
    const pins = bundlePins(ROOT);
    const table = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(readFileSync(join(ROOT, 'docs/comparison-systems.md'), 'utf8').split('machine-readable pin table')[1])![1]) as Array<{ kind: string; product: string; lock_sha256: string | null }>;
    for (const p of table) {
      expect(pins[p.kind]).toMatch(/^bundle (lock [0-9a-f]{8}, )?capabilities [0-9a-f]{8}$/);
      expect(pins[p.kind]).not.toContain(p.product.split(' ')[0]);
    }
    expect(pins['ext-markdown-kb']).toBe('bundle lock e1a14a19, capabilities 4e95f8ef');
  });
});

describe('publication.json', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'docs/benchmarks/2026-10-06-scoreboard/publication.json'), 'utf8')) as Publication;
  test('names existing campaigns and the sealed hash', () => {
    for (const s of [...config.sources, ...config.pending]) expect(existsSync(join(ROOT, s.campaign))).toBe(true);
    expect(config.campaign_hash).toBe('a92b06c59ceb0c635c125147263eeacef2b47a88a558def6c8dafef18de987ea');
  });
  test('carries the A21 view on both LongMemEval-S sets and the found-and-fixed appendix for public-v2 gbrain', () => {
    const a21 = config.sensitivity.find(v => v.id === 'a21-repeated-sessions')!;
    expect(a21.sets).toEqual(['S4', 'S4-slice']);
    expect(a21.question_ids).toHaveLength(13);
    const appendix = config.sources.filter(s => s.appendix);
    expect(appendix).toHaveLength(1);
    expect(appendix[0].systems).toEqual(['gbrain-defaults']);
    expect(gbrainBuildLabel(appendix[0].gbrain!)).toBe('GBrain 0.60.106.0 (7aa2caa0, 2026-10-08)');
    expect(config.sources.find(s => !s.appendix && s.campaign.endsWith('public-v2.json'))?.exclude_systems).toEqual(['gbrain-defaults']);
  });

  test('the GBrain label comes from publish.ts: version, commit and date, never a hand-written pin, with the not-current-master footnote', () => {
    const label = gbrainBuildLabel(config.gbrain);
    expect(label).toBe('GBrain 0.60.138.0 (f05943e6, 2026-10-09)');
    expect(GBRAIN_BUILD.test(label)).toBe(true);
    expect([config.pins, ...config.sources.map(s => s.pins ?? {})].some(p => 'gbrain-defaults' in p)).toBe(false);
    expect(config.gbrain.footnote).toMatch(/not current master.*rerun.*current master.*A23/);
  });

  test('temporal-graph is retired with option 1: S1 on c0-c7, the not-run reason, the subset view and the F6 retest', () => {
    expect(config.retired).toHaveLength(1);
    const r = config.retired[0];
    expect(r).toMatchObject({ system: 'ext-temporal-graph', reason: 'pinned config calls a model its provider retired', subset: { cell: 's1.ext-temporal-graph.common', shards: [0, 1, 2, 3, 4, 5, 6, 7] } });
    const def = m.cells.find(c => c.id === r.subset.cell)!;
    expect(def.shards).toBe(10);
    expect(shardConversations(def, r.subset.shards)).toEqual(['10m-1', '10m-10', '10m-2', '10m-3', '10m-4', '10m-5', '10m-6', '10m-7']);
    expect(shardConversations(def, [8, 9])).toEqual(['10m-8', '10m-9']);
    expect(r.subset.label).toContain('c0-c7');
    expect(r.view.reason).toMatch(/every system on those 8 conversations/);
    expect(config.disclosures.find(d => d.startsWith('ext-temporal-graph:'))).toMatch(/retired.*never changed.*option 1.*c0-c7.*sensitivity view.*not run.*current release.*\(F6\)/);
  });
});
