/**
 * The nightly report (eval/runner/nightly/report.ts): pass^k and cost per correct answer, and the diff against an earlier
 * night with its flags, on fixture nights: a pass-rate drop, strong flips, a deterministic signal, a cost rise, a changed
 * suite digest, a suite the ref skipped, and harness rows kept out of every rate.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Outcome } from '../../eval/runner/nightly/outcome.ts';
import { cellStats, compareNights, findPreviousNight, passHatK, writeReport, type NightManifest, type SuiteStatus } from '../../eval/runner/nightly/report.ts';
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
    expect(c.failures_by_cause).toEqual({ unclassified: 4, harness: 1 });
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
    const dir = write('2026-11-09', manifest([{ id: 'suite-a' }, { id: 'suite-b', status: 'not_built', reason: 'smokes missing' }]), trials([...Array(14).fill(3), ...Array(6).fill(0)], 3, { cost_usd: null }));
    expect(findPreviousNight(root, '2026-11-09', 'master')).toBe(prev);
    const summary = writeReport({ dir, previous: prev, fixes: [{ issue: 'ISSUE-1', pr: 'gbrain#1', gbrain_version: '0.60.621.0', suite: 'suite-a', items: ['item-0', 'item-19'] }] });
    expect((summary.flags as unknown[]).length).toBe(2);
    expect(summary.fixes).toEqual([expect.objectContaining({ issue: 'ISSUE-1', tonight: { rows: 6, passes: 3 } })]);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('**2 flags.**');
    expect(md).toContain('| suite-b | | | | | | | | not built: smokes missing |');
    expect(md).toContain('## Against the previous master night');
    expect(md).toContain('ISSUE-1 (gbrain#1, gbrain 0.60.621.0): suite-a item-0, item-19: 3 of 6 passing tonight');
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).classifier_version).toBe('nightly-causes/v0');
    expect(existsSync(join(dir, 'outcomes.jsonl.gz'))).toBe(true);
    expect(gunzipSync(readFileSync(join(dir, 'outcomes.jsonl.gz'))).toString('utf8')).toBe(readFileSync(join(dir, 'outcomes.jsonl'), 'utf8'));
  });
});
