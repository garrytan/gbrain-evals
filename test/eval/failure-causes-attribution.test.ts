/**
 * Attribution of the nightly QA misses (eval/runner/failure-causes/attribution.ts, decision D5a): every bucket is
 * reachable from labels built the way the nightly builds them (nightly outcome row, nightlyFailure, classify), a truncated
 * answer stays harness however its gold coverage reads, a stale cache row makes the whole attribution stale, and each
 * expectation fails against a mutant of the module. The nightly report's harness column is reconciled with the
 * harness_error cause on the same rows. Keyless: the cache rows are synthetic and nothing reaches a provider.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as real from '../../eval/runner/failure-causes/attribution.ts';
import { nightlyFailure } from '../../eval/runner/failure-causes/adapters/nightly.ts';
import { classify } from '../../eval/runner/failure-causes/classify.ts';
import { renderReport, summarize } from '../../eval/runner/failure-causes/report.ts';
import type { CauseLabel } from '../../eval/runner/failure-causes/types.ts';
import type { DevSet } from '../../eval/runner/nightly/devset.ts';
import { readOutcomes, type Outcome } from '../../eval/runner/nightly/outcome.ts';
import { cellStats } from '../../eval/runner/nightly/report.ts';
import type { AnswerClass } from '../../eval/runner/sota/answerability.ts';
import { CACHE_SCHEMA, OutcomeCache, type Row, type Spec } from '../../eval/runner/sota/cache.ts';
import { row } from './nightly-fixtures.ts';

type Module = typeof real;
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'sota-attribution-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const READER = 'anthropic:claude-opus-5-5';
const item = (id: string) => ({ id, role: 'headroom' as const });
const DEVSET: DevSet = {
  version: 2, readers: ['claude-opus-5-5'], k: { agent: 1, qa: 1, replay: 1, trials: 3, smoke: 1 }, reserved: [], digest: 'devset-test',
  suites: [
    { id: 'qa-a', kind: 'qa', scoring: 'judge', about: 'test', source: 'test', config: { benchmark: 'bench-x' },
      items: ['i-harness', 'i-trunc', 'i-trunc2', 'i-unsup', 'i-unsup-label', 'i-unres', 'i-noora', 'i-noverdict', 'i-rl', 'i-lost', 'i-partial', 'i-ctx', 'i-deliv', 'i-model', 'i-notrun', 'i-pass'].map(item) },
    { id: 'qa-b', kind: 'qa', scoring: 'judge', about: 'test', source: 'test', config: { benchmark: 'bench-x' }, items: [item('j-lost')] },
    { id: 'cat40-hard-m', kind: 'agent', scoring: 'deterministic', about: 'test', source: 'test', items: [item('t1')] },
  ],
};
const CLASSES = new Map<string, AnswerClass>([
  ...['i-harness', 'i-trunc', 'i-trunc2', 'i-noora', 'i-noverdict', 'i-rl', 'i-lost', 'i-ctx', 'i-deliv', 'i-model', 'i-notrun', 'i-pass', 'j-lost'].map(i => [i, 'supported'] as [string, AnswerClass]),
  ['i-partial', 'partial'], ['i-unsup', 'unsupported'], ['i-unres', 'unresolved'],
]);
const classes = (b: string) => (b === 'bench-x' ? CLASSES : null);

const spec = (kind: Spec['kind']): Spec => ({
  kind, benchmark: 'bench-x', system: kind === 'oracle' ? 'oracle' : 'grep-agent', reader: READER, system_version: 'code-0001', effort: null, max_tokens: 8192,
  judge: 'openai:gpt-6-astra', judge_prompt: 'prompt-0001', pass_threshold: 0.5, dataset: 'bench-x-0001', validator_version: 'answerability-0001', harness_digest: 'harness-0001',
});
const specs = { oracle: (b: string, r: string) => (b === 'bench-x' && r === READER ? spec('oracle') : null), leader: (b: string, r: string) => (b === 'bench-x' && r === READER ? spec('leader') : null) };
const cacheRow = (s: Spec, id: string, pass: boolean | null, patch: Partial<Row> = {}): Row => ({
  ...s, schema: CACHE_SCHEMA, item: id, context_digest: `ctx-${id}`, score: pass === null ? null : pass ? 1 : 0, pass, finish_reason: pass === null ? 'max_tokens' : 'stop',
  usage: { reader_input: 10_000, reader_output: 500, judge_input: 2_000, judge_output: 50 }, at: '2026-11-20T09:00:00Z', source: 'test', ...patch,
});
const ORACLE: Array<[string, boolean | null]> = [['i-harness', true], ['i-trunc', true], ['i-trunc2', true], ['i-noverdict', null], ['i-rl', false], ['i-lost', true],
  ['i-partial', true], ['i-ctx', true], ['i-deliv', true], ['i-model', true], ['j-lost', true]];
const LEADER: Array<[string, boolean]> = [['i-lost', true], ['i-rl', true], ['i-ctx', false]];
function cache(patch: Record<string, Partial<Row>> = {}): string {
  const dir = scratch();
  const c = new OutcomeCache(dir);
  c.put(ORACLE.map(([i, p]) => cacheRow(spec('oracle'), i, p, patch[i])));
  c.put(LEADER.map(([i, p]) => cacheRow(spec('leader'), i, p)));
  return dir;
}

const gold = (retrieved: Outcome['retrieved'], delivered: Outcome['delivered']): Partial<Outcome> => ({ gold_count: 2, retrieved, delivered });
const out = (id: string, o: Partial<Outcome> = {}): Outcome => row({ suite: 'qa-a', item: id, reader: 'claude-opus-5-5', ...gold('all', 'all'), ...o });
const label = (o: Outcome, patch: Partial<CauseLabel> = {}): CauseLabel => ({ ...classify(nightlyFailure(o, `nightly-${o.suite}`, [])), ...patch });
const NIGHT2 = '2026-11-10';
function labels(): CauseLabel[] {
  return [
    label(out('i-harness', { harness: { error: 'provider 529' } })),
    label(out('i-trunc', { finish_reason: 'max_tokens', ...gold('none', 'none') })),
    label(out('i-trunc2', { finish_reason: 'length' })),
    label(out('i-unsup')),
    label(out('i-unsup-label'), { cause: 'item_unsupported', rule_id: 'harness.item_unsupported_by_both_validators' }),
    label(out('i-unres')),
    label(out('i-noora')),
    label(out('i-noverdict')),
    label(out('i-rl', gold('none', 'none'))),
    label(out('i-lost', gold('none', 'none'))),
    label(out('i-partial', gold('partial', 'partial'))),
    label(out('i-ctx')),
    label(out('i-deliv', gold('all', null))),
    label(out('i-model', { ...gold('all', null), question: 'q', answer: 'a', expected: 'e', context: 'c' }), { basis: 'model', cause: 'time_reasoning', rule_id: 'model' }),
    label(out('i-notrun', { skipped: 'budget' })),
    label(out('i-pass', { pass: true, score: 1 })),
    label(out('i-lost', { night: NIGHT2, ...gold('none', 'none') })),
    label(out('j-lost', { suite: 'qa-b', ...gold('none', 'none') })),
    label(row({ suite: 'cat40-hard-m', item: 't1', reader: 'claude-opus-5-5', agent_loop: true })),
    label(row({ suite: 'cat40-hard-m', item: 't1', reader: 'claude-opus-5-5', trial: 2, skipped: 'budget' })),
    label(row({ suite: 'mystery', item: 'x', reader: 'claude-opus-5-5' })),
  ];
}

const EXPECTED: Record<string, real.Bucket> = {
  'i-harness': 'harness', 'i-trunc': 'harness', 'i-trunc2': 'harness', 'i-unsup': 'unsupported', 'i-unsup-label': 'unsupported', 'i-unres': 'unknown',
  'i-noora': 'unknown', 'i-noverdict': 'unknown', 'i-rl': 'reader_limited', 'i-lost': 'retrieval_lost', 'i-partial': 'retrieval_lost', 'i-ctx': 'context_use',
  'i-deliv': 'unknown', 'i-model': 'context_use', 'j-lost': 'retrieval_lost',
};

/** Every expectation on one module; throws on the first that fails. */
function check(m: Module): void {
  const a = m.attribute(labels(), { cacheDir: cache(), specs, devset: DEVSET, classes });
  expect(a.status).toBe('ok');
  const got = Object.fromEntries(a.rows.map(r => [r.item, r.bucket]));
  expect(got).toEqual(EXPECTED);
  expect(new Set(Object.values(got))).toEqual(new Set(m.BUCKETS));
  expect(a.rows.filter(r => r.item === 'i-lost').map(r => r.run_id.split('|')[0])).toEqual(['2026-11-09', NIGHT2]);
  for (const id of ['i-trunc', 'i-trunc2']) expect(a.rows.find(r => r.item === id)).toMatchObject({ bucket: 'harness', cause: 'harness_error', rule_id: 'harness.output_truncated', oracle: 'pass' });
  expect(Object.fromEntries(a.rows.filter(r => r.reason).map(r => [r.item, r.reason]))).toEqual({
    'i-unres': 'answerability unresolved', 'i-noora': 'no oracle row', 'i-noverdict': 'oracle answer has no verdict', 'i-deliv': 'gold delivery not measured' });
  expect(Object.fromEntries(a.rows.filter(r => r.leader_solved !== null).map(r => [`${r.item}|${r.run_id.split('|')[0]}`, r.leader_solved]))).toEqual({
    'i-rl|2026-11-09': true, 'i-lost|2026-11-09': true, [`i-lost|${NIGHT2}`]: true, 'i-ctx|2026-11-09': false });
  expect(a.outside).toBe(2);

  const qaA = a.cells.find(c => c.suite === 'qa-a')!;
  expect(qaA).toMatchObject({ reader: READER, nights: 2, pool_answerable: 13, not_run: 1, harness: 3, answerable_rows: 22 });
  expect(qaA.rows).toEqual({ harness: 3, unsupported: 2, reader_limited: 1, retrieval_lost: 3, context_use: 2, unknown: 4 });
  expect(qaA.points).toEqual({ harness: null, unsupported: null, reader_limited: 4.55, retrieval_lost: 13.64, context_use: 9.09, unknown: null });
  expect(qaA.leader_solved).toMatchObject({ reader_limited: 1, retrieval_lost: 2, context_use: 0 });
  expect(a.cells.find(c => c.suite === 'qa-b')).toMatchObject({ nights: 1, pool_answerable: 1, answerable_rows: 1, points: { retrieval_lost: 100 } });

  const dir = cache({ 'i-rl': { judge: 'openai:gpt-6-astra-old' } });
  const s = m.attribute(labels(), { cacheDir: dir, specs, devset: DEVSET, classes });
  expect(s).toMatchObject({ status: 'stale', cells: [], rows: [] });
  expect(s.stale).toHaveLength(1);
  expect(s.stale[0]!.message).toStartWith('SOTA_CACHE_STALE: 1 oracle row for bench-x, system oracle, reader anthropic:claude-opus-5-5');
  expect(s.stale[0]!.message).toContain('changed judge: openai:gpt-6-astra-old -> openai:gpt-6-astra (1 rows)');
  expect(s.stale[0]!.message).toContain('PAID WINDOW REQUEST SOTA-REBUY-ORACLE-BENCH-X');
  expect(readFileSync(join(dir, 'rebuy', 'sota-rebuy-oracle-bench-x-oracle-anthropic_claude-opus-5-5.txt'), 'utf8')).toBe('i-rl\n');
}

