/**
 * The nightly report (eval/runner/nightly/report.ts): pass^k and cost per correct answer, and the diff against an earlier
 * night with its flags, on fixture nights: a pass-rate drop, strong flips, a deterministic signal, a cost rise, a changed
 * suite digest, a suite the ref skipped, harness and skipped rows kept out of every rate, failures counted by the
 * failure-cause taxonomy, and particle-1's per-item agreement with claude-opus-5-5 (raw agreement and Cohen's kappa).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { TAXONOMY_VERSION } from '../../eval/runner/failure-causes/index.ts';
import type { Outcome } from '../../eval/runner/nightly/outcome.ts';
import { cellStats, compareNights, findPreviousNight, nightAgreement, passHatK, writeReport, type NightManifest, type SuiteStatus } from '../../eval/runner/nightly/report.ts';
import { row } from './nightly-fixtures.ts';

const manifest = (suites: Array<Partial<SuiteStatus> & { id: string }>, o: Partial<NightManifest> = {}): NightManifest => ({
  schema: 'nightly-night/1', night: '2026-11-09', ref: 'master', sha: 'b'.repeat(40), version: '0.60.620.0', tier: 'nightly', fake: false,
  devset: { path: 'eval/data/nightly/devset-v1.json', digest: 'devset' }, started_at: '2026-11-09T09:00:00Z',
  suites: suites.map(s => ({ digest: 'digest-a', k: 3, readers: ['gpt-6.1-sol'], status: 'ran', ...s })), ...o,
});

/** k trials per item; passes[i] is how many of item i's trials pass. */
const trials = (passes: number[], k = 3, o: Partial<Outcome> = {}) => passes.flatMap((c, i) => Array.from({ length: k }, (_, t) =>
  row({ item: `item-${i}`, trial: t + 1, pass: t < c, score: t < c ? 1 : 0, cost_usd: 0.5, ...o })));

describe('pass^k and cost per correct answer', () => {
  test('tau-bench pass^k: C(c,k)/C(n,k) per item, null below k trials', () => {
    expect(passHatK(3, 3, 3)).toBe(1);
    expect(passHatK(2, 3, 3)).toBe(0);
    expect(passHatK(2, 3, 1)).toBeCloseTo(2 / 3, 10);
    expect(passHatK(3, 4, 2)).toBeCloseTo(0.5, 10);
    expect(passHatK(1, 2, 3)).toBeNull();
  });

  test('a cell: pass^1 and pass^k averaged over items, harness rows counted apart and out of every rate, cost per correct over passing rows', () => {
    const rows = [...trials([3, 2, 0]), row({ item: 'item-3', pass: false, cost_usd: 0.5, harness: { error: 'provider 529' } })];
    const c = cellStats('suite-a', 'gpt-6.1-sol', rows, 3);
    expect(c.items).toBe(3);
    expect(c.trials).toBe(9);
    expect(c.harness).toBe(1);
    expect(c.pass1).toBeCloseTo((1 + 2 / 3 + 0) / 3, 10);
    expect(c.passk).toBeCloseTo(1 / 3, 10);
    expect(c.passes).toBe(5);
    expect(c.cost_usd).toBeCloseTo(5, 10);
    expect(c.cost_per_correct).toBeCloseTo(1, 10);
    expect(c.signals.harness_errors).toBe(1);
    expect(c.failures_by_cause).toEqual({ unclassified: 4, harness_error: 1 });
  });

  test('failures by cause use the failure-cause taxonomy, and a skipped row is out of every rate and count, counted as not run', () => {
    const rows = [row({ item: 'item-0', writes: { lost: ['F3'], stuck: null, overwritten: null, duplicated: [] } }), row({ item: 'item-1', gold_count: 1, retrieved: 'none' }),
      row({ item: 'item-2', pass: true, score: 1 }), row({ item: 'item-3', skipped: 'postgres trials need --pg-admin <url>' })];
    const c = cellStats('suite-a', 'gpt-6.1-sol', rows, 1);
    expect(c.failures_by_cause).toEqual({ write_integrity: 1, retrieval_miss: 1 });
    expect([c.items, c.trials, c.harness, c.skipped, c.pass1]).toEqual([3, 3, 0, 1, 1 / 3]);
  });
});

