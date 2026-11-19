import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ItemRow } from './score.ts';
import { BAR, bootstrap, pairRows, privacy, privacyRefusal, renderBar, shipBar } from './ship-bar.ts';

const row = (o: Partial<ItemRow>): ItemRow => ({
  schema: 'multi-evidence-item/1', suite: 'cat40-hard-m', kind: 'agent', item: 'H1-02', reader: 'claude-opus-5-5', arm: 'base', trial: 1, gbrain: { ref: 'v1', sha: 'a'.repeat(40) },
  category: null, question: null, expected: null, answer: null, gold: ['a/one', 'a/two'], retrieved: [], delivered: [], opened: [], cited: [], cut: null, coverage: 'some',
  turns: 10, turn_cap: 16, hit_cap: false, calls: 9, assemble_calls: 0, result_chars: 1000, page_chars: 400, slugs_calls: 0, slugs_multi: 0, omitted_calls: 0, setup: 'setup-a',
  correct: true, score: 1, stop: 'submitted', harness: null, cost_usd: 1, ...o,
});
const items = Array.from({ length: 24 }, (_, i) => `H1-${String(i).padStart(2, '0')}`);
const readers = ['claude-opus-5-5', 'gpt-6.2-sol'];
const SHA = 'b'.repeat(40);
const cand = (o: Partial<ItemRow>) => row({ gbrain: { ref: 'slugs', sha: SHA }, ...o });
const full = { gbrain: { version: '0.60.747.0', sha: SHA, dirty: false }, gbrain_at_end: { sha: SHA, dirty: false }, has_slugs: true, too_old: false, scenarios: ['s'] };

