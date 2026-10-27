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

  test('the sealed source lists the 122 units with rows under their freezes, and each not-run cell says why in its own words', () => {
    const sealed = config.sources.find(s => s.campaign.endsWith('q1-scoreboard-sealed.json'))!;
    expect(sealed.states!.map(s => s.dir)).toEqual(['a17', 'a22', 'a23', 'a24']);
    const units = sealed.states!.flatMap(s => s.units);
    expect(units).toHaveLength(122);
    expect(new Set(units).size).toBe(122);
    for (const u of units) expect(unitCell(u, m.cells)).toBeDefined();
    const verbatim = 'the harness has no common-config adapter for this system at this freeze (diagnostic config only)';
    expect(config.not_run['s2a.ext-verbatim-session.common']).toBe(verbatim);
    expect(config.not_run['s3.ext-verbatim-session.common']).toBe(verbatim);
    expect(config.not_run['s2b.ext-markdown-kb.recipe']).toBe('projected about 60 h > cell wall clock on the pinned VM');
    expect(config.not_run['s1.ext-markdown-kb.recipe']).toStartWith('projected ~61 h > 48 h limit');
    expect(config.not_run['s1.ext-graph-pipeline.common']).toStartWith("the product's own behavior (A23)");
    for (const id of Object.keys(config.not_run)) expect(m.cells.some(c => c.id === id)).toBe(true);
    expect(units.filter(u => unitCell(u, m.cells)!.id in config.not_run)).toEqual(['s1.ext-graph-pipeline.common.c2']);
  });

  test("S2b whole-think's 10 Sol answers at gbrain's own output limit are product failures, and the shipped-defaults view derives from its 8k arm", () => {
    expect(config.product_outcomes).toEqual([expect.objectContaining({ cell: 's2b.gbrain-defaults.full-surface.whole-think', reader: 'openai:gpt-6.1-sol', outcome: 'harness_invalid', count: 10 })]);
    expect(m.cells.some(c => c.arms.some(a => a.cell_id === config.product_outcomes[0].cell))).toBe(true);
    const v = config.sensitivity.find(x => x.id === 'a24-shipped-defaults-harness-invalid')!;
    expect(v.sets).toEqual(['S1']);
    expect(v.question_ids).toEqual([]);
    expect(v.from_outcomes).toEqual({ cell: 's1.gbrain-defaults.shipped-defaults.component-b8000', outcomes: ['harness_invalid'], count: 10 });
    expect(m.cells.some(c => c.arms.some(a => a.cell_id === v.from_outcomes!.cell))).toBe(true);
    expect(config.disclosures.find(d => d.startsWith('gbrain-defaults full-surface S2b'))).toMatch(/4,000 output tokens.*output_truncated.*product failures, scored 0/);
    expect(config.disclosures.find(d => d.startsWith('gbrain-defaults shipped-defaults S1'))).toMatch(/9 failed as .*degraded read.*8 .expansion_not_applied., 1 .expansion_partial.*the tenth, c4 vendor-default, scored/);
  });

  test('the disclosures carry the settled spend and unit counts, never the interim S2b figures', () => {
    const all = config.disclosures.join('\n');
    expect(all).toContain("$7,034.32 on the campaign ledgers against the $8,000 sealed cap; $6,729.26 of it is measured: $6,626.00 across the four freezes' cells (A17, A22, A23 and A24) plus $103.26 for the A19 frontier-judge backfill");
    expect(config.disclosures.find(d => d.startsWith('gbrain-defaults full-surface S2b'))).toMatch(/exactly 4,000 output tokens\) and a keyless \$0 repro.*not observed/);
    expect(all).toContain('Of 149 launch units, 114 settled complete, 8 partial and 27 not run');
    expect(all).toContain('1,960 of 2,140 gpt-6.1-sol frontier judgments');
    expect(all).toContain('194 of 214 Opus redos landed');
    expect(all).not.toMatch(/\$19\.29|about \$89|interim/);
    expect(config.published.url).toContain('/published/q1-scoreboard');
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