const SOURCE = readFileSync(resolve(import.meta.dir, '../../eval/runner/failure-causes/attribution.ts'), 'utf8');
const DIR = resolve(import.meta.dir, '../../eval/runner/failure-causes');
const MUTANTS: Array<[string, string, string]> = [
  ['harness not first', "if (l.cause === 'harness_error') put('harness');\n      else ", ''],
  ['label over class', "cls === 'unsupported' || (cls === null && l.cause === 'item_unsupported')", "l.cause === 'item_unsupported'"],
  ['missing oracle guessed', "else if (!o) put('unknown', 'no oracle row');", "else if (!o) put('context_use');"],
  ['no verdict as a fail', "else if (o.pass === null) put('unknown', 'oracle answer has no verdict');\n      ", ''],
  ['cause before oracle', "else if (!o.pass) put('reader_limited');\n      else if (l.cause && LOST_CAUSES.has(l.cause)) put('retrieval_lost');",
    "else if (l.cause && LOST_CAUSES.has(l.cause)) put('retrieval_lost');\n      else if (!o.pass) put('reader_limited');"],
  ['delivery guessed', "else if (l.basis !== 'model' && l.unmeasured.includes('ranking')) put('unknown', 'gold delivery not measured');\n      ", ''],
  ['model label ignored', "l.basis !== 'model' && l.unmeasured.includes('ranking')", "l.unmeasured.includes('ranking')"],
  ['harness in the denominator', 'const answerable = pool * nights - notRun - harness;', 'const answerable = pool * nights - notRun;'],
  ['not-run in the denominator', 'const answerable = pool * nights - notRun - harness;', 'const answerable = pool * nights - harness;'],
  ['leader ignored', 'leader_solved: lr ? lr.pass === true : null', 'leader_solved: null'],
  ['stale ignored', 'if (stale.length) return', 'if (stale.length < 0) return'],
  ['first cell picks the items', 'for (const x of xs) if (failedLabel(x.l)) w.items.add(x.c.item);', 'if (!wanted.has(JSON.stringify(spec))) for (const x of xs) if (failedLabel(x.l)) w.items.add(x.c.item);'],
];

