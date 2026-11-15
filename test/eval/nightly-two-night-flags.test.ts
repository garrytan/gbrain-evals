/**
 * Pass-rate and cost flags against the previous master night wait a night (eval/runner/nightly/report.ts): a rule that
 * meets for the first time is a watch line, and it files as a flag only when the next night meets it again against the
 * same baseline night, carried in summary.json. The GST-2427 case is the real 2026-11-11 refused-write-agents cell on
 * gpt-6.1-sol (4 of 90 passing) against 2026-11-10's (10 of 90), per item as the nightly recorded them, with each night's
 * cost spread evenly over its trials. The planted drop is 8 of 90 trials (8.9 points) from a suite at 90 of 90, about the
 * smallest drop the two-night rule catches with 80% power at 30 items and three trials.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Outcome } from '../../eval/runner/nightly/outcome.ts';
import { compareNights, writeReport, type NightManifest } from '../../eval/runner/nightly/report.ts';
import { row } from './nightly-fixtures.ts';

const SUITE = 'refused-write-agents', DIGEST = '36a93938ce18a15fd518d63a9b623448121e4aa21415cb94c6402d861244ee7f';
const manifest = (night: string, sha: string, digest = DIGEST): NightManifest => ({
  schema: 'nightly-night/1', night, ref: 'master', sha, version: null, tier: 'nightly', fake: false,
  devset: { path: 'eval/data/nightly/devset-v1.json', digest: 'devset' }, started_at: `${night}T09:00:00Z`,
  suites: [{ id: SUITE, digest, k: 3, readers: ['gpt-6.1-sol'], status: 'ran' }],
});
/** Items 2001 to 2030, three trials each; passes names the items with any passing trial and how many. */
const cell = (night: string, passes: Record<string, number>, cellCost: number | null, digest = DIGEST): Outcome[] =>
  Array.from({ length: 30 }, (_, i) => String(2001 + i)).flatMap(item => [1, 2, 3].map(trial => row({
    night, suite: SUITE, suite_digest: digest, item, trial, pass: trial <= (passes[item] ?? 0), score: trial <= (passes[item] ?? 0) ? 1 : 0,
    cost_usd: cellCost === null ? null : cellCost / 90, condition: 'forced', agent_loop: true })));
const night = (n: string, sha: string, passes: Record<string, number>, cost: number | null, digest = DIGEST) => ({ manifest: manifest(n, sha, digest), rows: cell(n, passes, cost, digest) });
const all = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(2001 + i), 3]));
const minus = (items: string[]) => ({ ...all, ...Object.fromEntries(items.map(i => [i, 2])) });
const DROP_1 = ['2002', '2005', '2009', '2013', '2017', '2021', '2025', '2029'], DROP_2 = ['2003', '2006', '2010', '2014', '2018', '2022', '2026', '2030'];
const writeNight = (root: string, n: { manifest: NightManifest; rows: Outcome[] }) => {
  const dir = join(root, n.manifest.night, 'master');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'night.json'), JSON.stringify(n.manifest));
  writeFileSync(join(dir, 'outcomes.jsonl'), n.rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return dir;
};

const nov10 = night('2026-11-10', '001c8c39e84d726e9bb6ecbae053458c970d5af3', { 2001: 1, 2010: 1, 2011: 2, 2013: 1, 2015: 1, 2020: 1, 2022: 1, 2025: 1, 2026: 1 }, 2.730585);
const nov11 = night('2026-11-11', '016ffa00c0edaa7e113918371bc41f1f2fe4dc11', { 2010: 1, 2019: 1, 2020: 1, 2026: 1 }, 2.833861);

