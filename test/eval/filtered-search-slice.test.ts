import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ANCHOR_DAY, FILTER_CELLS, SOURCES, pageAttrs, quantile, unit } from '../../eval/runner/filtered-search-slice.ts';

const WORLD = join(import.meta.dir, '..', '..', 'eval', 'data', 'world-v1');
const slugs = readdirSync(WORLD).filter(f => f.endsWith('.json') && !f.startsWith('_'))
  .map(f => JSON.parse(readFileSync(join(WORLD, f), 'utf8')) as { slug: string; type: string })
  .map(p => ({ slug: p.slug, type: p.type }));

describe('filtered-search slice: seeded page attributes', () => {
  test('the same slug always gets the same attributes', () => {
    expect(pageAttrs('concepts/plg-motion')).toEqual(pageAttrs('concepts/plg-motion'));
    expect(unit('source', 'a')).not.toBe(unit('source', 'b'));
  });

  test('each filter keeps the share of world-v1 it is built for', () => {
    const pages = slugs.map(p => ({ ...pageAttrs(p.slug), type: p.type }));
    const count = (id: string) => pages.filter(FILTER_CELLS.find(c => c.id === id)!.passes).length;
    expect(pages.length).toBe(240);
    // Exact counts pin the seed: a change to the hash or the buckets changes every published selectivity.
    expect({
      none: count('none'), small: count('source-small'), large: count('source-large'), concept: count('type-one'),
      set: count('type-set'), d7: count('date-7d'), y1: count('date-1y'), combo: count('source-type'), tier: count('where-tier'),
    }).toEqual({ none: 240, small: 12, large: 144, concept: 30, set: 80, d7: 3, y1: 103, combo: 15, tier: 19 });
  });

  test('dates fall inside the windows the cells query', () => {
    for (const p of slugs) {
      const a = pageAttrs(p.slug);
      expect(a.date <= ANCHOR_DAY).toBe(true);
      expect([SOURCES.small, SOURCES.large, 'default']).toContain(a.source);
    }
    const d7 = FILTER_CELLS.find(c => c.id === 'date-7d')!;
    expect(d7.params).toEqual({ since: '2026-06-24', until: ANCHOR_DAY });
    expect(d7.passes({ source: 'default', type: 'person', date: '2026-06-24', tier: 'bronze' })).toBe(true);
    expect(d7.passes({ source: 'default', type: 'person', date: '2026-06-23', tier: 'bronze' })).toBe(false);
  });
});

describe('filtered-search slice: quantile', () => {
  test('nearest-rank percentiles', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(quantile(xs, 0.5)).toBe(50);
    expect(quantile(xs, 0.95)).toBe(95);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});
