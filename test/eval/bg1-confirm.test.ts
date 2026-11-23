/**
 * BG1-C's verdict (eval/runner/bg1/verdict.ts confirm and eval/runner/bg1/confirm.ts, with Amendments 1 and 2) on
 * synthetic inputs and synthetic receipts: every combination of the four comparisons' words, both descriptive states, a
 * server row left out and an early stop maps to exactly one row of the outcome table, with its sentences from code; the
 * O'Brien-Fleming bounds by Holm step, the z, Holm's step-down at the look and the final, futility and when the look
 * stops; the estimand, the drop cap and fill gate per comparison, the worst case and the reports beside the verdict; the
 * one look and its refusals; and the refusals of a missing, unfilled or wrongly kept BG1-C manifest, of receipts it does
 * not pin or that hold other worlds, and of a cell set that is not BG1-C's. Keyless and offline: nothing here builds a
 * provider client, and fetch throws for the whole file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BG1C_MANIFEST, type MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { answerId } from '../../eval/runner/memory-qa/records.ts';
import { tQuantile } from '../../eval/runner/power/risk-ratio.ts';
import { frontierInstrumentId, runConfigText } from '../../eval/runner/q1/cell.ts';
import { loadBG1Manifest, OPUS, PARTICLE } from '../../eval/runner/q1/cells/bg1.ts';
import { BG1C_GBRAIN_BUILD, BG1C_MANIFEST_PATH, BG1C_READERS, BG1C_SOL, bg1cRereadPlans } from '../../eval/runner/q1/cells/bg1c.ts';
import { bg1JudgeOf, PER_READER_JUDGE_SETTINGS, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { rereadCellId } from '../../eval/runner/q1/reread-cell.ts';
import { normalQuantile } from '../../eval/runner/stats/paired.ts';
import {
  CONFIRM_CELLS_PATH, CONFIRM_COMPARISONS, CONFIRM_CONVERSATIONS, CONFIRM_LESSON_CAVEAT, CONFIRM_LIVE_READERS, CONFIRM_LOOK_N, CONFIRM_MANIFEST_REL, CONFIRM_N, CONFIRM_READERS, CONFIRM_SOL,
  CONFIRM_STOP_SENTENCE, CONFIRM_WORDS, conditionalPower, confirmFinal, confirmKeptProblems, confirmLesson, confirmLook, confirmOutcome, confirmPhrase, confirmZ, holmAlphas, holmCrosses,
  confirmBounds, leftOutProblems, normalCdf, obfBounds, obfSpend, type ConfirmReading, type ConfirmTest, type ConfirmWord,
} from '../../eval/runner/bg1/confirm.ts';
import type { PairedT } from '../../eval/runner/bg1/rule.ts';
import { BG1_PRIMARY, BG1_STRATA, type Bg1Stratum } from '../../eval/runner/bg1/types.ts';
import { analyzeConfirm, BG1_MANIFEST_REL, confirmCells, loadInput, lookConfirm, main, ROLES, type Bg1Input, type Bg1Row, type QuestionInput, type ReaderValue, type WorldPlan } from '../../eval/runner/bg1/verdict.ts';

const tmp = mkdtempSync(join(tmpdir(), 'bg1-confirm-'));
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error('the BG1-C verdict tests are offline'); }) as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; rmSync(tmp, { recursive: true, force: true }); });

const RELEASE = 'v0.60.753.0';
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const ASTRA = 'openai:gpt-6-astra';
const READERS = [...CONFIRM_READERS];
const WORLDS = CONFIRM_CONVERSATIONS.slice(0, CONFIRM_N);
const KEYS = CONFIRM_COMPARISONS.map(c => c.key);
const NO_MEMORIES = 'the server stored no memories for bg1-dev-01';

// ─── The outcome table ───────────────────────────────────────────────

/** The table's six rows as the preregistration words them, each read literally and independently of confirm.ts. */
function literalRows(words: readonly (ConfirmWord | null)[], descriptive: readonly (string | null)[]): number[] {
  const ahead = (i: number) => words[i] === 'ahead';
  const classBoth = (ahead(0) && ahead(1)) || (ahead(2) && ahead(3));
  return [
    descriptive.some(Boolean) ? 1 : 0,
    words.includes('behind') ? 2 : 0,
    words.every(w => w === 'ahead') ? 3 : 0,
    classBoth ? 4 : 0,
    words.includes('ahead') && !classBoth ? 5 : 0,
    !words.includes('ahead') && !words.includes('behind') ? 6 : 0,
  ].filter(Boolean);
}

