import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ItemRow } from './score.ts';
import { BAR, bootstrap, pairRows, privacy, renderBar, shipBar } from './ship-bar.ts';

const row = (o: Partial<ItemRow>): ItemRow => ({
  schema: 'multi-evidence-item/1', suite: 'cat40-hard-m', kind: 'agent', item: 'H1-02', reader: 'claude-opus-5-5', arm: 'base', trial: 1, gbrain: { ref: 'v1', sha: 'a'.repeat(40) },
  category: null, question: null, expected: null, answer: null, gold: ['a/one', 'a/two'], retrieved: [], delivered: [], opened: [], cited: [], cut: null, coverage: 'some',
  turns: 10, turn_cap: 16, hit_cap: false, calls: 9, assemble_calls: 0, result_chars: 1000, slugs_calls: 0, slugs_multi: 0, omitted_calls: 0,
  correct: true, score: 1, stop: 'submitted', harness: null, cost_usd: 1, ...o,
});
const items = Array.from({ length: 24 }, (_, i) => `H1-${String(i).padStart(2, '0')}`);
const readers = ['claude-opus-5-5', 'gpt-6.2-sol'];
const cand = (o: Partial<ItemRow>) => row({ gbrain: { ref: 'slugs', sha: 'b'.repeat(40) }, ...o });