describe('the diff against an earlier night', () => {
  const previous = { manifest: manifest([{ id: 'suite-a' }], { night: '2026-11-08', sha: 'a'.repeat(40) }), rows: trials(Array(20).fill(3)) };

  test('a pass-rate drop of at least 5 points whose interval excludes zero is flagged, with the strong flips named (cost unrecorded, so no cost flag)', () => {
    const tonight = { manifest: manifest([{ id: 'suite-a' }]), rows: trials([...Array(14).fill(3), ...Array(6).fill(0)], 3, { cost_usd: null }) };
    const c = compareNights(tonight, previous, 'previous');
    expect(c.flags.map(f => f.kind).sort()).toEqual(['pass_rate', 'strong_flip']);
    expect(c.flags.find(f => f.kind === 'strong_flip')!.items).toEqual(['item-14', 'item-15', 'item-16', 'item-17', 'item-18', 'item-19']);
    expect(c.suites[0]).toMatchObject({ suite: 'suite-a', compared: true, pass_diff: { mean: -0.3, items: 20 } });
  });

  test('a drop under 5 points, or one whose interval reaches zero, is not flagged', () => {
    const one = { manifest: manifest([{ id: 'suite-a' }]), rows: trials([...Array(19).fill(3), 2]) };
    expect(compareNights(one, previous, 'previous').flags).toEqual([]);
  });

  test('any rise in a deterministic signal is flagged: refusals, harness errors, lost writes', () => {
    const refused = [{ tool: 'put_page', code: 'worktree_refreshing', refused: true }];
    const rows = trials(Array(20).fill(3)).map((r, i) => (i === 0 ? { ...r, tool_errors: refused } : i === 1 ? { ...r, evidence: { kind: 'write', duplicated: ['F1'] } } : r));
    rows.push(row({ item: 'item-0', trial: 4, harness: { error: 'provider 529' } }));
    const c = compareNights({ manifest: manifest([{ id: 'suite-a' }]), rows }, previous, 'previous');
    expect(c.flags.map(f => f.detail).sort()).toEqual(['harness errors rose from 0 to 1', 'lost writes rose from 0 to 1', 'refusals rose from 0 to 1']);
    expect(c.flags.every(f => f.kind === 'signal')).toBe(true);
  });

  test('harness rows stay out of the pass rate: a night whose extra rows all failed on the provider has no pass-rate flag', () => {
    const rows = [...trials(Array(20).fill(3)), ...Array.from({ length: 20 }, (_, i) => row({ item: `item-${i}`, trial: 4, harness: { error: 'network' } }))];
    const c = compareNights({ manifest: manifest([{ id: 'suite-a' }]), rows }, previous, 'previous');
    expect(c.flags.map(f => f.kind)).toEqual(['signal']);
    expect(c.suites[0]!.pass_diff!.mean).toBe(0);
  });

  test('an answer cut off at its output limit is a harness row, on an older night\'s rows too: out of the pass rate, no drop or strong flip, harness_error by cause', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-report-'));
    const write = (night: string, rows: Outcome[]) => {
      const dir = join(root, night, 'master');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'night.json'), JSON.stringify(manifest([{ id: 'suite-a' }], { night })));
      writeFileSync(join(dir, 'outcomes.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      return dir;
    };
    const prev = write('2026-11-08', trials(Array(20).fill(3), 3, { cost_usd: null }));
    const cut = trials([...Array(14).fill(3), ...Array(6).fill(0)], 3, { cost_usd: null }).map((r, i) => (!r.pass || i === 0 ? { ...r, finish_reason: 'max_tokens' } : r));
    const summary = writeReport({ dir: write('2026-11-09', cut), previous: prev });
    expect(summary.flags).toEqual([expect.objectContaining({ kind: 'signal', detail: 'harness errors rose from 0 to 19' })]);
    expect((summary.suites as Array<{ cells: Array<Record<string, unknown>> }>)[0]!.cells[0]).toMatchObject({ items: 14, trials: 41, pass1: 1, harness: 19, failures_by_cause: { harness_error: 19 } });
    expect(summary.harness_rows).toBe(19);
  });

  test('cost per correct answer up 25% or more with no pass-rate gain is flagged', () => {
    const c = compareNights({ manifest: manifest([{ id: 'suite-a' }]), rows: trials(Array(20).fill(3), 3, { cost_usd: 0.7 }) }, previous, 'previous');
    expect(c.flags).toMatchObject([{ kind: 'cost', detail: 'cost per correct answer up 40% with no gain in pass rate' }]);
  });

  test('a changed suite digest starts a new baseline: nothing is compared or flagged', () => {
    const tonight = { manifest: manifest([{ id: 'suite-a', digest: 'digest-b' }]), rows: trials(Array(20).fill(0)) };
    const c = compareNights(tonight, previous, 'previous');
    expect(c.flags).toEqual([]);
    expect(c.suites).toEqual([{ suite: 'suite-a', reader: 'gpt-6.1-sol', compared: false, reason: 'suite digest changed (digest-a to digest-b), so tonight starts a new baseline' }]);
  });

  test('a suite the ref skipped, or one missing from either night, is not compared and says why', () => {
    const skipped = { manifest: manifest([{ id: 'suite-a', status: 'skipped', reason: 'gbrain bbbbbbbbbbbb predates 773a29eede3b, which this suite needs' }]), rows: [] };
    const c = compareNights(skipped, previous, 'previous');
    expect(c.flags).toEqual([]);
    expect(c.suites[0]!.reason).toBe('skipped tonight (gbrain bbbbbbbbbbbb predates 773a29eede3b, which this suite needs)');
    const added = compareNights({ manifest: manifest([{ id: 'suite-a' }, { id: 'suite-b' }]), rows: trials(Array(20).fill(3)) }, previous, 'previous');
    expect(added.suites.find(s => s.suite === 'suite-b')).toMatchObject({ compared: false, reason: "not in the previous night's dev set" });
  });
});