describe('the outcome table', () => {
  test('the four comparisons in the preregistration\'s order, now before the past and the memory-bank server first', () => {
    expect(KEYS).toEqual(['now|memory-bank', 'now|extract-first', 'past|memory-bank', 'past|extract-first']);
    expect(CONFIRM_WORDS).toEqual(['ahead', 'behind', 'level within 3 points', 'not behind by 3 points or more', 'no measurable difference']);
  });

  // Value: protects=every result the confirmation can produce, with a server row left out or a stop at the look, gets exactly one preregistered row and its sentences from code; fails_when=a combination of words, descriptive states, rows left out or an early stop falls through the table, matches a later row than the first literal match, drops the left-out listing or the stop sentence, sends a comparison not run to GBRA-108, or prints a placeholder; why_new=BG1-C harness item 3 and Amendment 1; seam=confirmOutcome; no_claim=which row the sealed run lands in
  test('every combination of the words, both descriptive states, a server row left out and a stop at the look maps to exactly one row, the first that matches', () => {
    const STATES = [null, '61 of 1600 planned questions on what is true now dropped (3.8%, above the 5% cap)', 'extract-first failed the delivered-context gate (mean fill rate 0.85, below 0.9)'];
    const counts: Record<string, Record<number, number>> = {};
    const wrong: string[] = [];
    for (const out of [null, 'memory-bank', 'extract-first'] as const) for (const stopped of [false, true]) {
      const run = KEYS.flatMap((k, i) => (out && k.endsWith(out) ? [] : [i]));
      const tail = [...(out ? [`The ${out} server was left out: its pilot failed (${NO_MEMORIES}).`] : []), ...(stopped ? [CONFIRM_STOP_SENTENCE] : [])];
      const variant = `${out ?? 'all rows'}${stopped ? ', stopped' : ''}`;
      for (let w = 0; w < 5 ** run.length; w++) for (let s = 0; s < 3 ** run.length; s++) {
        const words: (ConfirmWord | null)[] = KEYS.map(() => null), states: (string | null)[] = KEYS.map(() => null);
        run.forEach((i, j) => { words[i] = CONFIRM_WORDS[Math.floor(w / 5 ** j) % 5]; states[i] = STATES[Math.floor(s / 3 ** j) % 3]; });
        const readings: ConfirmReading[] = KEYS.map((key, i) => (run.includes(i) ? { key, word: words[i], descriptive: states[i], mean: 1.24 - i, ci95: [-0.51 - i, 2.96 - i] } : { key, word: null, descriptive: null, notRun: NO_MEMORIES }));
        const o = confirmOutcome(readings, { release: RELEASE, stopped });
        const literal = literalRows(words, states);
        const exclusive = literal.filter(r => r === literal[0]);
        const phrases = readings.map(r => `${confirmPhrase(r)}.`);
        const text = [o.headline ?? '', ...o.publish, o.readme.line, ...o.readme.replaces].join('\n');
        const body = o.publish.slice(0, o.publish.length - tail.length);
        const problems = [
          ...(literal.length && exclusive.length === 1 && o.row === literal[0] ? [] : [`row ${o.row}, literal matches ${literal.join(',')}`]),
          ...(/undefined|null|NaN|<|>/.test(text) ? ['a placeholder or missing value in the sentences'] : []),
          ...(JSON.stringify(o.publish.slice(o.publish.length - tail.length)) !== JSON.stringify(tail) || (tail.length && body.some(l => tail.includes(l))) ? ['the left-out listing and the stop sentence are not the last lines'] : []),
          ...(o.row === 1 && (o.headline !== null || o.readme.line !== `A confirmation on new sealed worlds (gbrain ${RELEASE}) was incomplete: ${[...new Set(states.filter(Boolean))].join('; ')}.` || o.readme.label !== null) ? ['row 1 sentences'] : []),
          ...(o.row > 1 && o.readme.label !== `gbrain ${RELEASE}, BG1-C` ? ['label'] : []),
          ...(o.row > 1 && o.readme.line.endsWith(CONFIRM_STOP_SENTENCE) !== stopped ? ['README\'s line does not carry the stop sentence exactly when the run stopped'] : []),
          ...(o.row > 1 && JSON.stringify(body.filter(l => l !== `${o.headline}.`).sort()) !== JSON.stringify([...phrases].sort()) ? ['the published lines are not each comparison once'] : []),
          ...(o.row === 1 && JSON.stringify(body) !== JSON.stringify(phrases) ? ['row 1 publishes each comparison, marked descriptive'] : []),
          ...(o.row === 2 && !o.publish[0].startsWith('gbrain is behind') ? ['row 2 does not say the loss first'] : []),
          ...(o.row === 6 && (o.headline !== null) !== words.every(x => x === 'level within 3 points') ? ['row 6 headline'] : []),
          ...(o.next.comparisons.some(k => !run.includes(KEYS.indexOf(k))) ? ['a comparison not run goes to GBRA-108'] : []),
        ];
        if (problems.length) wrong.push(`${variant}: ${words.join(' / ')} | ${states.map(x => (x ? 'descriptive' : 'counted')).join(' / ')}: ${problems.join('; ')}`);
        counts[variant] = { ...counts[variant], [o.row]: (counts[variant]?.[o.row] ?? 0) + 1 };
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    const all = { 1: 625 * 80, 2: 625 - 256, 3: 1, 4: 30, 5: 144, 6: 81 }, one = { 1: 25 * 8, 2: 25 - 16, 5: 16 - 9, 6: 9 };
    expect(counts).toEqual({ 'all rows': all, 'all rows, stopped': all, 'memory-bank': one, 'memory-bank, stopped': one, 'extract-first': one, 'extract-first, stopped': one });
  }, 60_000);

  test('each word\'s sentence, with its interval and, where it is descriptive or not run, the reason', () => {
    const r = (key: string, word: ConfirmWord, mean: number, lo: number, hi: number, descriptive: string | null = null): ConfirmReading => ({ key, word, descriptive, mean, ci95: [lo, hi] });
    expect(confirmPhrase(r('past|memory-bank', 'behind', -10.34, -13.04, -7.66))).toBe('gbrain is behind the memory-bank server on questions about the past (-10.3 points, 95% interval -13.0 to -7.7)');
    expect(confirmPhrase(r('now|memory-bank', 'ahead', 2.6, 0.81, 4.39))).toBe('gbrain is ahead of the memory-bank server on what is true now (+2.6 points, 95% interval +0.8 to +4.4)');
    expect(confirmPhrase(r('now|extract-first', 'level within 3 points', -0.04, -1.2, 1.1))).toBe('gbrain is level with the extract-first server on what is true now, within 3 points (0.0 points, 95% interval -1.2 to +1.1)');
    expect(confirmPhrase(r('past|extract-first', 'not behind by 3 points or more', 1.5, -1.4, 4.4))).toBe('gbrain is not behind the extract-first server on questions about the past by 3 points or more (+1.5 points, 95% interval -1.4 to +4.4)');
    expect(confirmPhrase(r('past|extract-first', 'no measurable difference', -0.4, -4.1, 3.3, 'extract-first failed the delivered-context gate (mean fill rate 0.85, below 0.9)')))
      .toBe('gbrain shows no measurable difference from the extract-first server on questions about the past (-0.4 points, 95% interval -4.1 to +3.3), descriptive: extract-first failed the delivered-context gate (mean fill rate 0.85, below 0.9)');
    expect(confirmPhrase({ key: 'now|memory-bank', word: null, descriptive: 'too few worlds for a test' })).toBe('gbrain against the memory-bank server on what is true now has no test, descriptive: too few worlds for a test');
    expect(confirmPhrase({ key: 'past|memory-bank', word: null, descriptive: null, notRun: NO_MEMORIES })).toBe(`gbrain against the memory-bank server on questions about the past: not run (pilot failed: ${NO_MEMORIES})`);
  });

  const readings = (words: ConfirmWord[]) => KEYS.map((key, i) => ({ key, word: words[i], descriptive: null, mean: [2.6, 1.1, 1.5, 1.5][i], ci95: [[0.9, 4.3], [-0.6, 2.8], [-0.2, 3.2], [-0.1, 3.1]][i] as [number, number] }));
  test('row 2 says the loss first and sends the losing class\'s kinds to GBRA-108; BG1\'s rows stay published below it', () => {
    const o = confirmOutcome(readings(['ahead', 'no measurable difference', 'behind', 'not behind by 3 points or more']), { release: RELEASE });
    expect(o.row).toBe(2);
    expect(o.headline).toBe('gbrain is behind the memory-bank server on questions about the past');
    expect(o.publish[0]).toBe('gbrain is behind the memory-bank server on questions about the past (+1.5 points, 95% interval -0.2 to +3.2).');
    expect(o.publish[1]).toBe('gbrain is ahead of the memory-bank server on what is true now (+2.6 points, 95% interval +0.9 to +4.3).');
    expect(o.readme).toEqual({ line: o.publish[0], label: 'gbrain v0.60.753.0, BG1-C', bg1_rows: 'BG1\'s rows stay published below it, labelled "gbrain v0.60.593.0, BG1"', replaces: [] });
    expect(o.next).toEqual({ text: 'The losing class\'s kinds go to GBRA-108 as issues, each with exposure placing the loss in retrieval or in reading.', comparisons: ['past|memory-bank', 'past|extract-first'], kinds: ['s6_as_of', 's7_as_known', 's8_history'] });
  });

  test('rows 3 to 6: the lead, one class, one comparison, and level or the four words', () => {
    const three = confirmOutcome(readings(['ahead', 'ahead', 'ahead', 'ahead']), { release: RELEASE });
    expect([three.row, three.headline, three.publish.length, three.next.text]).toEqual([3, 'gbrain leads the two leading memory servers on changing facts', 5, 'GBRA-108 hears the lead held.']);
    expect(three.readme.line).toBe(three.publish.join(' '));
    const four = confirmOutcome(readings(['no measurable difference', 'level within 3 points', 'ahead', 'ahead']), { release: RELEASE });
    expect([four.row, four.headline]).toEqual([4, 'gbrain leads both servers on questions about the past']);
    expect(four.readme.line.startsWith('Ahead of both servers on questions about the past. gbrain shows no measurable difference from the memory-bank server on what is true now')).toBe(true);
    expect(four.next).toMatchObject({ comparisons: ['now|memory-bank', 'now|extract-first'], kinds: [...BG1_PRIMARY] });
    const five = confirmOutcome(readings(['ahead', 'level within 3 points', 'not behind by 3 points or more', 'not behind by 3 points or more']), { release: RELEASE });
    expect([five.row, five.headline, five.next.comparisons]).toEqual([5, 'gbrain is ahead of the memory-bank server on what is true now', ['now|extract-first', 'past|memory-bank', 'past|extract-first']]);
    const level = confirmOutcome(readings(['level within 3 points', 'level within 3 points', 'level within 3 points', 'level within 3 points']), { release: RELEASE });
    expect([level.row, level.headline, level.readme.replaces.length]).toEqual([6, 'gbrain is level with the two leading memory servers on changing facts', 2]);
    const six = confirmOutcome(readings(['level within 3 points', 'no measurable difference', 'not behind by 3 points or more', 'no measurable difference']), { release: RELEASE });
    expect([six.row, six.headline, six.publish.length]).toEqual([6, null, 4]);
    expect(six.readme.replaces).toEqual(['On questions about the past against the memory-bank server, "not behind by 3 points or more" replaces BG1\'s "behind" for gbrain v0.60.753.0.']);
    expect(six.next).toEqual({ text: 'GBRA-108 gets the per-kind rows and exposure of every comparison.', comparisons: KEYS, kinds: [...BG1_STRATA] });
  });

  // Value: protects=the public lesson is the preregistration's own sentence, chosen by the row: the lead for row 3, Amendment 3's "part of the lead ... carried over" for rows 4 and 5, the tie-or-loss sentence with "did not" for rows 2 and 6, none for an incomplete run, with the design's limit beside it; fails_when=a row gets another row's sentence or word, an incomplete run gets a lesson, or the code's words drift from the preregistration's or Amendment 3's; why_new=BG1-C's preregistration, "Public lesson", and Amendment 3; seam=confirmLesson, confirmOutcome; no_claim=which row the sealed run lands in
  test('the public lesson is the preregistration\'s sentence for the row: the lead, Amendment 3\'s "part of the lead" for rows 4 and 5, or "did not", with the design\'s limit beside it', () => {
    const prereg = readFileSync('docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md', 'utf8');
    const section = prereg.slice(prereg.indexOf('## Public lesson'), prereg.indexOf('## Why we are asking')).replace(/\s*\n\s*/g, ' ');
    const [lead, carry] = [...section.matchAll(/"(We learned[^"]+)"/g)].map(m => m[1]);
    const amendment = prereg.slice(prereg.indexOf('### Amendment 3'), prereg.indexOf('## Disclosures')).replace(/\s*\n\s*/g, ' ');
    const part = [...amendment.matchAll(/"(We learned[^"]+)"/g)].map(m => m[1]);
    expect(part).toEqual(['We learned that part of the lead gbrain showed on development worlds carried over to worlds nobody had seen. You should confirm a memory change on held-out data before you claim it.']);
    expect(amendment).toContain('Row 3 keeps the lead sentence, rows 2 and 6 take the tie-or-loss sentence with "did not", and row 1 gets none.');
    const said = (word: string) => carry.replace('<did / did not>', word);
    const expected: Record<number, string | null> = { 1: null, 2: said('did not'), 3: lead, 4: part[0], 5: part[0], 6: said('did not') };
    expect(([1, 2, 3, 4, 5, 6] as const).map(confirmLesson)).toEqual([1, 2, 3, 4, 5, 6].map(r => expected[r]));
    expect(section).toContain(`${CONFIRM_LESSON_CAVEAT.slice(0, -1)}, and the findings say so.`);
    const wrong: string[] = [];
    for (let w = 0; w < 5 ** 4; w++) for (const descriptive of [null, 'too few worlds for a test']) {
      const words = KEYS.map((_, j) => CONFIRM_WORDS[Math.floor(w / 5 ** j) % 5]);
      const o = confirmOutcome(KEYS.map((key, i) => ({ key, word: words[i], descriptive: i === 0 ? descriptive : null, mean: 1, ci95: [-1, 3] as [number, number] })), { release: RELEASE });
      if (o.lesson !== expected[o.row] || o.caveat !== CONFIRM_LESSON_CAVEAT) wrong.push(`${words.join(' / ')}${descriptive ? ' (descriptive)' : ''}: row ${o.row}, lesson ${o.lesson}`);
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  // Value: protects=a server row left out after its pilot reads "not run (pilot failed: <reason>)" in both comparisons, is listed, sends nothing to GBRA-108 and can never make a class or the whole lead; fails_when=a comparison not run counts as ahead, level or descriptive, or the row is not listed; why_new=Amendment 1 (R111); seam=confirmOutcome; no_claim=which rows pass their pilots
  test('a server row left out: its comparisons read not run, it is listed, and it can never complete a class', () => {
    const out = (words: (ConfirmWord | null)[]) => confirmOutcome(KEYS.map((key, i) => (key.endsWith('memory-bank') ? { key, word: null, descriptive: null, notRun: NO_MEMORIES } : { key, word: words[i], descriptive: null, mean: 1, ci95: [-1, 3] as [number, number] })), { release: RELEASE });
    const both = out([null, 'ahead', null, 'ahead']);
    expect([both.row, both.headline]).toEqual([5, 'gbrain is ahead of the extract-first server on what is true now; gbrain is ahead of the extract-first server on questions about the past']);
    expect(both.publish).toEqual([
      'gbrain is ahead of the extract-first server on what is true now (+1.0 points, 95% interval -1.0 to +3.0).', 'gbrain is ahead of the extract-first server on questions about the past (+1.0 points, 95% interval -1.0 to +3.0).',
      `gbrain against the memory-bank server on what is true now: not run (pilot failed: ${NO_MEMORIES}).`, `gbrain against the memory-bank server on questions about the past: not run (pilot failed: ${NO_MEMORIES}).`,
      `The memory-bank server was left out: its pilot failed (${NO_MEMORIES}).`,
    ]);
    expect(both.next.comparisons).toEqual([]);
    const level = out([null, 'level within 3 points', null, 'level within 3 points']);
    expect([level.row, level.headline, level.next.comparisons]).toEqual([6, null, ['now|extract-first', 'past|extract-first']]);
  });
});

// ─── The look and the final (Amendments 1 and 2) ─────────────────────

/** A paired t with the given t on df degrees of freedom, a standard error of 1 (so the mean is t) and an SD of sqrt(df + 1). */
const pt = (t: number, df: number): PairedT => ({ n: df + 1, mean: t, sd: Math.sqrt(df + 1), se: 1, df, t, p_ahead: 0, p_behind: 0, ci95: [t - 2, t + 2] });
/** The t on df degrees of freedom whose z is z. */
const tFor = (z: number, df: number) => tQuantile(normalCdf(z), df);
/** A comparison at the look with a given mean and SD on 20 worlds. */
const lookTest = (key: string, mean: number, sd: number, descriptive: string | null = null): ConfirmTest => ({ key, descriptive, test: { n: 20, mean, sd, se: sd / Math.sqrt(20), df: 19, t: mean / (sd / Math.sqrt(20)), p_ahead: 0, p_behind: 0, ci95: [0, 0] } });
const LOOK = holmAlphas(4).map(a => obfBounds(a).look), FINAL = holmAlphas(4).map(a => obfBounds(a).final);

describe('the look and the final (Amendments 1 and 2)', () => {
  // Value: protects=the bounds are O'Brien-Fleming two-look bounds computed at each Holm step's one-sided alpha, not typed constants, and match Amendment 2's table; fails_when=the bivariate normal, the correlation, the root or the Holm alphas are wrong, or 0.025 does not give R113's 2.80 and 1.98; why_new=Amendment 2; seam=obfBounds, obfSpend, holmAlphas; no_claim=that O'Brien-Fleming is the best design
  test('the bounds by Holm step come from the bivariate normal, and one-sided 0.025 gives 2.797 and 1.977', () => {
    expect(holmAlphas(4)).toEqual([0.0125, 0.05 / 3, 0.025, 0.05]);
    expect(holmAlphas(2)).toEqual([0.025, 0.05]);
    expect([obfBounds(0.025).look.toFixed(3), obfBounds(0.025).final.toFixed(3)]).toEqual(['2.797', '1.977']);
    expect(LOOK.map(x => x.toFixed(3))).toEqual(['3.183', '3.026', '2.797', '2.373']);
    expect(FINAL.map(x => x.toFixed(3))).toEqual(['2.250', '2.140', '1.977', '1.678']);
    holmAlphas(4).forEach((a, i) => { expect(LOOK[i] / FINAL[i]).toBeCloseTo(Math.SQRT2, 12); expect(obfSpend(LOOK[i], FINAL[i])).toBeCloseTo(a, 9); });
    expect(obfSpend(0, 0)).toBeCloseTo(1 - (0.25 + Math.asin(Math.SQRT1_2) / (2 * Math.PI)), 9);
    expect(obfSpend(normalQuantile(0.975), Infinity)).toBeCloseTo(0.025, 9);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 14);
    expect(normalCdf(-8) / 6.22096057427174e-16).toBeCloseTo(1, 7);
  });

  // Value: protects=z is the normal score with the paired t's one-sided p, as the amendment and the simulation compute it; fails_when=z uses the t itself, the wrong tail, or loses its sign; why_new=Amendment 1; seam=confirmZ; no_claim=precision beyond the bounds
  test('z is the normal score with the same one-sided p as the paired t', () => {
    expect(confirmZ(tQuantile(0.975, 19), 19)).toBeCloseTo(1.959964, 5);
    expect(confirmZ(-tQuantile(0.975, 39), 39)).toBeCloseTo(-1.959964, 5);
    expect(confirmZ(2.5, 19)).toBeCloseTo(2.294872867188087, 8);
    expect(confirmZ(-1.3, 39)).toBeCloseTo(-1.2780493694650832, 8);
    expect(confirmZ(0, 19)).toBe(0);
    expect([confirmZ(Infinity, 39), confirmZ(-Infinity, 39)]).toEqual([Infinity, -Infinity]);
  });

  // Value: protects=Holm steps down over the z's with a bound per step, stopping at the first that falls short, at each step's look and final bound; fails_when=a comparison is checked against the wrong step's bound, a z exactly at a bound fails, or the step-down continues past a failure; why_new=Amendment 2; seam=holmCrosses; no_claim=power
  test('Holm\'s step-down at a step\'s look bound and at its final bound', () => {
    const under = (x: number) => x - 1e-9;
    expect(holmCrosses([LOOK[0], 0, 0, 0], LOOK)).toEqual([true, false, false, false]);
    expect(holmCrosses([under(LOOK[0]), 0, 0, 0], LOOK)).toEqual([false, false, false, false]);
    expect(holmCrosses([9, 0, LOOK[1], 0], LOOK)).toEqual([true, false, true, false]);
    expect(holmCrosses([9, 0, under(LOOK[1]), 0], LOOK)).toEqual([true, false, false, false]);
    expect(holmCrosses([FINAL[2], FINAL[3], FINAL[0], FINAL[1]], FINAL)).toEqual([true, true, true, true]);
    expect(holmCrosses([FINAL[2], under(FINAL[3]), FINAL[0], FINAL[1]], FINAL)).toEqual([true, false, true, true]);
    expect(holmCrosses([under(FINAL[0]), 9, 9, 9], FINAL)).toEqual([true, true, true, true]);
    expect(holmCrosses([under(FINAL[0]), 9, 0, 0], FINAL)).toEqual([true, true, false, false]);
    expect(holmCrosses([under(FINAL[0]), 0, 0, 0], FINAL)).toEqual([false, false, false, false]);
  });

  // Value: protects=the final's ahead and behind come from Holm's step-down over the 40-world z's with the final bounds, so the order of the z's matters, the frozen one-look thresholds no longer decide, and Holm runs over the comparisons that remain; fails_when=each comparison is checked alone against one bound, the frozen 2.241 still decides, behind is not mirrored, or a row left out still counts in Holm's steps; why_new=Amendment 2; seam=confirmFinal; no_claim=power
  test('the final: a second comparison at z 1.9, between step 4\'s and step 2\'s final bound, is ahead only when Holm reaches step 4', () => {
    const fin = (zs: number[], keys = KEYS) => confirmFinal(zs.map((z, i) => ({ key: keys[i], test: pt(tFor(z, 39), 39) }))).map(f => f.word);
    expect(FINAL[3]).toBeLessThan(1.9);
    expect(FINAL[1]).toBeGreaterThan(1.9);
    expect(fin([2.4, 1.9, 0.3, -0.2])).toEqual(['ahead', 'not behind by 3 points or more', 'level within 3 points', 'level within 3 points']);
    expect(fin([2.4, 1.9, 2.2, 2.0])).toEqual(['ahead', 'ahead', 'ahead', 'ahead']);
    expect(fin([-2.4, -1.9, -2.2, -2.0])).toEqual(['behind', 'behind', 'behind', 'behind']);
    expect(fin([FINAL[0] + 1e-4, 0, 0, 0])[0]).toBe('ahead');
    expect(fin([FINAL[0] - 1e-4, 0, 0, 0])[0]).toBe('not behind by 3 points or more');
    expect(fin([2.245, 0, 0, 0])[0]).toBe('not behind by 3 points or more');
    expect(fin([2.1, 0], ['now|extract-first', 'past|extract-first'])).toEqual(['ahead', 'level within 3 points']);
    expect(fin([2.1, 0, 0, 0])[0]).toBe('not behind by 3 points or more');
    const f = confirmFinal([{ key: KEYS[0], test: pt(1, 39) }])[0];
    const q = tQuantile(1 - 0.0125, 39);
    expect([f.lower, f.upper]).toEqual([1 - q, 1 + q]);
  });

  // Value: protects=the look crosses by Holm's step-down with the look bounds, calls a comparison futile below 10% conditional power for ahead (planned effect, the first 20 worlds' SD, final z 1.678), and stops only when every comparison has crossed or is futile; fails_when=the futility target, effect or SD is wrong, a descriptive or open comparison lets the run stop, or a crossed comparison loses its word; why_new=Amendments 1 and 2; seam=confirmLook, conditionalPower; no_claim=how often a real run stops
  test('the look: futility at 10% conditional power, and a stop only when all four are settled', () => {
    expect(conditionalPower(1.0, 3.5, 1.1)).toBeCloseTo(0.621832843205008, 9);
    expect(conditionalPower(-0.5, 4.83, 1.1)).toBeCloseTo(0.03457498453385732, 9);
    const sd = 4, at = 2 * (FINAL[3] * sd / Math.sqrt(40) - normalQuantile(0.9) * sd / Math.sqrt(80)) - 1.1;
    expect(conditionalPower(at, sd, 1.1)).toBeCloseTo(0.1, 8);
    const crossed = lookTest(KEYS[0], 10, 3), futile = (k: string) => lookTest(k, -2, 4);
    const look = (ef: ConfirmTest) => confirmLook([crossed, ef, futile(KEYS[2]), futile(KEYS[3])]);
    const above = look(lookTest(KEYS[1], at + 1e-4, sd)), below = look(lookTest(KEYS[1], at - 1e-4, sd));
    expect(above.comparisons.map(c => c.status)).toEqual(['crossed', 'open', 'futile', 'futile']);
    expect(above.stop).toBe(false);
    expect(below.comparisons.map(c => c.status)).toEqual(['crossed', 'futile', 'futile', 'futile']);
    expect(below.stop).toBe(true);
    expect(below.comparisons.map(c => c.word)).toEqual(['ahead', 'level within 3 points', 'no measurable difference', 'no measurable difference']);
    expect(look(futile(KEYS[1])).stop).toBe(true);
    expect(confirmLook([crossed, futile(KEYS[1]), futile(KEYS[2]), lookTest(KEYS[3], -2, 4, 'a reason')]).stop).toBe(false);
    expect(confirmLook([lookTest(KEYS[0], -10, 3), futile(KEYS[1]), futile(KEYS[2]), futile(KEYS[3])]).comparisons.map(c => [c.status, c.word])[0]).toEqual(['crossed', 'behind']);
    const z = (zz: number, k = KEYS[0]) => ({ key: k, test: { ...pt(tFor(zz, 19), 19) } });
    expect(confirmLook([z(LOOK[0] + 1e-4), z(0, KEYS[1]), z(0, KEYS[2]), z(0, KEYS[3])]).comparisons[0].status).toBe('crossed');
    expect(confirmLook([z(LOOK[0] - 1e-4), z(0, KEYS[1]), z(0, KEYS[2]), z(0, KEYS[3])]).comparisons[0].status).not.toBe('crossed');
    expect(confirmLook([z(2.9, KEYS[1]), z(0, KEYS[3])]).comparisons[0].status).toBe('crossed');
    expect(confirmLook([z(2.9), z(0, KEYS[1]), z(0, KEYS[2]), z(0, KEYS[3])]).comparisons[0].status).not.toBe('crossed');
  });

  test('only a server row can be left out, each with a reason, and one server must run', () => {
    expect(leftOutProblems({})).toEqual([]);
    expect(leftOutProblems({ 'memory-bank': NO_MEMORIES })).toEqual([]);
    expect(leftOutProblems({ gbrain: 'x' })).toEqual(["gbrain's row can't be left out; its failed pilot goes to GBEV-3"]);
    expect(leftOutProblems({ hybrid: 'x' })).toEqual(['hybrid is not a BG1-C server row (memory-bank or extract-first)']);
    expect(leftOutProblems({ 'extract-first': ' ' })).toEqual(['extract-first is left out without the reason its pilot failed']);
    expect(leftOutProblems({ 'memory-bank': 'a', 'extract-first': 'b' })).toEqual(['both server rows are left out, so no comparison runs']);
  });
});

// ─── A synthetic BG1-C input ─────────────────────────────────────────
// 40 worlds, two questions per kind: 10 on what is true now (30 reader answers) and 6 on the past (18). In each class
// gbrain gets its first 3 answers wrong (question by question, reader by reader) and a server its first 3 + delta, so a
// world's difference is delta x 100 / answers; delta alternates by world. The words that follow: ahead of the
// memory-bank server on what is true now, level with the extract-first server there, not behind the memory-bank server
// by 3 points on the past, and no measurable difference from the extract-first server there. On the first 20 worlds the
// look says: crossed, open, open, futile.
type Delta = Record<string, [number, number]>;
const DELTA: Delta = { 'now|memory-bank': [8, 9], 'now|extract-first': [1, -1], 'past|memory-bank': [3, -2], 'past|extract-first': [3, -3] };
/** On the first 20 worlds this stops the look: ahead of the memory-bank server on what is true now, behind the extract-first server there, and the past futile. */
const STOPS: Delta = { ...DELTA, 'now|extract-first': [0, -1], 'past|memory-bank': [1, -2] };
const GBRAIN_WRONG = 3;
const classOf = (s: Bg1Stratum) => (BG1_PRIMARY.includes(s) ? 'now' : 'past');
const val = (s: number): ReaderValue => ({ gating: s, canonical: null, match: s ? 'correct' : 'stale' });
interface Cell { conversation: string; stratum: Bg1Stratum; w: number; qi: number }
const CELLS_OF_WORLD: Cell[] = WORLDS.flatMap((conversation, w) => {
  const seen = { now: 0, past: 0 };
  return BG1_STRATA.flatMap(stratum => [0, 1].map(() => ({ conversation, stratum, w, qi: seen[classOf(stratum)]++ })));
});
const idOf = (c: Cell) => `${c.conversation}-${classOf(c.stratum)}-${c.qi}`;
const scoreOf = (row: Bg1Row, c: Cell, reader: number, delta: Delta = DELTA) => (c.qi * 3 + reader < GBRAIN_WRONG + (row === 'gbrain' ? 0 : delta[`${classOf(c.stratum)}|${row}`][c.w % 2]) ? 0 : 1);
const SERVERS: Bg1Row[] = ['memory-bank', 'extract-first'];

function confirmSynthetic(edit: (q: QuestionInput, c: Cell) => void = () => {}, o: { worlds?: number; delta?: Delta } = {}): Bg1Input {
  const worlds = WORLDS.slice(0, o.worlds ?? CONFIRM_N);
  const questions = CELLS_OF_WORLD.filter(c => c.w < worlds.length).map(c => {
    const rows: QuestionInput['rows'] = Object.fromEntries((['gbrain', ...SERVERS] as Bg1Row[]).map(row => [row, Object.fromEntries(READERS.map((r, i) => [r, val(scoreOf(row, c, i, o.delta))]))]));
    const q: QuestionInput = { id: idOf(c), conversation: c.conversation, stratum: c.stratum, rows, exposure: { gbrain: { gold: true, stale: c.w % 2 === 0, deciding_line: null } } };
    edit(q, c);
    return q;
  });
  return { set: 'BG1-C', questions, fill: { gbrain: 0.95, 'memory-bank': 0.95, 'extract-first': 0.95 },
    costs: (['gbrain', ...SERVERS] as Bg1Row[]).flatMap(row => READERS.flatMap(reader => worlds.map(conversation => ({ row, reader, conversation, usd: row === 'gbrain' ? 1 : 2 })))),
    snapshots: { [ASTRA]: ['gpt-6-astra-2026-10-01'], [OPUS]: ['claude-opus-5-5-20261001'] } };
}

describe('the confirm analysis', () => {
  const a = analyzeConfirm(confirmSynthetic(), { release: RELEASE });

  // Value: protects=the estimand and the final rule the amendments fix; fails_when=a question's score is not the three readers' mean, a world's difference is not the class mean of gbrain minus the server, z is not the paired t's normal score, or the 3-point bounds are not at 0.05 / 4; why_new=BG1-C harness item 3 and Amendment 2; seam=analyzeConfirm; no_claim=the sealed result
  test('the estimand: three-reader question scores, class means per world, Holm\'s step-down with the final bounds over the four comparisons', () => {
    expect(a.stage).toBe('final');
    expect(a.comparisons.map(c => [c.key, c.word, c.descriptive])).toEqual([
      ['now|memory-bank', 'ahead', null], ['now|extract-first', 'level within 3 points', null],
      ['past|memory-bank', 'not behind by 3 points or more', null], ['past|extract-first', 'no measurable difference', null],
    ]);
    expect(a.comparisons.map(c => [c.worlds, c.questions])).toEqual([[40, 400], [40, 400], [40, 240], [40, 240]]);
    expect(a.comparisons[0].test!.mean).toBeCloseTo((8 + 9) / 2 * 100 / 30, 9);
    expect(a.comparisons[2].test!.mean).toBeCloseTo((3 - 2) / 2 * 100 / 18, 9);
    expect(a.comparisons[1].test!.mean).toBeCloseTo(0, 9);
    expect(a.holm_over).toEqual(KEYS);
    expect(a.bounds).toEqual({ stage: 'final', holm_alphas: holmAlphas(4), z: [2.2505, 2.14, 1.9774, 1.678], three_point_alpha: 0.0125 });
    expect(a.comparisons.every(c => c.three_point!.alpha === 0.0125 && c.test!.df === 39)).toBe(true);
    expect(a.comparisons.slice(1).map(c => c.z)).toEqual(a.comparisons.slice(1).map(c => Math.round(confirmZ(c.test!.t, 39) * 1e4) / 1e4));
    expect(a.not_run).toEqual([]);
    expect([a.worlds, a.planned, a.common]).toEqual([40, 640, 640]);
  }, 60_000);

  test('the outcome is row 5 with its sentences from code, and the worst case agrees', () => {
    expect(a.outcome.row).toBe(5);
    expect(a.outcome.headline).toBe('gbrain is ahead of the memory-bank server on what is true now');
    expect(a.outcome.publish[0]).toMatch(/^gbrain is ahead of the memory-bank server on what is true now \(\+28\.3 points, 95% interval \+\d+\.\d to \+\d+\.\d\)\.$/);
    expect(a.outcome.publish).toHaveLength(4);
    expect(a.outcome.readme.line).toBe(a.outcome.publish.join(' '));
    expect(a.worst_case).toEqual({ words: a.comparisons.map(c => c.word!), row: 5, disagrees: false });
  });

  test('reported beside it: intervals, counts and the wild bootstrap; per kind, per reader and pooled, unadjusted; fill, drops, exposure, the matcher and cost per correct answer', () => {
    const ef = a.comparisons[1];
    expect([ef.better, ef.worse, ef.same]).toEqual([20, 20, 360]);
    expect(ef.test!.ci95[0]).toBeLessThan(0);
    expect(ef.wild!.method).toContain('restricted wild cluster bootstrap-t');
    expect(a.per_kind.map(k => k.stratum)).toEqual([...BG1_STRATA]);
    expect(a.per_kind[0].rows['memory-bank']).toMatchObject({ worlds: 40, mean: 50, note: 'unadjusted' });
    expect(a.per_reader.map(r => r.reader)).toEqual([OPUS, CONFIRM_SOL, PARTICLE]);
    expect(a.per_reader[0].classes.now!['memory-bank']).toMatchObject({ mean: 30, note: 'unadjusted' });
    expect(a.pooled.strata).toEqual([...BG1_STRATA]);
    expect(a.pooled.rows['memory-bank'].mean).toBeCloseTo(18.75, 3);
    expect(a.fill).toEqual({ gbrain: { mean_fill: 0.95, pass: true }, 'memory-bank': { mean_fill: 0.95, pass: true }, 'extract-first': { mean_fill: 0.95, pass: true } });
    expect(a.drops.all).toEqual({ planned: 640, dropped: 0, share: 0, by: {} });
    expect(a.exposure.gbrain!.all.contexts).toBe(640);
    expect(a.matcher.answers).toBe(640 * 9);
    expect(a.cost_per_correct.table.map(t => t.reader)).toEqual([OPUS, PARTICLE, CONFIRM_SOL]);
    expect(a.cost_per_correct.comparisons.map(c => c.row)).toEqual(['memory-bank', 'extract-first']);
    expect(Object.keys(a.row_means)).toEqual(['gbrain', 'memory-bank', 'extract-first']);
    expect(JSON.stringify(a)).not.toMatch(/temporal-graph|hybrid|gpt-6\.1-sol/);
  });

  // Value: protects=the drop cap counts each comparison's own planned questions, so a class above 5% is incomplete while the other class keeps its words; fails_when=one share over all 64 questions decides, or a drop-capped comparison still sets a row; why_new=BG1-C harness item 3; seam=analyzeConfirm; no_claim=which drops a real run has
  test('above 5% of a class\'s planned questions dropped, its two comparisons are descriptive and the outcome is row 1', () => {
    const over = analyzeConfirm(confirmSynthetic((q, c) => { if (classOf(c.stratum) === 'past' && c.qi === 0 && c.w < 13) q.rows['memory-bank']![PARTICLE] = { drop: 'reread_answer_missing' }; }), { release: RELEASE });
    const reason = '13 of 240 planned questions on questions about the past dropped (5.4%, above the 5% cap)';
    expect(over.comparisons.map(c => c.descriptive)).toEqual([null, null, reason, reason]);
    expect(over.drops.by_class.past).toEqual({ planned: 240, dropped: 13, share: 13 / 240, by: { 'other|reread_answer_missing': 13 } });
    expect(over.outcome.row).toBe(1);
    expect(over.outcome.headline).toBeNull();
    expect(over.outcome.readme.line).toBe(`A confirmation on new sealed worlds (gbrain ${RELEASE}) was incomplete: ${reason}.`);
    expect(over.outcome.publish.filter(l => l.endsWith(`, descriptive: ${reason}.`)).map(l => l.includes('on questions about the past'))).toEqual([true, true]);
    const at = analyzeConfirm(confirmSynthetic((q, c) => { if (classOf(c.stratum) === 'past' && c.qi === 0 && c.w < 12) q.rows['memory-bank']![PARTICLE] = { drop: 'reread_answer_missing' }; }), { release: RELEASE });
    expect(at.comparisons.every(c => c.descriptive === null)).toBe(true);
    expect(at.outcome.row).not.toBe(1);
  }, 60_000);

  // Value: protects=a row below the 0.90 fill gate makes every comparison it enters descriptive; fails_when=a server's or gbrain's gate failure is ignored or spreads to the other server's comparisons; why_new=BG1-C harness item 3; seam=analyzeConfirm; no_claim=real fill rates
  test('a row below the 0.90 fill gate makes the comparisons it enters descriptive, and the outcome row 1', () => {
    const low = confirmSynthetic();
    low.fill['extract-first'] = 0.85;
    const one = analyzeConfirm(low, { release: RELEASE });
    const reason = 'extract-first failed the delivered-context gate (mean fill rate 0.85, below 0.9)';
    expect(one.comparisons.map(c => c.descriptive)).toEqual([null, reason, null, reason]);
    expect(one.outcome.row).toBe(1);
    expect(one.outcome.readme.line).toBe(`A confirmation on new sealed worlds (gbrain ${RELEASE}) was incomplete: ${reason}.`);
    low.fill.gbrain = null;
    expect(analyzeConfirm(low, { release: RELEASE }).comparisons.every(c => c.descriptive!.startsWith('gbrain failed the delivered-context gate (mean fill rate unknown, below 0.9)'))).toBe(true);
  }, 60_000);

  // Value: protects=the worst case reruns the final rule with every gbrain drop 0 and every server drop 1, and a disagreement is said first; fails_when=the worst case is skipped, scored the other way round, or printed after the row's lines; why_new=BG1-C harness item 3; seam=analyzeConfirm, confirmOutcome; no_claim=how many drops a real run has
  test('the worst case scores gbrain drops 0 and server drops 1, and a disagreement is the first published line', () => {
    const drops = analyzeConfirm(confirmSynthetic((q, c) => { if (classOf(c.stratum) === 'now' && c.qi === 9 && c.w < 19) for (const r of READERS) q.rows.gbrain![r] = { drop: 'reader_error' }; }), { release: RELEASE });
    expect(drops.drops.by_class.now).toMatchObject({ planned: 400, dropped: 19 });
    expect(drops.comparisons.every(c => c.descriptive === null)).toBe(true);
    expect(drops.outcome.row).toBe(5);
    expect(drops.worst_case.disagrees).toBe(true);
    expect(drops.worst_case.words![1]).toBe('behind');
    expect(drops.worst_case.row).toBe(2);
    expect(drops.outcome.publish[0]).toBe('The worst case, which scores every gbrain drop 0 and every server drop 1, disagrees: on what is true now against the extract-first server it reads "behind" instead of "level within 3 points".');
  }, 60_000);

  // Value: protects=the final reads exactly the 40 kept worlds and the look exactly the first 20, and both read BG1-C only; fails_when=a final runs on the 20 worlds of the look, or a look on all 40; why_new=Amendment 1; seam=analyzeConfirm, lookConfirm; no_claim=custody
  test('it reads a BG1-C input only, the final all 40 kept worlds and the look the first 20', () => {
    expect(() => analyzeConfirm({ ...confirmSynthetic(), set: 'BG1' }, { release: RELEASE })).toThrow('the confirm mode reads set BG1-C only, not BG1');
    expect(() => analyzeConfirm(confirmSynthetic(undefined, { worlds: 20 }), { release: RELEASE })).toThrow('the final analysis reads all 40 kept worlds, and the input holds 20');
    expect(() => lookConfirm(confirmSynthetic(), { release: RELEASE })).toThrow('the look reads the first 20 kept worlds, and the input holds 40');
    expect(() => analyzeConfirm(confirmSynthetic(), { release: RELEASE, leftOut: { gbrain: 'x' } })).toThrow("gbrain's row can't be left out");
  });

  // Value: protects=a look that settles nothing decides nothing: it prints continue with each comparison's z, conditional power and status, and no word, mean, interval or row; fails_when=the continue record carries a word, an outcome, a mean or the report; why_new=Amendment 1; seam=lookConfirm; no_claim=how often the sealed look continues
  test('the look decides nothing unless all four are settled: continue, with z, conditional power and status only', () => {
    const l = lookConfirm(confirmSynthetic(undefined, { worlds: CONFIRM_LOOK_N }), { release: RELEASE });
    expect(l.decision).toBe('continue');
    expect(l.verdict).toBeNull();
    expect(Object.keys(l).sort()).toEqual(['comparisons', 'decision', 'left_out', 'release', 'schema', 'verdict', 'worlds']);
    expect(l.comparisons.map(c => Object.keys(c).sort().join(','))).toEqual(KEYS.map(() => 'cp,key,reason,status,z'));
    expect(l.comparisons.map(c => c.status)).toEqual(['crossed', 'open', 'open', 'futile']);
    expect(l.comparisons[3].cp!).toBeLessThan(0.1);
    expect(l.comparisons[1].cp!).toBeGreaterThan(0.1);
    expect(JSON.stringify(l)).not.toMatch(/ahead|behind|level|measurable|mean|ci95|outcome|row/);
  });

  // Value: protects=a look where every comparison has crossed or is futile stops the run: crossed comparisons keep their word, the futile ones take the 3-point readings on the 20 worlds, the outcome row follows, and the results say the run stopped and its estimates may be overstated; fails_when=a futile comparison keeps a directional word, the stop sentence is missing, or the worst case uses another rule; why_new=Amendment 1; seam=lookConfirm, confirmOutcome; no_claim=how often a real run stops
  test('a look where all four are settled stops the run, with the row from the table and the stop sentence last', () => {
    const l = lookConfirm(confirmSynthetic(undefined, { worlds: CONFIRM_LOOK_N, delta: STOPS }), { release: RELEASE });
    expect(l.decision).toBe('stop');
    expect(l.comparisons.map(c => c.status)).toEqual(['crossed', 'crossed', 'futile', 'futile']);
    const v = l.verdict!;
    expect([v.stage, v.worlds, v.bounds.z]).toEqual(['look', 20, [3.1826, 3.0264, 2.7965, 2.373]]);
    expect(v.comparisons.map(c => [c.word, c.status])).toEqual([['ahead', 'crossed'], ['behind', 'crossed'], ['no measurable difference', 'futile'], ['no measurable difference', 'futile']]);
    expect(v.comparisons.every(c => c.test!.df === 19 && c.three_point!.alpha === 0.0125)).toBe(true);
    expect(v.outcome.row).toBe(2);
    expect(v.outcome.publish[0]).toStartWith('gbrain is behind the extract-first server on what is true now');
    expect(v.outcome.publish.at(-1)).toBe(CONFIRM_STOP_SENTENCE);
    expect(v.outcome.readme.line.endsWith(` ${CONFIRM_STOP_SENTENCE}`)).toBe(true);
    expect(v.worst_case).toEqual({ words: ['ahead', 'behind', 'no measurable difference', 'no measurable difference'], row: 2, disagrees: false });
  });

  // Value: protects=at a stop a futile comparison takes its 3-point reading on the 20 worlds from the 0.0125 bounds: level within 3 points, not behind by 3 points or more, or no measurable difference when neither holds, and the published lines say it; fails_when=a futile comparison at a stop always reads "no measurable difference", reads on other bounds or another number of worlds, or keeps a directional word; why_new=Amendment 3; seam=confirmLook, confirmBounds, threePoint, confirmOutcome; no_claim=how often a real run stops
  test('at a stop, each futile comparison takes its 3-point reading on the 20 worlds: level within 3 points, not behind by 3 points or more, or no measurable difference', () => {
    const q = tQuantile(1 - 0.05 / 4, 19) / Math.sqrt(20);
    const crossed = lookTest(KEYS[0], 10, 3), futile = (k: string) => lookTest(k, -2, 4);
    for (const [mean, sd, word] of [[-1.5, 2, 'level within 3 points'], [0.15, 5.5, 'not behind by 3 points or more'], [-3, 4, 'no measurable difference']] as const) {
      const l = confirmLook([crossed, lookTest(KEYS[1], mean, sd), futile(KEYS[2]), futile(KEYS[3])]), c = l.comparisons[1];
      expect([l.stop, c.status, c.word]).toEqual([true, 'futile', word]);
      expect([c.lower, c.upper]).toEqual([confirmBounds(lookTest(KEYS[1], mean, sd).test).lower, confirmBounds(lookTest(KEYS[1], mean, sd).test).upper]);
      expect(c.lower).toBeCloseTo(mean - q * sd, 9);
      const o = confirmOutcome(l.comparisons.map(x => ({ key: x.key, word: x.word, descriptive: null, mean: 1, ci95: [-1, 3] as [number, number] })), { release: RELEASE, stopped: true });
      expect(o.publish).toContain(`${confirmPhrase({ key: KEYS[1], word, descriptive: null, mean: 1, ci95: [-1, 3] })}.`);
      expect(o.publish.at(-1)).toBe(CONFIRM_STOP_SENTENCE);
    }
  });

  // Value: protects=a server row left out reads "not run (pilot failed: <reason>)" in both comparisons, Holm runs over the two that remain with their own steps, and the results list the row; fails_when=the left-out row's comparisons are tested, still count in Holm's steps or vanish from the results; why_new=Amendment 1 (R111); seam=analyzeConfirm; no_claim=which rows pass their pilots
  test('a server row left out: its two comparisons are not run, Holm runs over the other two, and the results list it', () => {
    const left = analyzeConfirm(confirmSynthetic(), { release: RELEASE, leftOut: { 'memory-bank': NO_MEMORIES } });
    expect(left.comparisons.map(c => [c.key, c.word])).toEqual([['now|extract-first', 'level within 3 points'], ['past|extract-first', 'no measurable difference']]);
    expect(left.not_run).toEqual([
      { key: 'now|memory-bank', class: 'now', server: 'memory-bank', status: `not run (pilot failed: ${NO_MEMORIES})` },
      { key: 'past|memory-bank', class: 'past', server: 'memory-bank', status: `not run (pilot failed: ${NO_MEMORIES})` },
    ]);
    expect(left.holm_over).toEqual(['now|extract-first', 'past|extract-first']);
    expect(left.bounds.z).toEqual([1.9774, 1.678]);
    expect(left.left_out).toEqual([{ row: 'memory-bank', reason: NO_MEMORIES }]);
    expect([left.outcome.row, left.outcome.headline]).toEqual([6, null]);
    expect(left.outcome.publish).toContain(`gbrain against the memory-bank server on what is true now: not run (pilot failed: ${NO_MEMORIES}).`);
    expect(left.outcome.publish.at(-1)).toBe(`The memory-bank server was left out: its pilot failed (${NO_MEMORIES}).`);
    expect(Object.keys(left.fill)).toEqual(['gbrain', 'extract-first']);
    expect(left.worst_case.words).toEqual([null, 'level within 3 points', null, 'no measurable difference']);
  }, 60_000);
});

// ─── Receipts, the manifest and the kept list ────────────────────────
const QUESTIONS: MemoryQuestion[] = CELLS_OF_WORLD.map(c => ({
  id: idOf(c), conversation: c.conversation, question: 'Which city is current?', answer: 'Porto', category: c.stratum, gold: [], abstention: false,
  bg1: { stratum: c.stratum, family: classOf(c.stratum) === 'now' ? 'primary' : 'secondary', form: 'exact', slot: 'person-01.city', gold_values: ['Porto'], stale_values: ['Lisbon'], decoy_values: ['Braga'] },
}) as unknown as MemoryQuestion);
const CELL_OF = new Map(CELLS_OF_WORLD.map(c => [idOf(c), c]));
/** BG1-C's three counted rows as the committed cell set defines them (eval/runner/q1/cells/bg1c-cells.json), read live by claude-opus-5-5 and gpt-6.2-sol. */
const CELLS: CellDefinition[] = confirmCells((JSON.parse(readFileSync(CONFIRM_CELLS_PATH, 'utf8')) as { cells: CellDefinition[] }).cells);
/** Each kept world's plan: its one tracked entity, person-01, is Ana Silva. */
const ENTITY = 'Ana Silva';
const PLANS: ReadonlyMap<string, WorldPlan> = new Map(WORLDS.map(w => [w, { entities: [{ id: 'person-01', name: ENTITY }] }]));
const manifestOf = (o: Record<string, unknown> = {}) => new TextEncoder().encode(JSON.stringify({ dataset: 'BG1-C test', status: 'filled', files: [{ path: 'worlds/bg1-031/world.json', sha256: 'a'.repeat(64) }], kept: WORLDS, n_final: CONFIRM_N, ...o }));
const MANIFEST = manifestOf();
const ndjson = (path: string, rows: unknown[]) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, rows.map(r => JSON.stringify(r) + '\n').join('')); };

/** particle-1's re-read plans by half for the counted rows, as bg1c.ts gives them to the cell set: .h1 re-reads launch units 0 to 3, .h2 units 4 to 7. */
const HALF_PLANS = bg1cRereadPlans(CELLS).filter(p => p.half !== null);
/** One particle-1 re-read receipt of a row: its half, the worlds its answers cover, and optionally another --receipts root, cell id or receipt fields. */
interface Reread { half: 1 | 2; worlds: readonly string[]; root?: string; id?: string; receipt?: Record<string, unknown> }
/** Writes a row's re-reads: write writes one receipt, and standard writes the usual one per half over the fixture's worlds. */
type Rereads = (write: (r: Reread) => void, def: CellDefinition, standard: () => void) => void;
interface Opts { worlds?: readonly string[]; dataset?: (d: { files: Array<{ path: string; sha256: string }> }) => void; config?: (c: Record<string, any>) => void; contexts?: (system: string, q: MemoryQuestion) => string | null; rereads?: Rereads }
let n = 0;
function receipts(o: Opts = {}) {
  const root = join(tmp, `r${++n}`);
  const instrument = instrumentFor(CELLS[0].canonical_instrument!);
  const worlds = new Set(o.worlds ?? WORLDS);
  const qs = QUESTIONS.filter(q => worlds.has(q.conversation)).concat(o.worlds ? o.worlds.filter(w => !WORLDS.includes(w)).map(w => ({ ...QUESTIONS[0], id: `${w}-now-0`, conversation: w })) : []);
  const dataset = { name: 'BG1-C test', files: [{ path: CONFIRM_MANIFEST_REL, sha256: sha(MANIFEST) }], revision: sha(MANIFEST).slice(0, 7), license: 'custodian-held' };
  o.dataset?.(dataset);
  const judgment = (answer_id: string, judge: string, instrument_id: string, score: number, gating: boolean) => ({
    answer_id, instrument_id, instrument_sha256: instrument.sha256, judge, judge_replicate: 0, temperature: null, score, parse_ok: true, raw_sha256: sha(judge + answer_id), outcome: 'scored',
    ...(gating ? { view: 'gating', settings: { ...PER_READER_JUDGE_SETTINGS }, judge_versions: [`${judge}-v1`] } : {}),
  });
  const answer = (cell_id: string, system: string, arm: string, q: MemoryQuestion, reader: string) => ({
    answer_id: answerId(cell_id, q.id, reader, 0), cell_id, realization_id: 'r0', question_id: q.id, conversation: q.conversation, system, arm, reader, replicate: 0, effort: 'medium',
    context_sha256: sha(`ctx|${system}|${q.id}`), text: 'Porto', usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 }, provider_input_tokens: 10, latency_ms: 1, outcome: 'scored',
  });
  const scored = (role: Bg1Row, q: MemoryQuestion, reader: string) => { const c = CELL_OF.get(q.id); return c ? scoreOf(role, c, READERS.indexOf(reader)) : 1; };
  for (const def of CELLS) {
    const arm = def.arms[0], role = ROLES[def.system];
    const dir = join(root, 'cells', arm.cell_id);
    mkdirSync(dir, { recursive: true });
    const config = JSON.parse(runConfigText(def, arm, { instrument, dataset, scheduledSha: 'x', limit: null }));
    o.config?.(config);
    writeFileSync(join(dir, 'run-config.json'), JSON.stringify(config));
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ cell_id: arm.cell_id, run_cell: def.id, run_status: 'complete', instrument: { id: instrument.id, sha256: instrument.sha256 }, config_sha256: `cfg-${def.system}`, spend: { usd: { ingest: 0.3, retrieval: 0.1 } } }));
    ndjson(join(dir, 'rows.ndjson'), qs.map(q => ({ id: q.id, cell_id: arm.cell_id, conversation: q.conversation, fill_rate: 0.95 })));
    const answers = qs.flatMap(q => CONFIRM_LIVE_READERS.map(r => answer(arm.cell_id, def.system, arm.id, q, r)));
    ndjson(join(dir, 'answers.ndjson'), answers);
    ndjson(join(dir, 'judgments.ndjson'), answers.map(a => judgment(a.answer_id, bg1JudgeOf(a.reader), frontierInstrumentId(instrument.id, bg1JudgeOf(a.reader)), scored(role, qs.find(q => q.id === a.question_id)!, a.reader), true)));
    const contexts = o.contexts ? qs.flatMap(q => { const prompt = o.contexts!(def.system, q); return prompt === null ? [] : [{ key: `r0|${q.id}|${arm.id}`, prompt, meta: { context_sha256: sha(`ctx|${def.system}|${q.id}`) } }]; }) : [];
    if (contexts.length) ndjson(join(root, 'runs', def.id, 'contexts.ndjson'), contexts);
    const write = (r: Reread) => {
      const plan = HALF_PLANS.find(p => p.arm_cell_id === arm.cell_id && p.half === r.half)!;
      const rid = r.id ?? plan.id, rdir = join(r.root ?? root, 'cells', rid);
      mkdirSync(rdir, { recursive: true });
      const rq = qs.filter(q => r.worlds.includes(q.conversation));
      writeFileSync(join(rdir, 'receipt.json'), JSON.stringify({ cell_id: rid, keyless: false, run_status: 'complete', dataset, instrument: { id: instrument.id, sha256: instrument.sha256 }, source: { config_sha256s: [`cfg-${def.system}`] },
        half: { plan: plan.id, half: plan.half, units: plan.units }, spend: { reader_usd: 0.48 * rq.length / qs.length }, ...r.receipt }));
      const rereads = rq.map(q => answer(rid, def.system, arm.id, q, PARTICLE));
      ndjson(join(rdir, 'answers.ndjson'), rereads);
      ndjson(join(rdir, 'judgments.ndjson'), rereads.map(a => judgment(a.answer_id, OPUS, frontierInstrumentId(instrument.id, OPUS), scored(role, qs.find(q => q.id === a.question_id)!, PARTICLE), true)));
    };
    const standard = () => { for (const half of [1, 2] as const) { const ws = [...worlds].filter(w => (WORLDS.indexOf(w) >= 0 && WORLDS.indexOf(w) < CONFIRM_LOOK_N ? 1 : 2) === half); if (ws.length) write({ half, worlds: ws }); } };
    (o.rereads ?? ((_w, _d, s) => s()))(write, def, standard);
  }
  return root;
}
const DEPS = { questions: QUESTIONS, cells: CELLS, manifestBytes: MANIFEST, plans: PLANS };
const load = (root: string, o: { manifestPath?: string; manifestBytes?: Uint8Array; cells?: CellDefinition[]; cellsPath?: string; questions?: MemoryQuestion[]; plans?: ReadonlyMap<string, WorldPlan> } = {}) =>
  loadInput([root], { set: 'BG1-C', manifestPath: o.manifestPath, cellsPath: o.cellsPath }, { questions: o.questions ?? QUESTIONS, cells: o.cellsPath ? undefined : (o.cells ?? CELLS), manifestBytes: o.manifestPath ? undefined : (o.manifestBytes ?? MANIFEST), plans: o.plans ?? PLANS });

