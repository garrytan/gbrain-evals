/**
 * The Q1 receipt assembler (eval/runner/q1/publish.ts): launch units map to their cell definition (shard suffixes,
 * no prefix collisions between S4 and S4-slice), the last settled lease of a unit wins, external build labels come
 * from the pin table without product names, and the committed publication config names real campaigns, the A21
 * questions and the found-and-fixed appendix. Lease ids here are invented.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadManifest } from '../../eval/runner/q1/cells/definitions.ts';
import { bundlePins, settledLeases, unitCell, type Publication } from '../../eval/runner/q1/publish.ts';

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
    expect(config.campaign_hash).toBe('43749abd1ebecd8b8e16b3d9f91401647f27e95f247d65339e7819eaedb1cfb6');
  });
  test('carries the A21 view on both LongMemEval-S sets and the found-and-fixed appendix for public-v2 gbrain', () => {
    const a21 = config.sensitivity.find(v => v.id === 'a21-repeated-sessions')!;
    expect(a21.sets).toEqual(['S4', 'S4-slice']);
    expect(a21.question_ids).toHaveLength(13);
    const appendix = config.sources.filter(s => s.appendix);
    expect(appendix).toHaveLength(1);
    expect(appendix[0].systems).toEqual(['gbrain-defaults']);
    expect(appendix[0].pins?.['gbrain-defaults']).toContain('7aa2caa0');
    expect(config.sources.find(s => !s.appendix && s.campaign.endsWith('public-v2.json'))?.exclude_systems).toEqual(['gbrain-defaults']);
  });
});