describe('attribution', () => {
  test('every bucket is reachable, with its points, nights and denominator', () => check(real));

  test('the buckets are the taxonomy\'s, in order', () => {
    expect(real.BUCKETS).toEqual(['harness', 'unsupported', 'reader_limited', 'retrieval_lost', 'context_use', 'unknown']);
    expect(real.RECOVERABLE).toEqual(['reader_limited', 'retrieval_lost', 'context_use']);
  });

  test('a truncated answer is harness whatever its coverage and oracle say', () => {
    const dir = cache();
    for (const [retrieved, delivered] of [['none', 'none'], ['partial', 'partial'], ['all', 'all'], ['all', null]] as const) for (const finish of ['length', 'max_tokens', 'max_output_tokens']) {
      const a = real.attribute([label(out('i-lost', { finish_reason: finish, ...gold(retrieved, delivered) }))], { cacheDir: dir, specs, devset: DEVSET, classes });
      expect(a.rows.map(r => r.bucket)).toEqual(['harness']);
    }
  });

  test.each(MUTANTS)('fails against the mutant: %s', async (name, from, to) => {
    expect(SOURCE.split(from).length).toBe(2);
    const dir = scratch();
    const path = join(dir, `attribution-${name.replace(/\W+/g, '-')}.ts`);
    writeFileSync(path, SOURCE.replace(from, to).replace(/from '(\.\.?\/[^']+)'/g, (_, rel: string) => `from '${resolve(DIR, rel)}'`));
    const mutant = await import(path) as Module;
    let failure: unknown = null;
    try { check(mutant); } catch (e) { failure = e; }
    expect(String(failure)).toMatch(/expect\(/);
  });

  test('the attribution file and the report section', () => {
    const a = real.attribute(labels(), { cacheDir: cache(), specs, devset: DEVSET, classes });
    const dir = scratch();
    writeFileSync(join(dir, 'attribution.json'), real.attributionText(a, join(dir, 'attribution.json')));
    expect(JSON.parse(readFileSync(join(dir, 'attribution.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(a)));
    const md = renderReport(summarize(labels()), { heading: 'Week', attribution: a });
    expect(md.indexOf('## Attribution')).toBeGreaterThan(0);
    expect(md.indexOf('## Attribution')).toBeLessThan(md.indexOf('## Under stress'));
    expect(md).toContain('| qa-a | anthropic:claude-opus-5-5 | 22 | 3 | 2 | 1 (4.5 pts) | 3 (13.6 pts) | 2 (9.1 pts) | 4 | 3 |');
    expect(md).toContain('2 failed rows of suites with no oracle in v1');
    const stale = real.attribute(labels(), { cacheDir: cache({ 'i-rl': { dataset: 'bench-x-0000' } }), specs, devset: DEVSET, classes });
    const smd = renderReport(summarize(labels()), { heading: 'Week', attribution: stale });
    expect(smd).toContain('## Attribution (stale)');
    expect(smd).toContain('    SOTA_CACHE_STALE: 1 oracle row for bench-x');
    expect(smd).not.toContain('| qa-a |');
  });
});

describe('the nightly harness column and the harness_error cause agree', () => {
  test('on the same rows, read back as the nightly report reads them', () => {
    const rows: Outcome[] = [
      row({ item: 'qa-harness', harness: { error: 'provider 529' } }),
      row({ item: 'qa-harness-judged-pass', pass: true, score: 1, harness: { error: 'provider 529' } }),
      row({ item: 'truncated', finish_reason: 'max_tokens' }),
      row({ item: 'truncated-passed', finish_reason: 'length', pass: true, score: 1 }),
      row({ item: 'agent-error', agent_loop: true, stop: 'error', harness: { error: 'error: loop crashed' } }),
      row({ item: 'pass', pass: true, score: 1 }),
      row({ item: 'fail', ...gold('none', 'none') }),
      row({ item: 'skipped', skipped: 'budget' }),
    ];
    const dir = scratch();
    writeFileSync(join(dir, 'outcomes.jsonl'), rows.map(r => JSON.stringify({ ...r, harness: r.harness ?? null })).join('\n') + '\n');
    const read = readOutcomes(join(dir, 'outcomes.jsonl'));
    const causes = read.map(r => classify(nightlyFailure(r, 'nightly-suite-a', [])));
    const harnessErrors = causes.filter(l => l.cause === 'harness_error').length;
    expect(harnessErrors).toBe(5);
    expect(cellStats('suite-a', 'gpt-6.1-sol', read, 1).harness).toBe(harnessErrors);
    expect(cellStats('suite-a', 'gpt-6.1-sol', read, 1).failures_by_cause.harness_error).toBe(harnessErrors);
  });
});