describe('the report files', () => {
  test('report.md, summary.json and outcomes.jsonl.gz, with the comparison, the fixes table and the previous night found by date', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-report-'));
    const write = (night: string, m: NightManifest, rows: Outcome[]) => {
      const dir = join(root, night, 'master');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'night.json'), JSON.stringify(m));
      writeFileSync(join(dir, 'outcomes.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      writeFileSync(join(dir, 'summary.json'), '{}');
      return dir;
    };
    write('2026-11-07', manifest([{ id: 'suite-a' }], { night: '2026-11-07' }), trials(Array(20).fill(3)));
    const prev = write('2026-11-08', manifest([{ id: 'suite-a' }], { night: '2026-11-08', sha: 'a'.repeat(40) }), trials(Array(20).fill(3)));
    const dir = write('2026-11-09', manifest([{ id: 'suite-a' }, { id: 'suite-b', status: 'not_built', reason: 'smokes missing' }]),
      [...trials([...Array(14).fill(3), ...Array(6).fill(0)], 3, { cost_usd: null }), row({ suite: 'suite-b', item: 'smoke-1', skipped: 'smokes missing' })]);
    expect(findPreviousNight(root, '2026-11-09', 'master')).toBe(prev);
    const summary = writeReport({ dir, previous: prev, fixes: [{ issue: 'ISSUE-1', pr: 'gbrain#1', gbrain_version: '0.60.621.0', suite: 'suite-a', items: ['item-0', 'item-19'] }] });
    expect((summary.flags as unknown[]).length).toBe(2);
    expect(summary.fixes).toEqual([expect.objectContaining({ issue: 'ISSUE-1', tonight: { rows: 6, passes: 3 } })]);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('**2 flags.**');
    expect(md).toContain('| suite-b | | | | | | | | not built: smokes missing |');
    expect(md).toContain('## Against the previous master night');
    expect(md).toContain('ISSUE-1 (gbrain#1, gbrain 0.60.621.0): suite-a item-0, item-19: 3 of 6 passing tonight');
    expect(md).toContain(`Causes: failure-cause taxonomy ${TAXONOMY_VERSION}.`);
    expect(md).toContain('| n/a | unclassified 18 |');
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).taxonomy_version).toBe(TAXONOMY_VERSION);
    expect(existsSync(join(dir, 'outcomes.jsonl.gz'))).toBe(true);
    expect(gunzipSync(readFileSync(join(dir, 'outcomes.jsonl.gz'))).toString('utf8')).toBe(readFileSync(join(dir, 'outcomes.jsonl'), 'utf8'));
  });

  test('a dev-set suite is labelled in its table rows and listed with its drifted files, in report.md and summary.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-report-'));
    const label = 'dev-set run on the current harness, not a Hard-freeze result: never publish or compare it as one';
    const m = manifest([{ id: 'suite-a', dev_set: { label, freeze_drift: ['eval/runner/cat40/loop.ts', 'eval/runner/cat40/arms.ts'] } }, { id: 'suite-b', dev_set: { label, freeze_drift: null } }]);
    writeFileSync(join(dir, 'night.json'), JSON.stringify(m));
    writeFileSync(join(dir, 'outcomes.jsonl'), [...trials([3, 1]), ...trials([2], 3, { suite: 'suite-b' })].map(r => JSON.stringify(r)).join('\n') + '\n');
    const summary = writeReport({ dir });
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('| suite-a (dev set) | gpt-6.1-sol |');
    expect(md).toContain(`## Dev-set runs\n\n- suite-a: ${label}. Code changed since the freeze: eval/runner/cat40/loop.ts, eval/runner/cat40/arms.ts.\n- suite-b: ${label}. The freeze was not checked on this night.`);
    expect((summary.suites as SuiteStatus[])[0]!.dev_set).toEqual(m.suites[0]!.dev_set);
  });
});