describe('pass-rate and cost flags wait a night', () => {
  test('the GST-2427 case: 2026-11-11 against 2026-11-10 files nothing and records two watch lines', () => {
    const c = compareNights(nov11, nov10, 'previous');
    expect(c.flags).toEqual([]);
    expect(c.watches).toMatchObject([
      { kind: 'pass_rate', suite: SUITE, reader: 'gpt-6.1-sol', digest: DIGEST, detail: 'pass rate down 6.7 points over 30 paired items (95% interval -13.3 to -1.1)',
        baseline: { night: '2026-11-10', sha: nov10.manifest.sha } },
      { kind: 'cost', detail: 'cost per correct answer up 159% with no gain in pass rate', baseline: { night: '2026-11-10' } },
    ]);
  });

  test('a planted drop of 8 of 90 trials is a watch on its first night and a flag when the next night shows it again', () => {
    const base = night('2026-11-20', 'a'.repeat(40), all, null);
    const first = night('2026-11-21', 'b'.repeat(40), minus(['2002', '2005', '2009', '2013', '2017', '2021', '2025', '2029']), null);
    const second = night('2026-11-22', 'c'.repeat(40), minus(['2003', '2006', '2010', '2014', '2018', '2022', '2026', '2030']), null);
    const c1 = compareNights(first, base, 'previous');
    expect(c1.flags).toEqual([]);
    expect(c1.watches).toMatchObject([{ kind: 'pass_rate', baseline: { night: '2026-11-20' } }]);
    expect(c1.watches[0]!.detail).toMatch(/^pass rate down 8\.9 points over 30 paired items/);
    expect(compareNights(second, first, 'previous').flags).toEqual([]);
    const c2 = compareNights(second, first, 'previous', c1.watches);
    expect(c2.flags).toMatchObject([{ kind: 'pass_rate', against: 'previous', suite: SUITE }]);
    expect(c2.flags[0]!.detail).toBe(`pass rate down 8.9 points over 30 paired items (95% interval -14.4 to -4.4) against 2026-11-20, a second night running (2026-11-21: ${c1.watches[0]!.detail})`);
    expect(c2.watches).toEqual([]);
  });

  test('a watch the next night does not repeat, or one from a suite whose digest changed, files nothing', () => {
    const base = night('2026-11-20', 'a'.repeat(40), all, null);
    const first = night('2026-11-21', 'b'.repeat(40), minus(['2002', '2005', '2009', '2013', '2017', '2021', '2025', '2029']), null);
    const { watches } = compareNights(first, base, 'previous');
    const recovered = compareNights(night('2026-11-22', 'c'.repeat(40), all, null), first, 'previous', watches);
    expect(recovered.flags).toEqual([]);
    expect(recovered.watches).toEqual([]);
    const lower = minus(['2003', '2006', '2010', '2014', '2018', '2022', '2026', '2030']);
    const rebased = compareNights(night('2026-11-22', 'c'.repeat(40), lower, null, 'digest-new'), { manifest: manifest('2026-11-21', 'b'.repeat(40), 'digest-new'), rows: cell('2026-11-21', lower, null, 'digest-new') }, 'previous', watches);
    expect(rebased.flags).toEqual([]);
  });

  test('against stable, a pass-rate drop flags on the night it is seen', () => {
    expect(compareNights(nov11, nov10, 'stable').flags.map(f => f.kind)).toEqual(['pass_rate', 'cost']);
  });

  test('the report carries the watch in summary.json to the next night, which files the flag', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-two-nights-'));
    const write = (n: { manifest: NightManifest; rows: Outcome[] }) => writeNight(root, n);
    const d0 = write(night('2026-11-20', 'a'.repeat(40), all, null));
    writeReport({ dir: d0, fixes: [] });
    const d1 = write(night('2026-11-21', 'b'.repeat(40), minus(['2002', '2005', '2009', '2013', '2017', '2021', '2025', '2029']), null));
    const s1 = writeReport({ dir: d1, previous: d0, fixes: [] });
    expect(s1.flags).toEqual([]);
    expect(s1.watches).toMatchObject([{ kind: 'pass_rate', baseline: { night: '2026-11-20' } }]);
    const d2 = write(night('2026-11-22', 'c'.repeat(40), minus(['2003', '2006', '2010', '2014', '2018', '2022', '2026', '2030']), null));
    const s2 = writeReport({ dir: d2, previous: d1, fixes: [] });
    expect(s2.flags).toMatchObject([{ kind: 'pass_rate', against: 'previous', suite: SUITE }]);
  });

  test('a two-night flag carries its own commit range from the baseline night, and the report gives its bisect start', () => {
    const root = mkdtempSync(join(tmpdir(), 'nightly-two-nights-range-'));
    const clone = join(root, 'gbrain');
    mkdirSync(clone);
    const git = (...args: string[]) => execFileSync('git', ['-C', clone, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'master');
    const [baseline, culprit, later] = ['baseline', 'culprit', 'later'].map(m => { git('commit', '-q', '--allow-empty', '-m', m); return git('rev-parse', 'HEAD'); }) as [string, string, string];
    const d0 = writeNight(root, night('2026-11-20', baseline, all, null));
    writeReport({ dir: d0, fixes: [] });
    const d1 = writeNight(root, night('2026-11-21', culprit, minus(DROP_1), null));
    writeReport({ dir: d1, previous: d0, gbrainClone: clone, fixes: [] });
    const d2 = writeNight(root, night('2026-11-22', later, minus(DROP_2), null));
    const s2 = writeReport({ dir: d2, previous: d1, gbrainClone: clone, fixes: [] });
    expect(s2.commit_range).toMatchObject({ from: culprit, to: later, commits: [expect.stringContaining('later')] });
    expect(s2.flags).toMatchObject([{ kind: 'pass_rate', baseline: { night: '2026-11-20', sha: baseline },
      commit_range: { from: baseline, to: later, commits: [expect.stringContaining('later'), expect.stringContaining('culprit')] } }]);
    expect(readFileSync(join(d2, 'report.md'), 'utf8')).toContain(`bisect with \`--good ${baseline} --bad ${later}\``);
  });

  test('a held cost watch files a cost flag when the next night has no correct answers at the same spend (6, then 3, then 0 correct)', () => {
    const spread = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(2001 + i), 1]));
    const base = night('2026-11-20', 'a'.repeat(40), spread(6), 6);
    const first = night('2026-11-21', 'b'.repeat(40), spread(3), 6);
    const none = night('2026-11-22', 'c'.repeat(40), {}, 6);
    const c1 = compareNights(first, base, 'previous');
    expect(c1.flags).toEqual([]);
    expect(c1.watches).toMatchObject([{ kind: 'cost', detail: 'cost per correct answer up 100% with no gain in pass rate' }]);
    const c2 = compareNights(none, first, 'previous', c1.watches);
    expect(c2.flags).toMatchObject([{ kind: 'cost', baseline: { night: '2026-11-20' } }]);
    expect(c2.flags[0]!.detail).toMatch(/^no correct answers at positive cost \(baseline \S+ per correct\) against 2026-11-20, a second night running \(2026-11-21: cost per correct answer up 100%/);
    expect(c2.watches).toEqual([]);
    expect(compareNights(none, first, 'previous').watches).toMatchObject([{ kind: 'cost', detail: expect.stringMatching(/^no correct answers at positive cost \(baseline \S+ per correct\)$/) }]);
  });
});