describe('ship bar', () => {
  test('the four thresholds are the ones written down before spend', () => {
    expect(BAR).toMatchObject({ slugsUseMet: 0.5, slugsUseNoShip: 0.2, charsReductionMet: 0.15, correctMargin: 0.15, resamples: 10_000, seed: 108 });
  });

  test('the bootstrap is deterministic and brackets its point estimate', () => {
    const units = items.map((item, i) => ({ item, x: i % 3 === 0 ? 1 : 0 }));
    const stat = (xs: typeof units) => xs.reduce((n, u) => n + u.x, 0) / xs.length;
    const a = bootstrap(units, stat, 2000), b = bootstrap(units, stat, 2000);
    expect(a).toEqual(b);
    expect(a.lo!).toBeLessThanOrEqual(a.point!);
    expect(a.hi!).toBeGreaterThanOrEqual(a.point!);
  });

  test('a clear win meets bars 1 to 3; bar 4 is incomplete without the privacy cells', () => {
    const base = items.flatMap(item => readers.map(reader => row({ item, reader })));
    const c = items.flatMap((item, i) => readers.map(reader => cand({ item, reader, result_chars: 600, slugs_calls: i % 4 === 0 ? 0 : 1, slugs_multi: 1, omitted_calls: i === 1 ? 1 : 0 })));
    const r = shipBar(base, c, { base: 'b', candidate: 'c' }, null);
    expect(r.pairs).toBe(48);
    expect(r.bars.slugs_use.point).toBeCloseTo(0.75);
    expect(r.bars.slugs_use.verdict).toBe('met');
    expect(r.bars.chars_reduction.point).toBeCloseTo(0.4);
    expect(r.bars.chars_reduction.verdict).toBe('met');
    expect(r.bars.correct_diff.point).toBe(0);
    expect(r.bars.correct_diff.verdict).toBe('met');
    expect(r.bars.privacy).toBeNull();
    expect(r.decision).toContain('incomplete: bar 4');
    expect(r.omitted_cells).toBe(2);
    expect(r.per_reader.map(x => x.reader)).toEqual(readers);
    expect(renderBar(r)).toContain('| 1 | Eligible cells using slugs | 75.0%');
  });

  test('slugs in under 20% of eligible cells does not ship; a big correctness drop fails bar 3', () => {
    const base = items.flatMap(item => readers.map(reader => row({ item, reader })));
    const c = items.flatMap((item, i) => readers.map(reader => cand({ item, reader, slugs_calls: i < 3 ? 1 : 0, correct: i % 2 === 0, result_chars: 950 })));
    const r = shipBar(base, c, { base: 'b', candidate: 'c' }, null);
    expect(r.bars.slugs_use.verdict).toBe('no_ship');
    expect(r.bars.chars_reduction.verdict).toBe('not_met');
    expect(r.bars.correct_diff.point).toBeCloseTo(-0.5);
    expect(r.bars.correct_diff.verdict).toBe('not_met');
    expect(r.decision).toContain('does not ship as is: bar 1');
  });

  test('pairs drop on a harness row or a missing transcript, and more than five drops make the run incomplete', () => {
    const base = items.flatMap(item => readers.map(reader => row({ item, reader })));
    const c = items.flatMap((item, i) => readers.map(reader => cand({ item, reader, slugs_calls: 1, harness: i < 3 && reader === readers[0] ? 'boom' : null, result_chars: i === 5 && reader === readers[1] ? null : 500 })));
    const p = pairRows(base, c);
    expect(p.pairs.length).toBe(44);
    expect(p.dropped.length).toBe(4);
    expect(shipBar(base, c, { base: 'b', candidate: 'c' }, null).bars.slugs_use.verdict).toBe('met');
    const worse = c.map((r, i) => (i < 6 ? { ...r, harness: 'boom' } : r));
    expect(shipBar(base, worse, { base: 'b', candidate: 'c' }, null).bars.slugs_use.verdict).toBe('incomplete');
  });

  test('only base-arm rows pair and count', () => {
    const base = [row({ result_chars: 1000 }), row({ arm: 'batch', result_chars: 100 })];
    const c = [cand({ result_chars: 900, slugs_calls: 1 }), cand({ arm: 'batch', result_chars: 900, slugs_calls: 1 })];
    const r = shipBar(base, c, { base: 'b', candidate: 'c' }, null);
    expect(r.pairs).toBe(1);
    expect(r.eligible_cells).toBe(1);
    expect(r.bars.chars_reduction.point).toBeCloseTo(0.1);
  });

  test('a base harness row, which carries no gold, is dropped rather than skipped', () => {
    const base = items.flatMap((item, i) => readers.map(reader => row({ item, reader, ...(i < 6 ? { gold: [], harness: 'boom' } : {}) })));
    const c = items.flatMap(item => readers.map(reader => cand({ item, reader, slugs_calls: 1 })));
    const r = shipBar(base, c, { base: 'b', candidate: 'c' }, null);
    expect(r.dropped.length).toBe(12);
    expect(r.dropped[0]).toContain('base harness: boom');
    expect(r.bars.slugs_use.verdict).toBe('incomplete');
  });

  test('items whose gold names fewer than two pages are not eligible', () => {
    const base = [row({ item: 'one', gold: ['a/one'] }), row({ item: 'two' })];
    const c = [cand({ item: 'one', gold: ['a/one'], slugs_calls: 0 }), cand({ item: 'two', slugs_calls: 1 })];
    const r = shipBar(base, c, { base: 'b', candidate: 'c' }, null);
    expect(r.eligible_cells).toBe(1);
    expect(r.bars.slugs_use.point).toBe(1);
  });

  test('privacy passes only when every cell is ok, the slugs paths ran, and no slugs read lacks a single read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-bar-'));
    const cell = (path: string, read: boolean, verdict = 'ok', item = 'private') => ({ scenario: 's', phase: 'after', caller: 'member_http', item, path, read, verdict });
    const write = (cells: unknown[]) => { const p = join(dir, `c${Math.random()}.json`); writeFileSync(p, JSON.stringify({ cells })); return p; };
    expect(privacy(write([cell('get_page', false), cell('get_page_slugs', false), cell('get_page_unscoped', true, 'ok', 'world'), cell('get_page_slugs_unscoped', true, 'ok', 'world')])))
      .toMatchObject({ ok: true, cells: 4, violations: 0, slugs_cells: 2, slugs_reads: 1, slugs_only_reads: 0 });
    expect(privacy(write([cell('get_page', false), cell('get_page_slugs', true)]))).toMatchObject({ ok: false, slugs_only_reads: 1 });
    expect(privacy(write([cell('get_page', true, 'violation'), cell('get_page_slugs', true)]))).toMatchObject({ ok: false, violations: 1 });
    expect(privacy(write([cell('get_page', false)]))).toMatchObject({ ok: false, slugs_cells: 0 });
  });
});