describe("particle-1's agreement with claude-opus-5-5", () => {
  const both = ['claude-opus-5-5', 'particle-1'];
  const labelled = (reader: string, labels: boolean[], o: Partial<Outcome> = {}) => labels.map((pass, i) => row({ reader, item: `item-${i}`, pass, score: pass ? 1 : 0, ...o }));
  /** Labels for a 2x2 table: both pass, only particle-1 passes, only Opus passes, both fail. */
  const table = (bp: number, co: number, ro: number, bf: number) => ({
    particle: [...Array(bp + co).fill(true), ...Array(ro + bf).fill(false)] as boolean[],
    opus: [...Array(bp).fill(true), ...Array(co).fill(false), ...Array(ro).fill(true), ...Array(bf).fill(false)] as boolean[],
  });
  /** Both readers' rows for one suite from a table. */
  const pair = (t: ReturnType<typeof table>, suite = 'suite-a') => [...labelled('claude-opus-5-5', t.opus, { suite }), ...labelled('particle-1', t.particle, { suite })];
  const a = table(10, 1, 2, 7);
  const opusA = a.opus.flatMap((pass, i) => [1, 2, 3].map(trial => row({ reader: 'claude-opus-5-5', item: `item-${i}`, trial, pass: trial === 1 ? pass : !pass })));
  opusA[0] = { ...opusA[0]!, pass: false, harness: { error: 'provider 529' } };
  opusA[1] = { ...opusA[1]!, pass: true };
  const rowsA = [...opusA, ...labelled('particle-1', a.particle), row({ reader: 'particle-1', item: 'item-20', pass: true }), row({ reader: 'particle-1', item: 'item-21', skipped: 'not scheduled' }),
    row({ suite: 'suite-c', reader: 'particle-1', harness: { error: 'refused' } }), row({ suite: 'suite-k', reader: null, pass: true })];
  const suitesA = [{ id: 'suite-a', readers: both }, { id: 'suite-c', readers: both, status: 'error' as const, reason: 'the runner refused particle-1' }, { id: 'suite-k', readers: [null], k: 1 }];
  const twoSuites = manifest([{ id: 'suite-a', readers: both, k: 1 }, { id: 'suite-b', readers: both, k: 1 }]);

  test("Opus's first counted trial is its label, only items both answered are paired, a suite with no pair is not measured and keyless suites are left out", () => {
    const ag = nightAgreement(manifest(suitesA), rowsA)!;
    expect(ag.suites.map(s => s.suite)).toEqual(['suite-a', 'suite-c']);
    expect(ag.suites[0]).toMatchObject({ measured: true, counted: true, items: 20, both_pass: 10, candidate_only: 1, reference_only: 2, both_fail: 7, scheduled: 22, unpaired: 2, candidate_harness: 0 });
    const s = ag.suites[0] as { raw: number; kappa: number; candidate_pass: number; reference_pass: number; gap: number };
    expect(s.raw).toBeCloseTo(0.85, 10);
    expect(s.kappa).toBeCloseTo(0.34 / 0.49, 10);
    expect([s.candidate_pass, s.reference_pass, s.gap].map(x => +x.toFixed(10))).toEqual([0.55, 0.6, -0.05]);
    expect(ag.suites[1]).toEqual({ suite: 'suite-c', measured: false, scheduled: 1, unpaired: 1, reason: 'error: the runner refused particle-1' });
    expect(ag.pooled).toMatchObject({ items: 20, both_pass: 10, candidate_only: 1, reference_only: 2, both_fail: 7 });
    expect([ag.scheduled, ag.unpaired, ag.verdict, ag.reason]).toEqual([23, 3, 'not_measured', '3 of 23 scheduled items are unpaired, more than 10%']);
  });

  test('a night passes with at least 40 items in suites of at least 20, the item-weighted mean of their kappas and their raw agreement at or above the bars', () => {
    const ag = nightAgreement(twoSuites, [...pair(a), ...pair(a, 'suite-b')])!;
    expect(ag.counted).toMatchObject({ suites: 2, items: 40, both_pass: 20, candidate_only: 2, reference_only: 4, both_fail: 14 });
    expect(ag.counted.mean_kappa).toBeCloseTo(0.34 / 0.49, 10);
    expect(ag.counted.raw).toBe(0.85);
    expect([ag.verdict, ag.reason, ag.unpaired]).toEqual(['pass', null, 0]);
  });

  test('a kappa of exactly 0.6, which floating point computes as 0.5999999999999996, passes', () => {
    const ag = nightAgreement(twoSuites, [...pair(table(28, 2, 2, 4)), ...pair(table(28, 2, 2, 4), 'suite-b')])!;
    const s = ag.suites[0] as { kappa: number };
    expect(s.kappa).toBeLessThan(0.6);
    expect(s.kappa).toBeCloseTo(0.6, 12);
    expect(ag.verdict).toBe('pass');
  });

  test('the verdict uses the item-weighted mean of per-suite kappas, so two suites with kappa 0 fail even though their pooled kappa is 0.92', () => {
    const ag = nightAgreement(twoSuites, [...pair(table(24, 0, 1, 0)), ...pair(table(0, 1, 0, 24), 'suite-b')])!;
    expect(ag.suites.map(s => +(s as { kappa: number }).kappa.toFixed(10))).toEqual([0, 0]);
    expect(ag.pooled.kappa).toBeCloseTo(0.92, 10);
    expect(ag.counted.mean_kappa).toBeCloseTo(0, 10);
    expect(ag.counted.raw).toBeCloseTo(0.96, 10);
    expect(ag.verdict).toBe('fail');
  });

  test('a suite counts only with at least 20 paired items, and the verdict needs at least 40 counted items', () => {
    const one = nightAgreement(manifest([{ id: 'suite-a', readers: both, k: 1 }]), pair(table(20, 1, 2, 16)))!;
    expect([one.counted.items, one.verdict, one.reason]).toEqual([39, 'not_measured', '39 paired items in suites with at least 20, fewer than 40']);
    const small = nightAgreement(twoSuites, [...pair(a), ...pair(table(10, 1, 2, 6), 'suite-b')])!;
    expect(small.suites.map(s => (s as { counted: boolean }).counted)).toEqual([true, false]);
    expect([small.pooled.items, small.counted.items, small.verdict, small.reason]).toEqual([39, 20, 'not_measured', '20 paired items in suites with at least 20, fewer than 40']);
  });

  test('a particle-1 crash is a fail, never a dropped item; an item Opus has no counted trial for is unpaired, and more than 10% unpaired is not measured', () => {
    const crashed = (labels: boolean[], suite: string) => labels.map((pass, i) => row({ reader: 'particle-1', item: `item-${i}`, suite, pass, score: pass ? 1 : 0, ...(pass ? {} : { harness: { error: 'particle-1 crashed' } }) }));
    const opus = (suite: string) => labelled('claude-opus-5-5', a.opus, { suite });
    const ag = nightAgreement(twoSuites, [...opus('suite-a'), ...crashed(a.particle, 'suite-a'), ...opus('suite-b'), ...crashed(a.particle, 'suite-b')])!;
    expect(ag.suites[0]).toMatchObject({ items: 20, both_pass: 10, candidate_only: 1, reference_only: 2, both_fail: 7, candidate_harness: 9, unpaired: 0 });
    expect(ag.verdict).toBe('pass');
    const opusDown = [...opus('suite-a').map((r, i) => (i < 5 ? { ...r, harness: { error: 'provider 529' } } : r)), ...pair(a, 'suite-b').slice(0, 20), ...labelled('particle-1', a.particle), ...labelled('particle-1', a.particle, { suite: 'suite-b' })];
    const down = nightAgreement(twoSuites, opusDown)!;
    expect(down.suites[0]).toMatchObject({ items: 15, scheduled: 20, unpaired: 5 });
    expect([down.verdict, down.reason]).toEqual(['not_measured', '5 of 40 scheduled items are unpaired, more than 10%']);
  });

  test('a scheduled suite that stopped before writing any row counts every item it planned as unpaired, so the other suite cannot pass alone', () => {
    const lost = manifest([{ id: 'suite-a', readers: both, k: 1, items: 40 }, { id: 'suite-b', readers: both, k: 1, items: 60, status: 'error', reason: 'rows.ndjson: bad line' }]);
    const ag = nightAgreement(lost, pair(table(30, 2, 2, 6)))!;
    expect(ag.suites[0]).toMatchObject({ measured: true, counted: true, scheduled: 40, unpaired: 0 });
    expect(ag.suites[1]).toEqual({ suite: 'suite-b', measured: false, scheduled: 60, unpaired: 60, reason: 'error: rows.ndjson: bad line' });
    expect([ag.scheduled, ag.unpaired, ag.verdict, ag.reason]).toEqual([100, 60, 'not_measured', '60 of 100 scheduled items are unpaired, more than 10%']);
  });

  test("a night that ends on a budget stop or loses its VM is not measured: particle-1 agrees on every item it answered, then Particle's 402 stops it at 70% of each suite", () => {
    const opus = [true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, true, true, true, true, true];
    const particle = (suite: string) => opus.map((pass, i) => i < 14 ? row({ suite, reader: 'particle-1', item: `item-${i}`, pass, score: pass ? 1 : 0 })
      : row({ suite, reader: 'particle-1', item: `item-${i}`, pass: false, score: 0, harness: { error: 'budget stop: Particle answered 402' } }));
    const rows = ['suite-a', 'suite-b'].flatMap(suite => [...labelled('claude-opus-5-5', opus, { suite }), ...particle(suite)]);
    const capped = nightAgreement({ ...twoSuites, exit: 'NIGHTLY_CAP_STOP' }, rows)!;
    expect(capped.suites[0]).toMatchObject({ items: 20, both_pass: 7, candidate_only: 0, reference_only: 6, both_fail: 7, candidate_harness: 6, unpaired: 0 });
    expect([capped.verdict, capped.reason]).toEqual(['not_measured', "the night ended with NIGHTLY_CAP_STOP, so the items it never reached are not particle-1's fails"]);
    expect(nightAgreement({ ...twoSuites, exit: 'NIGHTLY_VM_LOST' }, rows)!.verdict).toBe('not_measured');
    expect(nightAgreement({ ...twoSuites, exit: 'NIGHTLY_HARNESS' }, rows)!.verdict).toBe('fail');
  });

  test('qualified reader names match, and a suite a --fake night skipped schedules nothing', () => {
    const qualified = manifest([{ id: 'suite-a', readers: ['anthropic:claude-opus-5-5', 'particle:particle-1'], k: 1 }, { id: 'suite-b', readers: ['anthropic:claude-opus-5-5', 'particle:particle-1'], k: 1 }]);
    const rename = (r: Outcome) => ({ ...r, reader: r.reader === 'particle-1' ? 'particle:particle-1' : `anthropic:${r.reader}` });
    expect(nightAgreement(qualified, [...pair(a), ...pair(a, 'suite-b')].map(rename))!.verdict).toBe('pass');
    const fake = manifest([{ id: 'suite-a', readers: both, status: 'skipped', reason: 'needs gbrain 773a29ee' }, { id: 'suite-k', readers: ['fake'] }], { fake: true });
    expect(nightAgreement(fake, [])).toBeNull();
    expect(nightAgreement({ ...fake, fake: false }, [])!.suites).toEqual([{ suite: 'suite-a', measured: false, scheduled: 0, unpaired: 0, reason: 'skipped: needs gbrain 773a29ee' }]);
  });

  test("a suite's kappa is null when both readers give every item the same label; a scheduled suite with no pair says why; a night that never schedules particle-1 has no agreement", () => {
    const night = manifest([{ id: 'suite-a', readers: both, k: 1 }]);
    const same = nightAgreement(night, pair({ particle: Array(40).fill(true), opus: Array(40).fill(true) }))!;
    expect(same.pooled).toMatchObject({ items: 40, raw: 1, kappa: null });
    expect([same.counted.mean_kappa, same.verdict]).toEqual([null, 'fail']);
    const crash = nightAgreement(night, [...labelled('claude-opus-5-5', [true]), row({ reader: 'particle-1', item: 'item-0', harness: { error: 'network' } })])!;
    expect(crash.suites[0]).toMatchObject({ measured: true, items: 1, reference_only: 1, candidate_harness: 1 });
    expect(nightAgreement(night, [...labelled('claude-opus-5-5', [true]), row({ reader: 'particle-1', item: 'item-0', skipped: 'not scheduled' })])!.suites)
      .toEqual([{ suite: 'suite-a', measured: false, scheduled: 1, unpaired: 1, reason: 'no particle-1 row that ran' }]);
    expect(nightAgreement(night, labelled('particle-1', [true, false]))!.suites).toEqual([{ suite: 'suite-a', measured: false, scheduled: 2, unpaired: 2, reason: 'no counted claude-opus-5-5 rows' }]);
    const apart = nightAgreement(night, [row({ reader: 'claude-opus-5-5', item: 'x' }), row({ reader: 'particle-1', item: 'y' })])!;
    expect(apart.suites).toEqual([{ suite: 'suite-a', measured: false, scheduled: 2, unpaired: 2, reason: 'no item both readers answered' }]);
    expect([apart.verdict, apart.reason]).toEqual(['not_measured', 'no item both readers answered']);
    expect(nightAgreement(manifest([{ id: 'suite-a' }]), trials([3, 1]))).toBeNull();
  });

  const reportOf = (m: NightManifest, rows: Outcome[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-report-'));
    writeFileSync(join(dir, 'night.json'), JSON.stringify(m));
    writeFileSync(join(dir, 'outcomes.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const summary = writeReport({ dir });
    return { summary, md: readFileSync(join(dir, 'report.md'), 'utf8') };
  };

  test('report.md and summary.json carry the agreement section on a night with particle-1 rows, and leave it out otherwise', () => {
    const night = manifest([{ id: 'suite-a', readers: both, k: 1 }, { id: 'suite-b', readers: both, k: 1 }, { id: 'suite-c', readers: both, status: 'error', reason: 'the runner refused particle-1' }]);
    const { summary, md } = reportOf(night, [...pair(a), ...pair(a, 'suite-b'), row({ suite: 'suite-c', reader: 'particle-1', harness: { error: 'refused' } })]);
    expect(summary.agreement).toMatchObject({ candidate: 'particle-1', reference: 'claude-opus-5-5', min_kappa: 0.6, min_raw: 0.85, min_suite_items: 20, min_items: 40, max_unpaired: 0.1, verdict: 'pass', reason: null });
    expect(md).toContain('## particle-1 agreement with claude-opus-5-5');
    expect(md).toContain('**Passes: kappa 0.694 (item-weighted mean over 2 suites), raw agreement 85.0%, over 40 items.** particle-1 passes 55.0% of them and claude-opus-5-5 60.0%, a gap of -5.0 points.');
    expect(md).toContain('Pooled kappa over every measured suite, for reference only: 0.694 over 40 items. Unpaired items: 1 of 41 scheduled.');
    expect(md).toContain('| suite-a | 20 | yes | 85.0% | 0.694 | 55.0% | 60.0% | -5.0 | 0 | 0 |');
    expect(md).toContain('- suite-c: not measured, error: the runner refused particle-1');
    const plain = reportOf(manifest([{ id: 'suite-a' }]), trials([3, 1]));
    expect(plain.summary.agreement).toBeNull();
    expect(plain.md).not.toContain('agreement with');
  });

  test('report.md states a failing verdict, an undefined kappa, a suite under the floor and a night with nothing to pair', () => {
    const one = manifest([{ id: 'suite-a', readers: both, k: 1 }]);
    expect(reportOf(twoSuites, [...pair(table(4, 4, 0, 12)), ...pair(table(4, 4, 0, 12), 'suite-b')]).md).toContain('**Fails: kappa 0.545 (item-weighted mean over 2 suites), raw agreement 80.0%, over 40 items.**');
    expect(reportOf(one, pair({ particle: Array(40).fill(true), opus: Array(40).fill(true) })).md).toContain('**Fails: kappa n/a (both readers gave every item the same label in every counted suite), raw agreement 100.0%, over 40 items.**');
    const small = reportOf(twoSuites, [...pair(a), ...pair(table(10, 1, 2, 6), 'suite-b')]).md;
    expect(small).toContain('**Not measured: 20 paired items in suites with at least 20, fewer than 40.**');
    expect(small).toContain('| suite-b | 19 | no (under 20) |');
    const none = reportOf(one, [...labelled('claude-opus-5-5', [true]), row({ reader: 'particle-1', item: 'item-0', skipped: 'not scheduled' })]).md;
    expect(none).toContain('**Not measured: no item both readers answered.**\n\n- suite-a: not measured, no particle-1 row that ran');
  });
});
