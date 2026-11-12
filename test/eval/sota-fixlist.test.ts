/**
 * The weekly fix list (eval/runner/sota/fixlist.ts): at most three items ranked by recoverable points among rows the
 * oracle or the leader solved, never a cause that isn't gbrain's, changed only when the ranking moves or a fix lands, and
 * nothing filed from a stale attribution. Keyless: the attribution is synthetic.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTRIBUTION_SCHEMA, BUCKETS, type Attribution, type AttributedRow, type Bucket, type Cell } from '../../eval/runner/failure-causes/attribution.ts';
import { TAXONOMY_VERSION } from '../../eval/runner/failure-causes/taxonomy.ts';
import { eligible, fixList, FIXLIST_SCHEMA, main, MAX_ITEMS, type Fix } from '../../eval/runner/sota/fixlist.ts';

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'sota-fixlist-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const READER = 'anthropic:claude-opus-5-5';
let n = 0;
const r = (bucket: Bucket, cause: string | null, o: Partial<AttributedRow> = {}): AttributedRow => {
  const item = o.item ?? `i-${++n}`, suite = o.suite ?? 'beam-1m-hard', reader = o.reader ?? READER;
  return { run_id: '2026-11-23|master|' + 'a'.repeat(40), case_id: `${suite}|${item}|claude-opus-5-5|t1`, suite, item, reader, cause, rule_id: 'rule', bucket, reason: null,
    oracle: bucket === 'reader_limited' ? 'fail' : 'pass', leader_solved: null, visibility: 'public', evidence: [`nightly:${item}#line=1`], ...o };
};
const zero = <T,>(v: T) => Object.fromEntries(BUCKETS.map(b => [b, v])) as Record<Bucket, T>;
const cell = (suite: string, answerable: number, reader = READER): Cell => ({ suite, reader, nights: 1, pool_answerable: answerable, not_run: 0, harness: 0, answerable_rows: answerable,
  rows: zero(0), points: zero<number | null>(null), leader_solved: zero(0) });
const attribution = (rows: AttributedRow[], cells = [cell('beam-1m-hard', 100), cell('lme-s-hard', 50)]): Attribution =>
  ({ schema: ATTRIBUTION_SCHEMA, taxonomy_version: TAXONOMY_VERSION, status: 'ok', devset: 'devset-test', stale: [], outside: 0, cells, rows });

const rows = () => [
  ...Array.from({ length: 6 }, () => r('retrieval_lost', 'wrong_ranking', { leader_solved: true })),
  ...Array.from({ length: 4 }, () => r('retrieval_lost', 'partial_evidence', { suite: 'lme-s-hard' })),
  ...Array.from({ length: 3 }, () => r('context_use', 'time_reasoning')),
  r('context_use', 'stale_fact'),
  r('reader_limited', 'wrong_entity', { leader_solved: true }),
  ...Array.from({ length: 9 }, () => r('reader_limited', 'wrong_entity', { leader_solved: false })),
  ...Array.from({ length: 9 }, () => r('retrieval_lost', 'reader_budget')),
  ...Array.from({ length: 9 }, () => r('context_use', 'unclassified')),
  ...Array.from({ length: 9 }, () => r('context_use', 'model_error')),
  ...Array.from({ length: 9 }, () => r('context_use', null)),
  ...Array.from({ length: 9 }, () => r('harness', 'harness_error')),
  ...Array.from({ length: 9 }, () => r('unsupported', 'item_unsupported')),
  ...Array.from({ length: 9 }, () => r('unknown', 'retrieval_miss', { oracle: null, leader_solved: true })),
];
const FIX: Fix = { issue: 'GST-2358', pr: 'gbrain#9120', gbrain_version: '0.60.660.0', suite: 'beam-1m-hard', items: ['i-1'] };

describe('fix list', () => {
  test('only rows someone solved, with a cause that is gbrain\'s, enter', () => {
    expect(eligible(r('retrieval_lost', 'wrong_ranking'))).toBe(true);
    expect(eligible(r('context_use', 'time_reasoning'))).toBe(true);
    expect(eligible(r('reader_limited', 'wrong_entity'))).toBe(false);
    expect(eligible(r('reader_limited', 'wrong_entity', { leader_solved: true }))).toBe(true);
    for (const cause of ['harness_error', 'item_unsupported', 'reader_budget', 'model_error', 'unclassified', null]) expect(eligible(r('retrieval_lost', cause, { leader_solved: true }))).toBe(false);
    for (const bucket of ['harness', 'unsupported', 'unknown'] as const) expect(eligible(r(bucket, 'retrieval_miss', { leader_solved: true }))).toBe(false);
  });

  test('at most three items, ranked by points over every cell, each in the weekly issue shape', () => {
    const f = fixList(attribution(rows()), [], null);
    expect(f).toMatchObject({ schema: FIXLIST_SCHEMA, status: 'ok', changed: true, why: ['first fix list'] });
    expect(f.items).toHaveLength(MAX_ITEMS);
    expect(f.ranking).toEqual(['sota:retrieval_lost:partial_evidence', 'sota:retrieval_lost:wrong_ranking', 'sota:context_use:time_reasoning']);
    const [pe, wr, tr] = f.items;
    expect(pe).toMatchObject({ points: 4, rows: 4, items: 4, leader_solved: 0, oracle_solved: 4, cells: [{ suite: 'lme-s-hard', rows: 4, answerable_rows: 50, points: 8 }] });
    expect(wr).toMatchObject({ points: 3, rows: 6, leader_solved: 6, cells: [{ suite: 'beam-1m-hard', rows: 6, answerable_rows: 100, points: 6 }] });
    expect(tr!.points).toBe(1.5);
    expect(wr!.prediction).toEqual({ rule: 'held-out bucket share × success on own dev items × 0.5', held_out_share: null, success_rate: null, prior: 0.5, dev_bound_points: 1.5, points: null });
    expect(wr!.examples).toHaveLength(5);
    expect(wr!.examples.every(e => e.leader_solved)).toBe(true);
    expect(wr!.title).toBe('Wrong ranking (retrieval lost): up to 3.0 points over 6 failed rows');
    for (const line of ['**Fix target:**', '**Recoverable points:** up to 3.0 pass-rate points, the mean over 2 QA suite and reader cells', '**Shown solvable:** the benchmark\'s leader solved 6 of 6 rows',
      '**Prediction (D6a):**', '**Examples (public or synthetic):**', '**Keyless gbrain test shape:** A ranking test', 'Signature: `sota:retrieval_lost:wrong_ranking`']) expect(wr!.body).toContain(line);
  });

  test('a reader-limited row enters only through the leader, and ties break on leader-solved rows', () => {
    const f = fixList(attribution([r('reader_limited', 'wrong_entity', { leader_solved: true }), r('context_use', 'stale_fact'), ...Array.from({ length: 5 }, () => r('reader_limited', 'time_reasoning'))]), [], null);
    expect(f.ranking).toEqual(['sota:reader_limited:wrong_entity', 'sota:context_use:stale_fact']);
    expect(f.items[0]).toMatchObject({ rows: 1, leader_solved: 1, oracle_solved: 0 });
  });

  test('an unchanged ranking is unchanged even when the points move', () => {
    const first = fixList(attribution(rows()), [FIX], null);
    const again = fixList(attribution([...rows(), r('retrieval_lost', 'wrong_ranking')]), [FIX], first);
    expect(again.items[1]!.points).toBe(3.5);
    expect(again).toMatchObject({ changed: false, why: [], ranking: first.ranking, fixes_seen: ['GST-2358|gbrain#9120'] });
  });

  test('a landed fix changes it, and so does a moved ranking', () => {
    const first = fixList(attribution(rows()), [], null);
    expect(fixList(attribution(rows()), [FIX], first)).toMatchObject({ changed: true, why: ['fix landed: GST-2358 (gbrain#9120, gbrain 0.60.660.0)'], ranking: first.ranking });
    const moved = fixList(attribution([...rows(), ...Array.from({ length: 5 }, () => r('retrieval_lost', 'wrong_ranking'))]), [], first);
    expect(moved.changed).toBe(true);
    expect(moved.why).toEqual([`ranking moved: ${first.ranking.join(', ')} -> sota:retrieval_lost:wrong_ranking, sota:retrieval_lost:partial_evidence, sota:context_use:time_reasoning`]);
  });

  test('a stale attribution files nothing and carries the last filed list', () => {
    const first = fixList(attribution(rows()), [FIX], null);
    const stale = fixList({ ...attribution([]), status: 'stale' }, [FIX, { ...FIX, issue: 'GST-9999', pr: 'gbrain#1' }], first);
    expect(stale).toMatchObject({ status: 'stale', changed: false, items: [], ranking: first.ranking, fixes_seen: first.fixes_seen, why: ['attribution is stale: nothing filed'] });
    expect(fixList(attribution(rows()), [FIX, { ...FIX, issue: 'GST-9999', pr: 'gbrain#1' }], stale).why).toEqual(['fix landed: GST-9999 (gbrain#1, gbrain 0.60.660.0)']);
  });

  test('private rows give no examples', () => {
    const f = fixList(attribution([r('retrieval_lost', 'wrong_ranking', { visibility: 'private' })]), [], null);
    expect(f.items[0]!.examples).toEqual([]);
    expect(f.items[0]!.body).toContain('- none from a public or synthetic source this week');
  });

  test('the command writes the file and reads the previous one', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'attribution.json'), JSON.stringify(attribution(rows())));
    writeFileSync(join(dir, 'fixes.json'), JSON.stringify({ fixes: [] }));
    const logs: string[] = [];
    expect(main(['--attribution', join(dir, 'attribution.json'), '--fixes', join(dir, 'fixes.json'), '--out', join(dir, 'week1.json')], s => logs.push(s))).toBe(0);
    expect(main(['--attribution', join(dir, 'attribution.json'), '--fixes', join(dir, 'fixes.json'), '--previous', join(dir, 'week1.json'), '--out', join(dir, 'week2.json')], s => logs.push(s))).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'week1.json'), 'utf8')).changed).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'week2.json'), 'utf8'))).toMatchObject({ changed: false, ranking: JSON.parse(readFileSync(join(dir, 'week1.json'), 'utf8')).ranking });
    expect(JSON.parse(logs[1]!)).toMatchObject({ status: 'ok', changed: false, why: [] });
    expect(() => main(['--attribution', join(dir, 'attribution.json'), '--fixes', join(dir, 'fixes.json'), '--previous', join(dir, 'missing.json'), '--out', join(dir, 'x.json')])).toThrow('does not exist');
    expect(() => main(['--attribution', join(dir, 'attribution.json'), '--fixes', join(dir, 'fixes.json'), '--previous', join(dir, 'attribution.json'), '--out', join(dir, 'x.json')])).toThrow('is not a sota-fixlist/1 file');
  });

  test('the committed fixes file reads as fixes', () => {
    const f = JSON.parse(readFileSync(join(import.meta.dir, '../../eval/data/nightly/fixes.json'), 'utf8')) as { fixes: Fix[] };
    expect(Array.isArray(f.fixes)).toBe(true);
  });
});
