import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSON_DEDUPE_DEFAULT_SEED, generateLedger, pageKey } from '../../eval/generators/person-dedupe-gen.ts';
import { heldOutLabels, parseErOutput, scoreErOutput } from '../../eval/runner/er-h2h-score.ts';

const SEED = 7;
const ledger = generateLedger(SEED, 1);
const known = new Set(ledger.pages.map(pageKey));
const same = ledger.pairs.find(p => p.label === 'same' && p.family === 'same-exact')!;
const diff = ledger.pairs.find(p => p.label === 'different' && p.family === 'diff-namesake')!;
const nDiff = ledger.pairs.filter(p => p.label === 'different').length;

/** A tiny hand-made output: auto joins one real duplicate; proposed also joins one designed namesake pair. */
const handMade = { system: 'toy-er', version: '0.0.1', config: 'default', tiers: { auto: [[same.a, same.b]], proposed: [[same.a, same.b], [diff.a, diff.b]] } };

describe('er-h2h scorer', () => {
  test('scores each tier of a hand-made output with the person-dedupe ledger', () => {
    const rows = scoreErOutput(parseErOutput(handMade, known), ledger);
    expect(rows.map(r => r.tier)).toEqual(['auto', 'proposed']);
    const [auto, proposed] = rows;
    expect([auto.false_merge.k, auto.false_merge.n]).toEqual([0, nDiff]);
    expect(auto.false_merge.ci95![0]).toBe(0);
    expect([auto.precision.k, auto.precision.n, auto.recall.k]).toEqual([1, 1, 1]);
    expect(auto.pair_f1).toBeCloseTo((2 * 1 * (1 / auto.recall.n)) / (1 + 1 / auto.recall.n), 12);
    expect([proposed.false_merge.k, proposed.precision.k, proposed.precision.n, proposed.clusters]).toEqual([1, 1, 2, 2]);
    expect(proposed.by_family['diff-namesake'].false_merge!.k).toBe(1);
  });

  test('a tool with no review band leaves proposed out and gets one row', () => {
    const rows = scoreErOutput(parseErOutput({ ...handMade, tiers: { auto: handMade.tiers.auto } }, known), ledger);
    expect(rows.map(r => r.tier)).toEqual(['auto']);
  });

  test('rejects outputs it cannot score exactly', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ ...handMade, extra: 1 }, /keys/],
      [{ ...handMade, tiers: { proposed: [] } }, /no auto tier/],
      [{ ...handMade, tiers: { auto: [], review: [] } }, /tier review/],
      [{ ...handMade, tiers: { auto: [['work:nobody-here', same.a]] } }, /does not have/],
      [{ ...handMade, tiers: { auto: [[same.a, same.b], [same.a, diff.a]] } }, /two clusters/],
      [{ ...handMade, tiers: { auto: [same.a] } }, /not a list of page keys/],
      [{ ...handMade, version: '' }, /version/],
    ];
    for (const [raw, msg] of bad) expect(() => parseErOutput(raw, known)).toThrow(msg);
  });

  test('labels come only from a held-out seed', () => {
    expect(() => heldOutLabels(PERSON_DEDUPE_DEFAULT_SEED, 1)).toThrow(/scored seed/);
    const labels = heldOutLabels(SEED, 1);
    expect(Object.keys(labels.person).sort()).toEqual([...known].sort());
  });

  test('the command line reads the file and reports the false-merge rate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-h2h-'));
    const file = join(dir, 'toy.json');
    writeFileSync(file, JSON.stringify(handMade));
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '../../eval/runner/er-h2h-score.ts'), '--seed', String(SEED), '--per-family', '1', '--output', dir, '--json', file]);
    expect(run.exitCode).toBe(0);
    const out = JSON.parse(run.stdout.toString());
    expect(out.rows.map((r: { tier: string; false_merge: { k: number } }) => [r.tier, r.false_merge.k])).toEqual([['auto', 0], ['proposed', 1]]);
    expect(JSON.parse(readFileSync(join(dir, 'er-h2h-scores.json'), 'utf8')).ledger_sha256).toBe(out.ledger_sha256);
  });
});