describe('ship bar', () => {
  test('the four thresholds are the ones written down before spend', () => {
    expect(BAR).toMatchObject({ slugsUseMet: 0.5, slugsUseNoShip: 0.2, pageReductionMet: 0.15, totalReductionMin: 0, correctMargin: 0.15, resamples: 10_000, seed: 108 });
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
    const c = items.flatMap((item, i) => readers.map(reader => cand({ item, reader, result_chars: 600, page_chars: 200, slugs_calls: i % 4 === 0 ? 0 : 1, slugs_multi: 1, omitted_calls: i === 1 ? 1 : 0 })));
    const r = shipBar(base, c, { base: 'b', candidate: 'c' }, null);
    expect(r.pairs).toBe(48);
    expect(r.bars.slugs_use.point).toBeCloseTo(0.75);
    expect(r.bars.slugs_use.verdict).toBe('met');
    expect(r.bars.output.page.point).toBeCloseTo(0.5);
    expect(r.bars.output.total.point).toBeCloseTo(0.4);
    expect(r.bars.output.verdict).toBe('met');
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
    expect(r.bars.output.total.point).toBeCloseTo(0.05);
    expect(r.bars.output.page.point).toBeCloseTo(0);
    expect(r.bars.output.verdict).toBe('not_met');
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
    expect(r.bars.output.total.point).toBeCloseTo(0.1);
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
    const before = cell('get_page', false, 'ok', 'world');
    const write = (cells: unknown[]) => { const p = join(dir, `c${Math.random()}.json`); writeFileSync(p, JSON.stringify({ ...full, cells: [{ ...before, phase: 'before' }, ...cells] })); return p; };
    expect(privacy(write([cell('get_page', false), cell('get_page_slugs', false), cell('get_page_unscoped', true, 'ok', 'world'), cell('get_page_slugs_unscoped', true, 'ok', 'world')]), SHA))
      .toMatchObject({ ok: true, cells: 5, violations: 0, slugs_cells: 2, slugs_reads: 1, slugs_only_reads: 0 });
    expect(privacy(write([cell('get_page', false), cell('get_page_slugs', true)]), SHA)).toMatchObject({ ok: false, slugs_only_reads: 1 });
    expect(privacy(write([cell('get_page', true, 'violation'), cell('get_page_slugs', true)]), SHA)).toMatchObject({ ok: false, violations: 1 });
    expect(privacy(write([cell('get_page', false)]), SHA)).toMatchObject({ ok: false, slugs_cells: 0 });
  });

  test('a privacy file is refused unless it is a full run on the candidate commit from a clean checkout', () => {
    const cells = [{ scenario: 's', phase: 'before' }, { scenario: 's', phase: 'after' }, { scenario: 't', phase: 'before' }, { scenario: 't', phase: 'after' }]
      .map(c => ({ ...c, caller: 'local', item: 'world', path: 'get_page', read: true, verdict: 'ok' }));
    const f = { ...full, scenarios: ['s', 't'], cells };
    expect(privacyRefusal(f, SHA)).toEqual([]);
    expect(privacyRefusal(f, 'c'.repeat(40)).join()).toContain(`it ran on ${SHA}, not the candidate`);
    expect(privacyRefusal({ ...f, gbrain: { version: '1', sha: SHA, dirty: true }, gbrain_at_end: { sha: SHA, dirty: true } }, SHA).join()).toContain('uncommitted changes');
    expect(privacyRefusal({ ...f, gbrain_at_end: { sha: 'c'.repeat(40), dirty: false } }, SHA).join()).toContain(`node_modules/gbrain changed during the run (${SHA} at the start, ${'c'.repeat(40)} at the end)`);
    expect(privacyRefusal({ ...f, gbrain_at_end: { sha: SHA, dirty: true } }, SHA).join()).toContain('changed during the run');
    expect(privacyRefusal({ ...f, gbrain_at_end: undefined }, SHA).join()).toContain('no commit recorded at the end');
    expect(privacyRefusal({ ...f, gbrain: { version: '1', sha: null, dirty: null } }, SHA).join()).toContain('records no gbrain commit');
    expect(privacyRefusal({ cells }, SHA).length).toBeGreaterThanOrEqual(3);
    expect(privacyRefusal({ ...f, has_slugs: false }, SHA).join()).toContain('skipped');
    expect(privacyRefusal({ ...f, cells: cells.slice(0, 3) }, SHA).join()).toContain('not a full run: no cells for 1 scenario phases, first t (after)');
    const dir = mkdtempSync(join(tmpdir(), 'ship-bar-'));
    writeFileSync(join(dir, 'p.json'), JSON.stringify({ ...f, scenarios: ['s', 't', 'u'] }));
    expect(() => privacy(join(dir, 'p.json'), SHA)).toThrow('not a full run');
    const base = items.flatMap(item => readers.map(reader => row({ item, reader })));
    const c = items.flatMap(item => readers.map(reader => cand({ item, reader, slugs_calls: 1 })));
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ ...f, gbrain: { version: '1', sha: 'a'.repeat(40), dirty: false } }));
    expect(() => shipBar(base, c, { base: 'b', candidate: 'c' }, join(dir, 'other.json'))).toThrow(`not the candidate ${SHA}`);
  });

  test('page reads must shrink by 15% and the total must not grow', () => {
    const base = items.flatMap(item => readers.map(reader => row({ item, reader })));
    const smaller = shipBar(base, items.flatMap(item => readers.map(reader => cand({ item, reader, slugs_calls: 1, page_chars: 300, result_chars: 1000 }))), { base: 'b', candidate: 'c' }, null);
    expect(smaller.bars.output.page.point).toBeCloseTo(0.25);
    expect(smaller.bars.output.total.point).toBeCloseTo(0);
    expect(smaller.bars.output.verdict).toBe('met');
    const larger = shipBar(base, items.flatMap(item => readers.map(reader => cand({ item, reader, slugs_calls: 1, page_chars: 300, result_chars: 1010 }))), { base: 'b', candidate: 'c' }, null);
    expect(larger.bars.output.total.point).toBeCloseTo(-0.01);
    expect(larger.bars.output.verdict).toBe('not_met');
    expect(renderBar(larger)).toContain('| 2b | Tool-result characters per cell');
  });

  test('pairs whose gold pages, turn cap or setup differ, or that record no setup, refuse the comparison', () => {
    const base = items.flatMap(item => readers.map(reader => row({ item, reader })));
    const c = (o: Partial<ItemRow>) => items.flatMap((item, i) => readers.map(reader => cand({ item, reader, slugs_calls: 1, ...(i === 3 && reader === readers[0] ? o : {}) })));
    expect(pairRows(base, c({})).mismatched).toEqual([]);
    expect(pairRows(base, c({ gold: ['a/one', 'a/three'] })).mismatched).toEqual(['cat40-hard-m|H1-03|claude-opus-5-5|1: gold pages']);
    expect(pairRows(base, c({ gold: ['a/two', 'a/one', 'a/one'] })).mismatched).toEqual([]);
    expect(pairRows(base, c({ turn_cap: 32 })).mismatched).toEqual(['cat40-hard-m|H1-03|claude-opus-5-5|1: turn cap 16 against 32']);
    expect(pairRows(base, c({ setup: 'setup-b' })).mismatched).toEqual(['cat40-hard-m|H1-03|claude-opus-5-5|1: setup']);
    expect(pairRows(base, c({ setup: null })).mismatched[0]).toContain('no setup recorded');
    expect(() => shipBar(base, c({ setup: 'setup-b' }), { base: 'b', candidate: 'c' }, null)).toThrow('1 pairs differ in gold pages, turn cap or setup');
  });

  test('an arm whose rows name two gbrain commits is refused', () => {
    const base = items.flatMap(item => readers.map(reader => row({ item, reader })));
    const c = items.flatMap((item, i) => readers.map(reader => cand({ item, reader, slugs_calls: 1, ...(i === 0 ? { gbrain: { ref: 'other', sha: 'c'.repeat(40) } } : {}) })));
    expect(() => shipBar(base, c, { base: 'b', candidate: 'c' }, null)).toThrow('the candidate rows name 2 gbrain commits');
  });
});