describe('BG1-C receipts', () => {
  const root = receipts();
  const half = receipts({ worlds: WORLDS.slice(0, CONFIRM_LOOK_N) });

  test('reads the three rows with gpt-6.2-sol and particle-1, and gives the same verdict as the synthetic input', () => {
    const input = load(root);
    expect(input.questions).toHaveLength(640);
    expect(Object.keys(input.questions[0].rows).sort()).toEqual(['extract-first', 'gbrain', 'memory-bank']);
    expect(Object.keys(input.questions[0].rows.gbrain!)).toEqual(READERS);
    expect(input.questions.every(q => Object.values(q.rows).every(v => READERS.every(r => v![r] && !('drop' in v![r]))))).toBe(true);
    const a = analyzeConfirm(input, { release: RELEASE });
    expect([a.outcome.row, a.common]).toEqual([5, 640]);
    expect(a.comparisons.map(c => c.word)).toEqual(['ahead', 'level within 3 points', 'not behind by 3 points or more', 'no measurable difference']);
  }, 60_000);

  // Value: protects=the look reads exactly the first 20 kept worlds, the final exactly all 40, and a row left out needs no receipts; fails_when=a look reads the final's receipts, a final runs on the look's 20 worlds, or a left-out row's receipts are read or required; why_new=Amendment 1; seam=loadInput set BG1-C; no_claim=launch units
  test('the look reads exactly the first 20 kept worlds, the final all 40, and a row left out needs no receipts', () => {
    const look = loadInput([half], { set: 'BG1-C', look: true }, DEPS);
    expect(new Set(look.questions.map(q => q.conversation)).size).toBe(CONFIRM_LOOK_N);
    expect(() => loadInput([root], { set: 'BG1-C', look: true }, DEPS)).toThrow('the receipts must hold exactly the first 20 kept worlds; missing none; outside that set');
    expect(() => loadInput([half], { set: 'BG1-C' }, DEPS)).toThrow(`the receipts must hold exactly the first 40 kept worlds; missing ${WORLDS.slice(20).join(', ')}; outside that set none`);
    const left = loadInput([root], { set: 'BG1-C', leftOut: ['memory-bank'] }, { ...DEPS, cells: CELLS.filter(c => c.system !== 'ext-memory-bank').concat(CELLS.filter(c => c.system === 'ext-memory-bank')) });
    expect(Object.keys(left.questions[0].rows).sort()).toEqual(['extract-first', 'gbrain']);
    expect(() => loadInput([root], { set: 'BG1', look: true }, DEPS)).toThrow('the look and rows left out are BG1-C\'s only');
  });

  // Value: protects=a counted row's particle-1 re-reads are read by half under the cell set's plans: the look reads half 1 and refuses half 2, the final reads both, each half's receipts (one per launch unit or one for the half) hold exactly its units' kept worlds and name their plan, and a re-read under the plain id refuses; fails_when=a plain-id re-read is read for a counted row, half 2 is read at the look, a half with a gap or a world outside it passes, a world re-read in both halves passes, a receipt naming another plan or none is read, or the final reads half 1 alone; why_new=BG1-C's half re-read ids (2247f1d5b), the wiring gap; seam=loadInput set BG1-C; no_claim=reread-cell.ts's own staging check
  test('particle-1 re-reads are read by half: half 1 at the look, both halves at the final, each holding exactly its units\' kept worlds', () => {
    const gb = CELLS[0], plain = rereadCellId(gb.arms[0].cell_id, PARTICLE);
    const plan = (half: 1 | 2) => HALF_PLANS.find(p => p.cell === gb.id && p.half === half)!;
    const committed = (JSON.parse(readFileSync(CONFIRM_CELLS_PATH, 'utf8')) as { reread_plans: Array<{ id: string; half: 1 | 2 | null; units: number[] }> }).reread_plans.filter(p => p.half !== null);
    expect(HALF_PLANS.map(p => [p.id, p.half, p.units])).toEqual(committed.map(p => [p.id, p.half, p.units]));
    expect([plan(1).id, plan(1).units, plan(2).id, plan(2).units]).toEqual([`${plain}.h1`, [0, 1, 2, 3], `${plain}.h2`, [4, 5, 6, 7]]);
    const H1 = WORLDS.slice(0, CONFIRM_LOOK_N), H2 = WORLDS.slice(CONFIRM_LOOK_N);
    const gbrainOnly = (custom: (write: (r: Reread) => void) => void): Rereads => (write, def, standard) => (def.id === gb.id ? custom(write) : standard());
    const loaded = (r: string, look = false, more: string[] = []) => loadInput([r, ...more], { set: 'BG1-C', look }, DEPS);
    const units = join(tmp, `units-${++n}`), unitRoots = Array.from({ length: 8 }, (_, u) => join(units, `u${u}`));
    const byUnit = receipts({ rereads: gbrainOnly(write => unitRoots.forEach((r, u) => write({ half: u < 4 ? 1 : 2, worlds: WORLDS.slice(u * 5, u * 5 + 5), root: r }))) });
    expect(loaded(byUnit, false, unitRoots).questions).toEqual(load(root).questions);
    expect(loaded(half, true).questions.every(q => READERS.every(r => !('drop' in q.rows.gbrain![r])))).toBe(true);
    expect(() => loaded(receipts({ worlds: H1, rereads: gbrainOnly(write => { write({ half: 1, worlds: H1 }); write({ half: 2, worlds: [] }); }) }), true))
      .toThrow(`: the look reads only half 1's particle-1 re-reads, and this one is ${plan(2).id}`);
    const withPlain = receipts({ rereads: (write, def, standard) => { standard(); if (def.id === gb.id) write({ half: 1, worlds: [], id: plain, receipt: { half: undefined } }); } });
    expect(() => loaded(withPlain)).toThrow(`: ${gb.id} is a counted BG1-C cell, so its particle-1 re-reads go under its half plans (${plan(1).id}, ${plan(2).id}), not ${plain}`);
    expect(() => loaded(receipts({ rereads: gbrainOnly(write => write({ half: 1, worlds: H1 })) })))
      .toThrow(`${plan(2).id}: half 2's re-reads must hold exactly the kept worlds of launch units 4, 5, 6, 7; missing ${H2.join(', ')}; outside that half none`);
    expect(() => loaded(receipts({ rereads: gbrainOnly(write => { write({ half: 1, worlds: H1 }); write({ half: 2, worlds: H2.slice(1) }); }) })))
      .toThrow(`${plan(2).id}: half 2's re-reads must hold exactly the kept worlds of launch units 4, 5, 6, 7; missing ${H2[0]}; outside that half none`);
    expect(() => loaded(receipts({ rereads: gbrainOnly(write => { write({ half: 1, worlds: [...H1, H2[0]] }); write({ half: 2, worlds: H2.slice(1) }); }) })))
      .toThrow(`${plan(1).id}: half 1's re-reads must hold exactly the kept worlds of launch units 0, 1, 2, 3; missing none; outside that half ${H2[0]}`);
    expect(() => loaded(receipts({ rereads: gbrainOnly(write => { write({ half: 1, worlds: [...H1, H2[0]] }); write({ half: 2, worlds: H2 }); }) })))
      .toThrow(`${plan(2).id}: world ${H2[0]} is re-read in both `);
    expect(() => loaded(receipts({ rereads: gbrainOnly(write => { write({ half: 1, worlds: H1, receipt: { half: { plan: plan(1).id, half: 1, units: [0, 1, 2] } } }); write({ half: 2, worlds: H2 }); }) })))
      .toThrow(`: its receipt names re-read plan {"plan":"${plan(1).id}","half":1,"units":[0,1,2]}, not ${plan(1).id} (half 1, units 0, 1, 2, 3)`);
    expect(() => loaded(receipts({ rereads: gbrainOnly(write => { write({ half: 1, worlds: H1 }); write({ half: 2, worlds: H2, receipt: { half: undefined } }); }) })))
      .toThrow(`: its receipt names re-read plan null, not ${plan(2).id} (half 2, units 4, 5, 6, 7)`);
    expect(() => loaded(receipts({ rereads: gbrainOnly(() => {}) }))).toThrow(`missing particle-1 re-read: ${gb.arms[0].cell_id} has 1 receipt(s) no ${plan(1).id} or ${plan(2).id} covers`);
  }, 120_000);

  // Value: protects=a BG1-C verdict reads only the filled BG1-C manifest, which must exist and be filled; fails_when=a missing, unfilled or BG1 manifest is read, or the default path is not the BG1-C manifest; why_new=BG1-C harness item 3; seam=loadInput set BG1-C; no_claim=custody of the bytes
  test('refuses a missing or unfilled BG1-C manifest, by default at eval/decisions/datasets/bg1c-manifest.json', () => {
    expect(() => load(root, { manifestPath: join(tmp, 'nowhere', 'bg1c-manifest.json') })).toThrow(/the BG1-C manifest .*nowhere\/bg1c-manifest\.json does not exist/);
    expect(() => load(root, { manifestBytes: new TextEncoder().encode(JSON.stringify({ status: 'unfilled', files: [] })) })).toThrow('the BG1-C manifest is unfilled');
    expect(() => load(root, { manifestBytes: manifestOf({ kept: [] }) })).toThrow('the BG1-C manifest is unfilled');
    expect(() => loadInput([root], { set: 'BG1-C' }, { questions: QUESTIONS, cells: CELLS })).toThrow(/the BG1-C manifest (is unfilled|\S+eval\/decisions\/datasets\/bg1c-manifest\.json does not exist)/);
    expect(() => loadInput([root], { set: 'BG1-C', waveA: true }, { questions: QUESTIONS, cells: CELLS, manifestBytes: MANIFEST })).toThrow('the pilot reads set BG1 only');
  });

  // Value: protects=the kept list is exactly 40 BG1-C slots in slot order and never BG1's own worlds; fails_when=a kept list of the wrong size, with bg1-001 to bg1-030 or slots past 96, out of order, or with another n_final is read; why_new=BG1-C harness item 3; seam=confirmKeptProblems, loadInput; no_claim=which slots custody keeps
  test('refuses a kept list that is not 40 BG1-C slots in slot order', () => {
    expect(confirmKeptProblems({ kept: WORLDS, n_final: 40 })).toEqual([]);
    expect(confirmKeptProblems({ kept: CONFIRM_CONVERSATIONS.slice(26) })).toEqual([]);
    expect(confirmKeptProblems({ kept: WORLDS.slice(0, 39) })).toEqual(['the kept list holds 39 worlds, not 40']);
    expect(confirmKeptProblems({ kept: ['bg1-001', ...WORLDS.slice(1)] })).toEqual(['the kept list holds bg1-001, outside BG1-C\'s slots bg1-031 to bg1-096']);
    expect(confirmKeptProblems({ kept: [...WORLDS.slice(1), 'bg1-097'] })[0]).toContain('bg1-097, outside');
    expect(confirmKeptProblems({ kept: [WORLDS[1], WORLDS[0], ...WORLDS.slice(2)] })).toEqual(['the kept list is not in slot order']);
    expect(confirmKeptProblems({ kept: [WORLDS[0], ...WORLDS.slice(0, 39)] })).toEqual(['the kept list is not in slot order']);
    expect(confirmKeptProblems({ kept: WORLDS, n_final: 30 })).toEqual(['n_final is 30, not 40']);
    expect(() => load(root, { manifestBytes: manifestOf({ kept: ['bg1-030', ...WORLDS.slice(1)] }) })).toThrow('the filled BG1-C manifest cannot be read: the kept list holds bg1-030, outside');
    expect(() => load(root, { manifestBytes: manifestOf({ n_final: 30 }) })).toThrow('n_final is 30, not 40');
  });

  // Value: protects=every receipt comes from the filled BG1-C manifest and holds exactly its kept worlds; fails_when=a receipt naming BG1's manifest, another fill, an unpinned file, a world outside the kept list or a missing kept world is read; why_new=BG1-C harness item 3; seam=loadInput set BG1-C; no_claim=custody of the bytes
  test('refuses a receipt that does not match the filled BG1-C manifest or the kept list', () => {
    expect(() => load(receipts({ dataset: d => { d.files[0].path = BG1_MANIFEST_REL; } }))).toThrow(`its dataset is not the BG1-C manifest (${BG1_MANIFEST_REL})`);
    expect(() => load(receipts({ dataset: d => { d.files[0].sha256 = 'f'.repeat(64); } }))).toThrow('its BG1-C manifest SHA-256 ffffffffffff is not the filled manifest\'s');
    expect(() => load(receipts({ dataset: d => { d.files.push({ path: 'worlds/bg1-032/world.json', sha256: 'b'.repeat(64) }); } }))).toThrow('it loaded worlds/bg1-032/world.json, which the filled manifest does not pin');
    expect(() => load(root, { manifestBytes: manifestOf({ files: [] }) })).toThrow('is not the filled manifest\'s');
    const bg1World = { ...QUESTIONS[0], id: 'bg1-001-now-0', conversation: 'bg1-001' };
    expect(() => load(receipts({ worlds: [...WORLDS, 'bg1-001'] }))).toThrow('question bg1-001-now-0 has no BG1 fields');
    expect(() => load(receipts({ worlds: [...WORLDS, 'bg1-001'] }), { questions: [...QUESTIONS, bg1World] })).toThrow('the receipts must hold exactly the first 40 kept worlds; missing none; outside that set bg1-001');
    expect(() => load(receipts({ worlds: WORLDS.slice(0, 39) }))).toThrow(`missing ${WORLDS[39]}; outside that set none`);
    expect(() => load(receipts({ config: c => { c.arm.budget = 4000; } }))).toThrow('in the BG1-C cell set at arm.budget');
  }, 60_000);

  // Value: protects=a BG1-C verdict reads BG1-C's three rows with gpt-6.2-sol live, never BG1's cells; fails_when=BG1's gpt-6.1-sol cells, a missing row or a missing cell set file is read; why_new=BG1-C harness item 3; seam=confirmCells, loadInput; no_claim=item 2's cell set
  test('refuses a cell set that is not BG1-C\'s three rows read live by claude-opus-5-5 and gpt-6.2-sol', () => {
    expect(confirmCells(CELLS).map(c => c.system)).toEqual(['gbrain-defaults', 'ext-memory-bank', 'ext-extract-first']);
    expect(() => confirmCells(loadBG1Manifest().cells)).toThrow('every BG1-C row is read live by anthropic:claude-opus-5-5 and openai:gpt-6.2-sol; bg1.gbrain-defaults.rs1-stable reads with anthropic:claude-opus-5-5, openai:gpt-6.1-sol');
    expect(() => confirmCells(CELLS.slice(0, 2))).toThrow('exactly one counted cell each for gbrain and the two servers; ext-extract-first has 0');
    expect(() => confirmCells([...CELLS, CELLS[0]])).toThrow('gbrain-defaults has 2');
    expect(() => load(root, { cellsPath: join(tmp, 'no-cells.json') })).toThrow('the BG1-C cell set');
  });

  // Value: protects=the verdict reads its readers, manifest and cell set from the shared names, and receipts of the committed BG1-C cell set load by default; fails_when=confirm.ts keeps its own copy that drifts from bg1c.ts or corpus.ts, or the default path is not item 2's cell set; why_new=folding BG1-C's names into bg1c.ts, corpus.ts and the cell set; seam=confirm.ts names, loadInput set BG1-C; no_claim=the cell set's contents
  test('its readers, manifest and cell set are the shared names, and the committed cell set loads by default', () => {
    expect([CONFIRM_SOL, CONFIRM_LIVE_READERS, CONFIRM_CELLS_PATH, CONFIRM_MANIFEST_REL]).toEqual([BG1C_SOL, BG1C_READERS, BG1C_MANIFEST_PATH, BG1C_MANIFEST]);
    expect(CELLS.map(c => c.id)).toEqual(['bg1c.gbrain-defaults.rs1-stable', 'bg1c.ext-memory-bank.recipe', 'bg1c.ext-extract-first.common']);
    expect(loadInput([root], { set: 'BG1-C' }, { questions: QUESTIONS, manifestBytes: MANIFEST, plans: PLANS })).toEqual(load(root));
  }, 60_000);

  // Value: protects=confirm reports S5's entity-scoped exposure beside exposure.ts's count, per row and kind, from each question's entity in its world's plan; fails_when=the report lacks it, counts another entity's call-off as the withdrawal, misses a call-off worded without the gold value, changes exposure.ts's count or its stale values, or reports a row with no frozen contexts; why_new=BG1-C's preregistration, "Reported beside the verdict" (BG1's correction of 2026-11-16); seam=loadInput set BG1-C, analyzeConfirm scoped_exposure; no_claim=the custody call-off words
  test('S5\'s entity-scoped exposure sits beside exposure.ts\'s, per row and kind, with each entity from its world\'s plan', () => {
    const said: Record<string, string> = { 'gbrain-defaults': `${ENTITY} walked away from the move to Lisbon.`, 'ext-memory-bank': 'Bruno Costa lives in Porto. Bruno Costa called off the move to Lisbon.' };
    const a = analyzeConfirm(load(receipts({ contexts: system => said[system] ?? null })), { release: RELEASE });
    const s5 = (e: typeof a.exposure | NonNullable<typeof a.scoped_exposure>, row: Bg1Row) => { const x = e[row]!.by_stratum.s5_withdrawn!; return [x.contexts, x.gold_rate, x.stale_rate]; };
    expect(Object.keys(a.exposure)).toEqual(['gbrain', 'memory-bank']);
    expect(Object.keys(a.scoped_exposure!)).toEqual(['gbrain', 'memory-bank']);
    expect([s5(a.exposure, 'gbrain'), s5(a.scoped_exposure!, 'gbrain')]).toEqual([[80, 0, 1], [80, 1, 1]]);
    expect([s5(a.exposure, 'memory-bank'), s5(a.scoped_exposure!, 'memory-bank')]).toEqual([[80, 1, 1], [80, 0, 1]]);
    expect([a.exposure.gbrain!.all.gold_rate, a.scoped_exposure!.gbrain!.all.gold_rate, a.scoped_exposure!['memory-bank']!.all.gold_rate]).toEqual([0, 0.125, 0]);
    expect(a.scoped_exposure!.gbrain!.all.contexts).toBe(640);
    expect(analyzeConfirm(load(root), { release: RELEASE }).scoped_exposure).toEqual({});
  }, 60_000);

  // Value: protects=in custody each entity comes from <GBRAIN_EVALS_BG1C_SOURCE>/worlds/<world>/plan.json, and a missing plan or an unlisted entity refuses instead of reporting a wrong count; fails_when=the plans are read from elsewhere, a world without a plan or a slot whose entity the plan lacks is skipped, or a load without plans goes through; why_new=S5's scoped exposure on BG1-C; seam=loadInput set BG1-C; no_claim=the custody host's layout beyond the plans
  test('in custody the plans come from the BG1-C set root, and a missing plan or entity refuses', () => {
    const src = join(tmp, 'bg1c-set'), before = process.env.GBRAIN_EVALS_BG1C_SOURCE;
    for (const w of WORLDS) { mkdirSync(join(src, 'worlds', w), { recursive: true }); writeFileSync(join(src, 'worlds', w, 'plan.json'), JSON.stringify(PLANS.get(w))); }
    const inCustody = () => loadInput([root], { set: 'BG1-C' }, { questions: QUESTIONS, cells: CELLS, manifestBytes: MANIFEST });
    try {
      delete process.env.GBRAIN_EVALS_BG1C_SOURCE;
      expect(inCustody).toThrow('bg1c: GBRAIN_EVALS_BG1C_SOURCE is not set');
      process.env.GBRAIN_EVALS_BG1C_SOURCE = src;
      expect(inCustody()).toEqual(load(root));
      rmSync(join(src, 'worlds', WORLDS[3], 'plan.json'));
      expect(inCustody).toThrow(`${join(src, 'worlds', WORLDS[3], 'plan.json')} does not exist; S5's scoped exposure names each question's entity from its world's plan`);
    } finally {
      if (before === undefined) delete process.env.GBRAIN_EVALS_BG1C_SOURCE; else process.env.GBRAIN_EVALS_BG1C_SOURCE = before;
    }
    expect(() => load(root, { plans: new Map([...PLANS].slice(1)) })).toThrow(`no plan for ${WORLDS[0]}; S5's scoped exposure`);
    expect(() => load(root, { plans: new Map(WORLDS.map(w => [w, { entities: [{ id: 'person-02', name: 'Bruno Costa' }] }])) })).toThrow(`${WORLDS[0]}: slot person-01.city names entity person-01, which the plan does not list`);
  }, 60_000);

  const run = (argv: string[], deps: Parameters<typeof main>[1] = {}) => {
    let err = '', out = '';
    const w = process.stderr.write, o = process.stdout.write;
    process.stderr.write = ((s: string) => { err += s; return true; }) as never;
    process.stdout.write = ((s: string) => { out += s; return true; }) as never;
    try { return { code: main(argv, deps), err, out }; } finally { process.stderr.write = w; process.stdout.write = o; }
  };

  // Value: protects=confirm measures the release the cell set pins (gbrain_build.release): it takes it from there, refuses a cell set without one and a --release that differs, and needs set BG1-C; fails_when=a run names another release than the cell set's, runs with none, or reads another set; why_new=the Opus reader's gate note 3 on BG1-C harness item 3b; seam=main confirm; no_claim=which release launch amendment A names
  test('the CLI: confirm takes its release from the cell set, refuses one that differs or a cell set without one, and needs set BG1-C', () => {
    const cells = join(tmp, 'bg1c-cells.json'), bare = join(tmp, 'bg1c-cells-bare.json');
    writeFileSync(cells, JSON.stringify({ cells: CELLS, gbrain_build: BG1C_GBRAIN_BUILD }));
    writeFileSync(bare, JSON.stringify({ cells: CELLS }));
    const base = ['confirm', '--receipts', root, '--cells', cells, '--out', join(tmp, 'out')];
    expect(RELEASE).toBe(BG1C_GBRAIN_BUILD.release);
    expect(run(['confirm', '--out', join(tmp, 'out')]).err).toContain('verdict.ts confirm [--look] --receipts');
    expect(run(['confirm', '--receipts', root, '--cells', bare, '--release', RELEASE, '--out', join(tmp, 'out')])).toEqual({ code: 2, err: `bg1 verdict refused: the BG1-C cell set ${bare} names no gbrain release in gbrain_build.release, so confirm cannot say which release it measures\n`, out: '' });
    expect(run([...base, '--release', 'v0.60.593.0'])).toEqual({ code: 2, err: `bg1 verdict refused: --release v0.60.593.0 is not the gbrain release the BG1-C cell set pins, v0.60.753.0 (${cells}); confirm measures the cell set's release\n`, out: '' });
    expect(run([...base, '--release', 'latest']).code).toBe(2);
    expect(run([...base, '--release', RELEASE, '--set', 'BG1'])).toEqual({ code: 2, err: 'confirm reads set BG1-C only, not BG1\n', out: '' });
    for (const given of [[], ['--release', RELEASE]]) {
      const out = join(tmp, `release-${++n}`), look = run(['confirm', '--look', '--receipts', half, '--cells', cells, ...given, '--out', out], DEPS);
      expect([look.code, look.err, JSON.parse(readFileSync(join(out, 'look.json'), 'utf8')).release]).toEqual([0, '', BG1C_GBRAIN_BUILD.release]);
    }
    const missing = run([...base, '--release', RELEASE, '--manifest', join(tmp, 'missing.json')]);
    expect(missing.code).toBe(2);
    expect(missing.err).toStartWith('bg1 verdict refused: the BG1-C manifest');
    const unfilled = join(tmp, 'unfilled.json');
    writeFileSync(unfilled, JSON.stringify({ status: 'unfilled', files: [] }));
    expect(run([...base, '--release', RELEASE, '--manifest', unfilled]).err).toContain('bg1 verdict refused: the BG1-C manifest is unfilled');
  });

  // Value: protects=the run takes one look into its --out, a second look refuses, the final needs that look's "continue" and the full kept list, and a stopped run has no final; fails_when=a second look is computed, a final runs without the look, after a stop, on the look's 20 worlds or with other rows left out; why_new=Amendment 1; seam=main confirm --look; no_claim=custody of the --out directory
  test('the CLI: one look, then the final; a second look, a final without the look or after a stop, and a final on 20 worlds refuse', () => {
    const out = join(tmp, 'run1'), args = (r: string, more: string[] = []) => ['confirm', '--receipts', r, '--release', RELEASE, '--out', out, ...more];
    const look = run(args(half, ['--look']), DEPS);
    expect([look.code, look.err]).toEqual([0, '']);
    expect(look.out).toMatch(/^BG1-C look: continue to 40 worlds; now\|memory-bank crossed, z \d+\.\d\d, CP \d\.\d\d; now\|extract-first open, z -?0\.00, CP 0\.\d\d; past\|memory-bank open, z 0\.\d\d, CP 0\.\d\d; past\|extract-first futile, z -?0\.00, CP 0\.0\d\n$/);
    const record = JSON.parse(readFileSync(join(out, 'look.json'), 'utf8'));
    expect([record.decision, record.verdict, existsSync(join(out, 'confirm.json'))]).toEqual(['continue', null, false]);
    const again = run(args(half, ['--look']), DEPS);
    expect([again.code, again.err]).toEqual([2, `bg1 verdict refused: this run already took its look (${join(out, 'look.json')}); Amendment 1 allows one look, and no second look counts\n`]);
    expect(run(args(half), DEPS).err).toContain('the receipts must hold exactly the first 40 kept worlds; missing');
    expect(run(args(root, ['--left-out', `memory-bank=${NO_MEMORIES}`]), DEPS).err).toBe('bg1 verdict refused: the final analysis leaves out memory-bank, but the look left out no row; both read the same rows, with the same reasons\n');
    const final = run(args(root), DEPS);
    expect([final.code, final.err]).toEqual([0, '']);
    expect(final.out).toBe('BG1-C: row 5 (At least one comparison ahead, but neither class ahead on both); now|memory-bank ahead; now|extract-first level within 3 points; past|memory-bank not behind by 3 points or more; past|extract-first no measurable difference; 40 worlds, 640 of 640 questions in the common set\n');
    expect(JSON.parse(readFileSync(join(out, 'confirm.json'), 'utf8')).stage).toBe('final');
    const fresh = run(['confirm', '--receipts', root, '--release', RELEASE, '--out', join(tmp, 'run2')], DEPS);
    expect(fresh.err).toBe(`bg1 verdict refused: the final analysis comes after the look, and ${join(tmp, 'run2', 'look.json')} does not exist; run confirm --look on the first 20 kept worlds into the same --out first\n`);
    const stopped = join(tmp, 'run3');
    mkdirSync(stopped, { recursive: true });
    writeFileSync(join(stopped, 'look.json'), JSON.stringify({ decision: 'stop', left_out: [] }));
    expect(run(['confirm', '--receipts', root, '--release', RELEASE, '--out', stopped], DEPS).err).toBe(`bg1 verdict refused: the run stopped at its look (${join(stopped, 'look.json')}), so the look's verdict stands and no final analysis counts\n`);
  }, 60_000);

  // Value: protects=--left-out takes a server row with the reason its pilot failed, and the look records it; fails_when=gbrain, an unknown row, a row without a reason or a row named twice is accepted, or the look record omits the row; why_new=Amendment 1 (R111); seam=main confirm --left-out; no_claim=which rows pass their pilots
  test('the CLI: --left-out takes a server row and its reason, and the look records it', () => {
    const out = join(tmp, 'run4'), args = (more: string[]) => ['confirm', '--look', '--receipts', half, '--release', RELEASE, '--out', out, ...more];
    expect(run(args(['--left-out', 'gbrain=its brain is empty']), DEPS).err).toBe("bg1 verdict refused: gbrain's row can't be left out; its failed pilot goes to GBEV-3\n");
    expect(run(args(['--left-out', 'memory-bank']), DEPS).err).toBe('bg1 verdict refused: memory-bank is left out without the reason its pilot failed\n');
    expect(run(args(['--left-out', 'memory-bank=a', '--left-out', 'memory-bank=b']), DEPS)).toEqual({ code: 2, err: '--left-out names memory-bank twice\n', out: '' });
    const ok = run(args(['--left-out', `memory-bank=${NO_MEMORIES}`]), DEPS);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`now|memory-bank not run; now|extract-first open`);
    const record = JSON.parse(readFileSync(join(out, 'look.json'), 'utf8'));
    expect(record.left_out).toEqual([{ row: 'memory-bank', reason: NO_MEMORIES }]);
    expect(record.comparisons[0]).toEqual({ key: 'now|memory-bank', z: null, cp: null, status: 'not run', reason: `pilot failed: ${NO_MEMORIES}` });
  }, 60_000);

  // Value: protects=confirm's report carries gbrain's kept-brain counts for a tie's "Why null?" cycle, exactly the three whole counts and nothing else, and null without them; fails_when=the counts are dropped, a fraction, a negative, a missing or an extra key is accepted, or a bad file refuses only after the look is written; why_new=BG1-C's preregistration, "Reported beside the verdict" (R48); seam=main confirm --brain-counts; no_claim=the dev loop's query that makes them
  test('the CLI: --brain-counts goes into the report as the three whole counts, and anything else refuses before the look', () => {
    const out = join(tmp, 'run5'), args = (r: string, more: string[]) => ['confirm', '--receipts', r, '--release', RELEASE, '--out', out, ...more];
    const COUNTS = { tagged_facts: 9120, slotted_facts: 6044, changing_slots: 0 };
    const counts = (body: unknown) => { const p = join(tmp, `counts-${++n}.json`); writeFileSync(p, JSON.stringify(body)); return p; };
    const refusal = 'bg1 verdict refused: --brain-counts must hold exactly tagged_facts, slotted_facts, changing_slots, each a whole number of at least 0\n';
    for (const bad of [{ ...COUNTS, changing_slots: 1.5 }, { ...COUNTS, tagged_facts: -1 }, { tagged_facts: 1, slotted_facts: 2 }, { ...COUNTS, sample: 'Ana Silva moved to Porto' }, [1, 2, 3], null]) {
      expect(run(args(half, ['--look', '--brain-counts', counts(bad)]), DEPS)).toEqual({ code: 2, err: refusal, out: '' });
    }
    expect(run(args(half, ['--look', '--brain-counts', join(tmp, 'no-counts.json')]), DEPS).err).toBe(`bg1 verdict refused: ${join(tmp, 'no-counts.json')} does not exist\n`);
    expect(existsSync(join(out, 'look.json'))).toBe(false);
    expect(run(args(half, ['--look', '--brain-counts', counts(COUNTS)]), DEPS).code).toBe(0);
    expect(run(args(root, ['--brain-counts', counts(COUNTS)]), DEPS).code).toBe(0);
    const report = JSON.parse(readFileSync(join(out, 'confirm.json'), 'utf8'));
    expect([report.brain_counts, Object.keys(report).indexOf('brain_counts') - Object.keys(report).indexOf('scoped_exposure')]).toEqual([COUNTS, 1]);
    expect(run(args(root, []), DEPS).code).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'confirm.json'), 'utf8')).brain_counts).toBeNull();
    expect(analyzeConfirm(load(root), { release: RELEASE, brainCounts: COUNTS }).brain_counts).toEqual(COUNTS);
  }, 60_000);
});
