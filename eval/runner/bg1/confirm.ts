/**
 * BG1-C, the changing-facts confirmation (preregistration
 * docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md, "The worlds", "Estimand and verdict rules",
 * "What each outcome changes (R97)", and Amendments 1 to 3): the frozen design verdict.ts's confirm mode reads receipts
 * against, the rule that turns the comparisons into words at the look and at the final analysis, the outcome table with
 * every sentence it publishes, and each row's pilot lines. verdict.ts computes each comparison's paired t from the
 * receipts; this file turns them into words, a row and sentences, so nobody chooses words after seeing the data. It reads
 * no receipts, so the power test (test/eval/bg1-confirm-power.test.ts) runs exactly this rule.
 *
 *   Worlds       the kept list of the filled BG1-C manifest (eval/decisions/datasets/bg1c-manifest.json): the first 40
 *                slots from bg1-031 that passed BG1's validation, in slot order, and never bg1-001 to bg1-030. The look
 *                reads the first 20 (launch units 1 to 4).
 *   Systems      gbrain, the memory-bank server and the extract-first server, read live by claude-opus-5-5 and
 *                gpt-6.2-sol, with particle-1 re-reading every frozen context. A server row whose pilot failed can be
 *                left out, with the reason: its two comparisons read "not run (pilot failed: <reason>)" and Holm runs
 *                over the rest. gbrain's row cannot be left out.
 *   Comparisons  gbrain minus each server on what is true now (S1 to S5) and on questions about the past (S6 to S8), in
 *                the order now and memory-bank, now and extract-first, past and memory-bank, past and extract-first.
 *   Statistic    each comparison's z: the normal score with the same one-sided p as its paired t, on 19 degrees of
 *                freedom at the look and 39 at the final.
 *   Bounds       O'Brien-Fleming two-look bounds at each Holm step's one-sided alpha (0.05 over the number of
 *                comparisons still undecided): the look bound is the square root of 2 times the final bound, and the
 *                pair spends exactly that alpha with no true difference (bivariate normal, correlation the square root
 *                of 0.5). For four comparisons the look bounds are 3.183, 3.026, 2.797 and 2.373, and the final bounds
 *                2.250, 2.140, 1.977 and 1.678.
 *   Look         Holm steps down over the z's in each direction with the look bounds: the largest z against step 1's
 *                bound, and so on, stopping at the first that falls short. A comparison it passes has crossed, as ahead
 *                or behind. One that has not is futile when its conditional power for "ahead" is below 10%: the last
 *                20 worlds' mean difference at the planned effect (+2.6, +1.1, +1.5 and +1.5 points, the development
 *                effects), the first 20 worlds' SD, and a final z of at least the last step's final bound (1.678). The
 *                run stops only when every comparison that runs has crossed or is futile and none is descriptive:
 *                crossed comparisons keep their word, each futile one takes its 3-point reading on the 20 worlds from
 *                the bounds below (Amendment 3), and the results say the run stopped at its look. Otherwise the look
 *                decides nothing.
 *   Final        Holm steps down the same way over the 40-world z's with the final bounds, for "ahead" and for "behind".
 *   Words        a comparison that is neither ahead nor behind reads from the simultaneous one-sided bounds at 0.05 / 4,
 *                whichever comparisons run: "level within 3 points" when the lower bound is above -3 and the upper bound
 *                below +3, "not behind by 3 points or more" when only the lower bound is above -3, and "no measurable
 *                difference" when neither holds.
 *   Outcome      the first match of: 1 incomplete (any comparison descriptive, over the 5% drop cap or with a row below
 *                the 0.90 fill gate), 2 any comparison behind, 3 all four ahead, 4 both comparisons of one class ahead,
 *                5 at least one ahead, 6 none ahead and none behind. confirmOutcome gives the row's published lines,
 *                README's changing-facts line (which the scoreboard also gets), the next step and the public lesson
 *                (confirmLesson: the lead's sentence for row 3, Amendment 3's "part of the lead ... carried over" for
 *                rows 4 and 5, the tie-or-loss sentence with "did not" for rows 2 and 6, none for row 1), with the
 *                design's limit beside it. When the worst case's words differ, that is the first published line; a row
 *                left out is listed after the comparisons; and a run that stopped at its look says so last.
 *   Pilot        each row's pilot is its smoke cell in the cell set (eval/runner/q1/cells/bg1c-cells.json), on public
 *                dev world bg1-dev-01 at the counted settings. Conditions 1 and 3 of the pilot list: a frozen context for
 *                every one of the 64 questions, a mean fill rate of at least 0.90, gbrain's kept brain holding tagged
 *                facts, slotted facts and changing slots, each server holding stored memories for the world, spend per
 *                world at most 1.5 times the row's Budget rate (its own line from the cell set's rates plus a third of
 *                the three-row lines: gpt-6.2-sol's reads, Opus grading them, and particle-1's re-reads with their
 *                grading), and the mint's first five BG1-C slots at most 1.5 times the dev mint's 336 Gemini requests
 *                per kept world (504).
 */
import { resolve } from 'node:path';
import { tCdf, tQuantile } from '../power/risk-ratio.ts';
import { BG1C_MANIFEST } from '../memory-qa/corpus.ts';
import { OPUS, PARTICLE } from '../q1/cells/bg1.ts';
import { BG1C_MANIFEST_PATH, BG1C_RATES, BG1C_READERS, BG1C_SOL } from '../q1/cells/bg1c.ts';
import { BG1C_SETS, type CellDefinition } from '../q1/cells/definitions.ts';
import { normalQuantile } from '../stats/paired.ts';
import { BG1_ALPHA, type PairedT } from './rule.ts';
import { BG1_PRIMARY, BG1_SECONDARY, BG1_STRATA, BG1C_CONVERSATIONS, BG1C_FIRST_HALF_UNITS, BG1C_FIRST_SLOT, BG1C_KEPT_UNITS, BG1C_LAST_SLOT, BG1C_N_FINAL, type Bg1Stratum } from './types.ts';
import type { Bg1Row } from './verdict.ts';

export const CONFIRM_N = BG1C_N_FINAL;
/** The look reads the first half of the launch units (Amendment 1): BG1C_FIRST_HALF_UNITS units of BG1C_KEPT_UNITS kept worlds. */
export const CONFIRM_LOOK_N = BG1C_KEPT_UNITS * BG1C_FIRST_HALF_UNITS;
export const CONFIRM_MARGIN_POINTS = 3;
export const CONFIRM_FIRST_SLOT = BG1C_FIRST_SLOT;
export const CONFIRM_LAST_SLOT = BG1C_LAST_SLOT;
/** BG1-C's mint slots, bg1-031 to bg1-096, as eval/runner/memory-qa/bg1-names.ts lists them. */
export const CONFIRM_CONVERSATIONS: readonly string[] = BG1C_CONVERSATIONS;
/** BG1-C's manifest, as the bg1c loader names it (eval/runner/memory-qa/corpus.ts BG1C_MANIFEST). */
export const CONFIRM_MANIFEST_REL = BG1C_MANIFEST;
export const CONFIRM_MANIFEST_PATH = resolve(import.meta.dir, '../../..', CONFIRM_MANIFEST_REL);
/** The BG1-C cell set that eval/runner/q1/cells/bg1c.ts writes (BG1C_MANIFEST_PATH); verdict.ts confirm --cells overrides it. */
export const CONFIRM_CELLS_PATH = BG1C_MANIFEST_PATH;
/** The cell set's live readers (bg1c.ts BG1C_READERS): claude-opus-5-5 and gpt-6.2-sol; particle-1 re-reads their frozen contexts. */
export const CONFIRM_SOL = BG1C_SOL;
export const CONFIRM_LIVE_READERS: readonly string[] = BG1C_READERS;
export const CONFIRM_READERS: readonly string[] = [...CONFIRM_LIVE_READERS, PARTICLE];
/** The cost table's reader order: the primary models first (AGENTS.md), then gpt-6.2-sol. */
export const CONFIRM_TABLE_READERS: readonly string[] = [OPUS, PARTICLE, CONFIRM_SOL];
export const CONFIRM_ROWS: readonly Bg1Row[] = ['gbrain', 'memory-bank', 'extract-first'];
/** The build BG1's published rows measured, which they stay labelled with (R100). */
export const BG1_RELEASE = 'v0.60.593.0';

export const CONFIRM_CLASSES = {
  now: { name: 'what is true now', strata: BG1_PRIMARY },
  past: { name: 'questions about the past', strata: BG1_SECONDARY },
} as const;
export type ConfirmClass = keyof typeof CONFIRM_CLASSES;
export const CONFIRM_SERVERS = { 'memory-bank': 'the memory-bank server', 'extract-first': 'the extract-first server' } as const;
export type ConfirmServer = keyof typeof CONFIRM_SERVERS;
export interface ConfirmComparison { key: string; cls: ConfirmClass; server: ConfirmServer }
export const CONFIRM_COMPARISONS: readonly ConfirmComparison[] = (['now', 'past'] as const).flatMap(cls => (['memory-bank', 'extract-first'] as const).map(server => ({ key: `${cls}|${server}`, cls, server })));
/** The simultaneous one-sided bounds' alpha for the 3-point readings: 0.05 over the four comparisons, whichever run. */
export const CONFIRM_BOUND_ALPHA = BG1_ALPHA / CONFIRM_COMPARISONS.length;
/** The planned effects futility assumes, in points: the development effects, in the Power table's order. */
export const CONFIRM_PLANNED_EFFECTS: Readonly<Record<string, number>> = { 'now|memory-bank': 2.6, 'now|extract-first': 1.1, 'past|memory-bank': 1.5, 'past|extract-first': 1.5 };
export const CONFIRM_FUTILITY_CP = 0.1;
/** The sentence the results end with when the run stopped at its look. */
export const CONFIRM_STOP_SENTENCE = 'The run stopped at its planned look, after 20 of its 40 worlds, so its estimates may be overstated.';

export const CONFIRM_WORDS = ['ahead', 'behind', 'level within 3 points', 'not behind by 3 points or more', 'no measurable difference'] as const;
export type ConfirmWord = typeof CONFIRM_WORDS[number];

/** Why a filled BG1-C manifest's kept list cannot be read: it must hold exactly 40 BG1-C slots in slot order, with n_final 40 when it sets one. */
export function confirmKeptProblems(m: { kept?: readonly string[]; n_final?: number | null }): string[] {
  const kept = m.kept ?? [];
  const p: string[] = [];
  if (kept.length !== CONFIRM_N) p.push(`the kept list holds ${kept.length} worlds, not ${CONFIRM_N}`);
  const outside = kept.filter(id => !CONFIRM_CONVERSATIONS.includes(id));
  if (outside.length) p.push(`the kept list holds ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ` (and ${outside.length - 3} more)` : ''}, outside BG1-C's slots ${CONFIRM_CONVERSATIONS[0]} to ${CONFIRM_CONVERSATIONS.at(-1)}`);
  const slots = kept.map(id => CONFIRM_CONVERSATIONS.indexOf(id)).filter(i => i >= 0);
  if (slots.some((s, i) => i > 0 && s <= slots[i - 1])) p.push('the kept list is not in slot order');
  if (m.n_final !== undefined && m.n_final !== null && m.n_final !== CONFIRM_N) p.push(`n_final is ${m.n_final}, not ${CONFIRM_N}`);
  return p;
}

/** Why a list of rows left out cannot be read (R111): only a server row, each with the reason its pilot failed, and at least one server must run. */
export function leftOutProblems(leftOut: Readonly<Record<string, string>>): string[] {
  const p = Object.entries(leftOut).flatMap(([row, reason]) => (row === 'gbrain' ? ["gbrain's row can't be left out; its failed pilot goes to GBEV-3"]
    : !(row in CONFIRM_SERVERS) ? [`${row} is not a BG1-C server row (memory-bank or extract-first)`]
      : !reason.trim() ? [`${row} is left out without the reason its pilot failed`] : []));
  if (Object.keys(CONFIRM_SERVERS).every(s => s in leftOut)) p.push('both server rows are left out, so no comparison runs');
  return p;
}

// ─── The rule ────────────────────────────────────────────────────────

/** The standard normal CDF, by Hart's double-precision algorithm as West (2005) gives it. */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const a = Math.abs(x);
  let c = 0;
  if (a < 37) {
    const e = Math.exp(-a * a / 2);
    if (a < 7.07106781186547) {
      const num = (((((0.0352624965998911 * a + 0.700383064443688) * a + 6.37396220353165) * a + 33.912866078383) * a + 112.079291497871) * a + 221.213596169931) * a + 220.206867912376;
      const den = ((((((0.0883883476483184 * a + 1.75566716318264) * a + 16.064177579207) * a + 86.7807322029461) * a + 296.564248779674) * a + 637.333633378831) * a + 793.826512519948) * a + 440.413735824752;
      c = e * num / den;
    } else c = e / (a + 1 / (a + 2 / (a + 3 / (a + 4 / (a + 0.65))))) / 2.506628274631;
  }
  return x > 0 ? 1 - c : c;
}

/** A comparison's z: the normal score with the same one-sided p as its paired t on df degrees of freedom, taken from the lower tail so a large t keeps its precision. */
export function confirmZ(t: number, df: number): number {
  const p = tCdf(-Math.abs(t), df);
  const z = p > 0 ? -normalQuantile(p) : Infinity;
  return t > 0 ? z : -z;
}

const HALF = CONFIRM_LOOK_N / CONFIRM_N;

/** The chance, with no true difference, that the look's z reaches look or the final's z reaches final: the two are standard bivariate normal with correlation sqrt(20 / 40), integrated over the look's z by Simpson's rule. */
export function obfSpend(look: number, final: number): number {
  const rho = Math.sqrt(HALF), s = Math.sqrt(1 - rho * rho), lo = -12, n = 2000, h = (look - lo) / n;
  const f = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * normalCdf((rho * x - final) / s);
  let sum = f(lo) + f(look);
  for (let i = 1; i < n; i++) sum += f(lo + i * h) * (i % 2 ? 4 : 2);
  return normalCdf(-look) + sum * h / 3;
}

const OBF = new Map<number, { look: number; final: number }>();
/** O'Brien-Fleming's two-look bounds for a one-sided alpha, the look at half the worlds: the final bound c, with the look bound sqrt(2) c, such that the pair spends exactly alpha (bisection on obfSpend). */
export function obfBounds(alpha: number): { look: number; final: number } {
  if (!OBF.has(alpha)) {
    let lo = 0.5, hi = 6;
    for (let i = 0; i < 60; i++) { const c = (lo + hi) / 2; if (obfSpend(c / Math.sqrt(HALF), c) > alpha) lo = c; else hi = c; }
    const c = (lo + hi) / 2;
    OBF.set(alpha, { look: c / Math.sqrt(HALF), final: c });
  }
  return OBF.get(alpha)!;
}

/** Holm's one-sided alpha at each step over m comparisons: 0.05 / m, 0.05 / (m - 1), ..., 0.05. */
export const holmAlphas = (m: number): number[] => Array.from({ length: m }, (_, k) => BG1_ALPHA / (m - k));

/** Holm's step-down over z's against a bound per step: the largest z against step 1's bound, the next against step 2's, stopping at the first that falls short. True where a comparison passed. */
export function holmCrosses(z: readonly number[], bounds: readonly number[]): boolean[] {
  const order = z.map((_, i) => i).sort((a, b) => z[b] - z[a]);
  const passed = z.map(() => false);
  for (let k = 0; k < order.length && z[order[k]] >= bounds[k]; k++) passed[order[k]] = true;
  return passed;
}

/** Conditional power for "ahead" at the final analysis: the last 20 worlds' mean difference at the planned effect, the first 20 worlds' SD, and a final z of at least the last Holm step's final bound. */
export function conditionalPower(mean: number, sd: number, effect: number): number {
  return 1 - normalCdf((obfBounds(BG1_ALPHA).final * sd / Math.sqrt(CONFIRM_N) - (mean + effect) / 2) / (sd / Math.sqrt(2 * CONFIRM_N)));
}

const T_BOUND = new Map<number, number>();
/** The simultaneous one-sided bounds at 0.05 / 4 the 3-point readings use. */
export function confirmBounds(t: Pick<PairedT, 'mean' | 'se' | 'df'>): { lower: number; upper: number } {
  if (!T_BOUND.has(t.df)) T_BOUND.set(t.df, tQuantile(1 - CONFIRM_BOUND_ALPHA, t.df));
  const q = t.se === 0 ? 0 : T_BOUND.get(t.df)! * t.se;
  return { lower: t.mean - q, upper: t.mean + q };
}

/** The 3-point reading of a comparison's simultaneous bounds. */
export function threePoint(b: { lower: number; upper: number }): ConfirmWord {
  const above = b.lower > -CONFIRM_MARGIN_POINTS;
  if (above && b.upper < CONFIRM_MARGIN_POINTS) return 'level within 3 points';
  return above ? 'not behind by 3 points or more' : 'no measurable difference';
}

/** One comparison that runs, as the look and the final read it: its key, its paired t and, where it is descriptive, why. */
export interface ConfirmTest { key: string; test: PairedT; descriptive?: string | null }
export type LookStatus = 'crossed' | 'futile' | 'open' | 'descriptive';
/** A comparison at the look: its z, conditional power and status, and the word it keeps if the run stops there. */
export interface LookReading { key: string; z: number; cp: number; status: LookStatus; word: ConfirmWord; lower: number; upper: number }
/** A comparison at the final analysis: its z and word. */
export interface FinalReading { key: string; z: number; word: ConfirmWord; lower: number; upper: number }

function stepDown(tests: readonly ConfirmTest[], stage: 'look' | 'final') {
  const bounds = holmAlphas(tests.length).map(a => obfBounds(a)[stage]);
  const z = tests.map(t => confirmZ(t.test.t, t.test.df));
  return { z, ahead: holmCrosses(z, bounds), behind: holmCrosses(z.map(x => -x), bounds) };
}

/** The look over the comparisons that run, on the first 20 worlds: stop is true only when every one has crossed or is futile. */
export function confirmLook(tests: readonly ConfirmTest[]): { stop: boolean; comparisons: LookReading[] } {
  const { z, ahead, behind } = stepDown(tests, 'look');
  const comparisons = tests.map((t, i): LookReading => {
    const effect = CONFIRM_PLANNED_EFFECTS[t.key];
    if (effect === undefined) throw new Error(`no planned effect for ${t.key}`);
    const cp = conditionalPower(t.test.mean, t.test.sd, effect), b = confirmBounds(t.test);
    const status: LookStatus = t.descriptive ? 'descriptive' : ahead[i] || behind[i] ? 'crossed' : cp < CONFIRM_FUTILITY_CP ? 'futile' : 'open';
    return { key: t.key, z: z[i], cp, status, word: ahead[i] ? 'ahead' : behind[i] ? 'behind' : threePoint(b), ...b };
  });
  return { stop: comparisons.length > 0 && comparisons.every(c => c.status === 'crossed' || c.status === 'futile'), comparisons };
}

/** The final analysis over the comparisons that run, on the 40 worlds. */
export function confirmFinal(tests: readonly ConfirmTest[]): FinalReading[] {
  const { z, ahead, behind } = stepDown(tests, 'final');
  return tests.map((t, i) => { const b = confirmBounds(t.test); return { key: t.key, z: z[i], word: ahead[i] ? 'ahead' : behind[i] ? 'behind' : threePoint(b), ...b }; });
}

// ─── The outcome table ───────────────────────────────────────────────

/** One comparison as the outcome table reads it: its word (null when no test ran or it was not run), why it is descriptive (null when it counts), the reason its server row was left out (when it was not run), and its mean and two-sided 95% interval in points. */
export interface ConfirmReading { key: string; word: ConfirmWord | null; descriptive: string | null; notRun?: string | null; mean?: number | null; ci95?: readonly [number, number] | null }
export type ConfirmRowNumber = 1 | 2 | 3 | 4 | 5 | 6;
export const CONFIRM_RESULTS: Record<ConfirmRowNumber, string> = {
  1: 'Incomplete', 2: 'Any comparison behind', 3: 'All four ahead', 4: 'Both comparisons in one class ahead',
  5: 'At least one comparison ahead, but neither class ahead on both', 6: 'None ahead, none behind',
};

function inOrder<T extends Pick<ConfirmReading, 'key'>>(readings: readonly T[]): T[] {
  if (readings.length !== CONFIRM_COMPARISONS.length) throw new Error(`the outcome table reads exactly the four comparisons, got ${readings.length}`);
  return CONFIRM_COMPARISONS.map(c => {
    const r = readings.find(x => x.key === c.key);
    if (!r) throw new Error(`no reading for ${c.key}`);
    return r;
  });
}

/** The outcome table's row: the first that matches. A comparison not run is neither ahead, behind nor descriptive. */
export function confirmRow(readings: readonly Pick<ConfirmReading, 'key' | 'word' | 'descriptive' | 'notRun'>[]): ConfirmRowNumber {
  const rs = inOrder(readings);
  if (rs.some(r => r.word === null && !r.descriptive && !r.notRun)) throw new Error('a comparison with no test must be descriptive or not run');
  if (rs.some(r => r.descriptive)) return 1;
  if (rs.some(r => r.word === 'behind')) return 2;
  const ahead = rs.map(r => r.word === 'ahead');
  if (ahead.every(Boolean)) return 3;
  const classAhead = (cls: ConfirmClass) => CONFIRM_COMPARISONS.every((c, i) => c.cls !== cls || ahead[i]);
  if (classAhead('now') || classAhead('past')) return 4;
  return ahead.some(Boolean) ? 5 : 6;
}

/** What one outcome publishes and changes, all from code. */
export interface ConfirmOutcome {
  row: ConfirmRowNumber;
  result: string;
  /** The row's claim; null where the row makes none (row 1, and row 6 unless all four are level within 3 points). */
  headline: string | null;
  /** What we publish, in order: the worst case's disagreement first when there is one, then the row's lines, any row left out, and the early stop when the run stopped at its look. */
  publish: string[];
  /** README's changing-facts line, which the scoreboard also gets, its label, where BG1's rows stand, and what it replaces in BG1's rows. */
  readme: { line: string; label: string | null; bg1_rows: string; replaces: string[] };
  /** What happens next, with the comparisons and kinds (S1 to S8) GBRA-108 gets; a comparison not run sends none. */
  next: { text: string; comparisons: string[]; kinds: Bg1Stratum[] };
  /** The public lesson for the row (confirmLesson); null when the run was incomplete. */
  lesson: string | null;
  /** The design's limit, which every finding states beside the lesson. */
  caveat: string;
}

const points = (x: number) => { const r = Number(x.toFixed(1)); return r === 0 ? '0.0' : `${r > 0 ? '+' : ''}${r.toFixed(1)}`; };
const comparisonOf = (key: string) => CONFIRM_COMPARISONS.find(c => c.key === key)!;
const classOf = (key: string) => CONFIRM_CLASSES[comparisonOf(key).cls];
const serverOf = (key: string) => CONFIRM_SERVERS[comparisonOf(key).server];

/** One comparison's sentence, with its interval when it has one and, where it is descriptive or not run, the reason. */
export function confirmPhrase(r: ConfirmReading): string {
  const server = serverOf(r.key), cls = classOf(r.key).name;
  if (r.notRun) return `gbrain against ${server} on ${cls}: not run (pilot failed: ${r.notRun})`;
  const said: Record<ConfirmWord, string> = {
    ahead: `gbrain is ahead of ${server} on ${cls}`,
    behind: `gbrain is behind ${server} on ${cls}`,
    'level within 3 points': `gbrain is level with ${server} on ${cls}, within 3 points`,
    'not behind by 3 points or more': `gbrain is not behind ${server} on ${cls} by 3 points or more`,
    'no measurable difference': `gbrain shows no measurable difference from ${server} on ${cls}`,
  };
  const interval = r.mean !== undefined && r.mean !== null && r.ci95 ? ` (${points(r.mean)} points, 95% interval ${points(r.ci95[0])} to ${points(r.ci95[1])})` : '';
  return `${r.word === null ? `gbrain against ${server} on ${cls} has no test` : said[r.word]}${interval}${r.descriptive ? `, descriptive: ${r.descriptive}` : ''}`;
}

/** The preregistration's "Public lesson": the sentence for a lead, the advice both lessons end with, and the limit the findings state. */
export const CONFIRM_LESSON_LEAD = "We learned that gbrain's newest release, whose main changes since BG1 tag each fact with the person or company it is about, now answers questions about changing facts more accurately than two leading memory servers on worlds nobody had seen.";
export const CONFIRM_LESSON_ADVICE = 'You should confirm a memory change on held-out data before you claim it.';
export const CONFIRM_LESSON_CAVEAT = 'The design compares one gbrain release with two servers. It does not test which gbrain change caused any difference.';

/**
 * The public lesson for an outcome row: the lead's sentence when all four comparisons are ahead (row 3); Amendment 3's
 * sentence, that part of the development lead carried over, when a comparison is ahead and none is behind (rows 4 and
 * 5); and the tie-or-loss sentence with "did not" when one is behind or none is ahead (rows 2 and 6). An incomplete run
 * (row 1) has no lesson.
 */
export function confirmLesson(row: ConfirmRowNumber): string | null {
  if (row === 1) return null;
  if (row === 3) return `${CONFIRM_LESSON_LEAD} ${CONFIRM_LESSON_ADVICE}`;
  if (row === 4 || row === 5) return `We learned that part of the lead gbrain showed on development worlds carried over to worlds nobody had seen. ${CONFIRM_LESSON_ADVICE}`;
  return `We learned that the lead gbrain showed on development worlds did not carry over to worlds nobody had seen. ${CONFIRM_LESSON_ADVICE}`;
}

/** The outcome table's row for the four readings and the sentences it publishes; worstCase holds the worst case's words, said first when they differ, and stopped says the run stopped at its look. */
export function confirmOutcome(readings: readonly ConfirmReading[], o: { release: string; worstCase?: readonly Pick<ConfirmReading, 'key' | 'word'>[]; stopped?: boolean }): ConfirmOutcome {
  const rs = inOrder(readings);
  const row = confirmRow(rs);
  const worst = o.worstCase ? inOrder(o.worstCase) : null;
  const differs = worst ? rs.flatMap((r, i) => (worst[i].word !== r.word ? [`on ${classOf(r.key).name} against ${serverOf(r.key)} it reads "${worst[i].word ?? 'no test'}" instead of "${r.word ?? 'no test'}"`] : [])) : [];
  const first = differs.length ? [`The worst case, which scores every gbrain drop 0 and every server drop 1, disagrees: ${differs.join('; ')}.`] : [];
  const leftOut = [...new Map(rs.filter(r => r.notRun).map(r => [comparisonOf(r.key).server, r.notRun!])).entries()]
    .map(([server, reason]) => `${CONFIRM_SERVERS[server].replace(/^t/, 'T')} was left out: its pilot failed (${reason}).`);
  const last = [...leftOut, ...(o.stopped ? [CONFIRM_STOP_SENTENCE] : [])];
  const line = (r: ConfirmReading) => `${confirmPhrase(r)}.`;
  const label = `gbrain ${o.release}, BG1-C`;
  const below = `BG1's rows stay published below it, labelled "gbrain ${BG1_RELEASE}, BG1"`;
  const next = (text: string, keys: readonly string[]) => {
    const sent = keys.filter(k => !rs.find(r => r.key === k)!.notRun);
    return { text, comparisons: sent, kinds: BG1_STRATA.filter(s => sent.some(k => (classOf(k).strata as readonly Bg1Stratum[]).includes(s))) };
  };
  const stop = o.stopped ? [CONFIRM_STOP_SENTENCE] : [];
  const out = (headline: string | null, lines: readonly string[], readme: readonly string[], then: ConfirmOutcome['next'], replaces: string[] = []): ConfirmOutcome => ({
    row, result: CONFIRM_RESULTS[row], headline, publish: [...first, ...lines, ...last], readme: { line: [...readme, ...stop].join(' '), label, bg1_rows: below, replaces }, next: then,
    lesson: confirmLesson(row), caveat: CONFIRM_LESSON_CAVEAT,
  });
  const ahead = rs.filter(r => r.word === 'ahead'), notAhead = rs.filter(r => r.word !== 'ahead');
  switch (row) {
    case 1: {
      const reasons = [...new Set(rs.flatMap(r => (r.descriptive ? [r.descriptive] : [])))];
      return { row, result: CONFIRM_RESULTS[row], headline: null, publish: [...first, ...rs.map(line), ...last],
        readme: { line: `A confirmation on new sealed worlds (gbrain ${o.release}) was incomplete: ${reasons.join('; ')}.`, label: null, bg1_rows: "BG1's rows stay as they are", replaces: [] },
        next: next('The cause is named and repaired by dated amendment. A rerun is never used to change a verdict.', []), lesson: confirmLesson(row), caveat: CONFIRM_LESSON_CAVEAT };
    }
    case 2: {
      const losses = rs.filter(r => r.word === 'behind'), others = rs.filter(r => r.word !== 'behind');
      const lost = new Set(losses.map(r => comparisonOf(r.key).cls));
      return out(losses.map(r => confirmPhrase({ ...r, mean: null })).join('; '), [...losses, ...others].map(line), losses.map(line),
        next("The losing class's kinds go to GBRA-108 as issues, each with exposure placing the loss in retrieval or in reading.", CONFIRM_COMPARISONS.filter(c => lost.has(c.cls)).map(c => c.key)));
    }
    case 3: {
      const headline = 'gbrain leads the two leading memory servers on changing facts';
      const lines = [`${headline}.`, ...rs.map(line)];
      return out(headline, lines, lines, next('GBRA-108 hears the lead held.', []));
    }
    case 4: {
      const lead = (['now', 'past'] as const).find(cls => rs.every((r, i) => CONFIRM_COMPARISONS[i].cls !== cls || r.word === 'ahead'))!;
      const leading = rs.filter((_, i) => CONFIRM_COMPARISONS[i].cls === lead), other = rs.filter((_, i) => CONFIRM_COMPARISONS[i].cls !== lead);
      const headline = `gbrain leads both servers on ${CONFIRM_CLASSES[lead].name}`;
      return out(headline, [`${headline}.`, ...leading.map(line), ...other.map(line)], [`Ahead of both servers on ${CONFIRM_CLASSES[lead].name}.`, ...other.map(line)],
        next("GBRA-108 gets the other class's per-kind rows and exposure.", other.map(r => r.key)));
    }
    case 5: {
      const lines = [...ahead, ...notAhead].map(line);
      return out(ahead.map(r => confirmPhrase({ ...r, mean: null })).join('; '), lines, lines,
        next('GBRA-108 gets the per-kind rows and exposure of every comparison that is not ahead.', notAhead.map(r => r.key)));
    }
    case 6: {
      const headline = rs.every(r => r.word === 'level within 3 points') ? 'gbrain is level with the two leading memory servers on changing facts' : null;
      const lines = [...(headline ? [`${headline}.`] : []), ...rs.map(line)];
      const replaces = rs.filter(r => comparisonOf(r.key).cls === 'past' && (r.word === 'level within 3 points' || r.word === 'not behind by 3 points or more'))
        .map(r => `On ${classOf(r.key).name} against ${serverOf(r.key)}, "${r.word}" replaces BG1's "behind" for gbrain ${o.release}.`);
      return out(headline, lines, lines, next('GBRA-108 gets the per-kind rows and exposure of every comparison.', rs.map(r => r.key)), replaces);
    }
  }
}

// ─── The pilot ───────────────────────────────────────────────────────

/** The smoke's world and questions, as the cell set's smoke set names them (definitions.ts BG1C_SETS, BG1C-dev1). */
export const CONFIRM_PILOT_WORLD = BG1C_SETS['BG1C-dev1'].only_conversations![0];
export const CONFIRM_PILOT_QUESTIONS = BG1C_SETS['BG1C-dev1'].questions;
export const CONFIRM_PILOT_SPEND_FACTOR = 1.5;
/** Each row's third of the Budget's three-row lines: gpt-6.2-sol's reads (3.34), Opus grading them (0.46), and particle-1's re-reads with their grading (0.73). */
export const CONFIRM_SHARED_RATE = (3.34 + 0.46 + 0.73) / 3;
/** A smoke cell's pilot spend line per world: 1.5 times its row's Budget rate, its own line from the cell set's rates (bg1c.ts BG1C_RATES) plus its third of the three-row lines. */
export const confirmPilotSpendLine = (cell: Pick<CellDefinition, 'system' | 'configuration'>): number =>
  CONFIRM_PILOT_SPEND_FACTOR * ((BG1C_RATES.row_usd_per_world[`${cell.system}:${cell.configuration}`] ?? NaN) + CONFIRM_SHARED_RATE);
/** Pilot condition 2's judge checks by report schema: BG1's (gpt-6-astra on Opus's answers, claude-opus-5-5 on particle-1's) and this experiment's new one (claude-opus-5-5 on gpt-6.2-sol's answers). */
export const CONFIRM_JUDGE_CHECKS: Readonly<Record<string, string>> = { 'gbrain-evals/bg1-judge-check/v1': 'BG1', 'gbrain-evals/bg1c-judge-check/v1': 'BG1-C' };
/** BG1's published verdict. Its judge_check block is BG1's paid judge check, run in BG1's stage 1 and kept in the repo with no upstream.json beside it; the preregistration says that check stands, so the pilot reads this file's block as BG1's report. */
export const CONFIRM_BG1_VERDICT_PATH = resolve(import.meta.dir, '../../..', 'docs/benchmarks/2026-11-15-changing-facts-battleground-results/verdict.json');
/** The SHA-256 of that verdict as BG1 published it; a file at the path with other bytes is not BG1's paid check. */
export const CONFIRM_BG1_VERDICT_SHA256 = '091079f256bc4bbcf728cc06830d91ec3e31df05483f27e22972d80b7d104003';
/** The mint's line (Amendment 1, condition 3): over BG1-C's first five slots, at most 1.5 times the dev mint's 336 Gemini requests per world. */
export const CONFIRM_MINT_SLOTS = 5;
export const CONFIRM_DEV_MINT_REQUESTS = 336;
export const CONFIRM_MINT_FACTOR = 1.5;
export const CONFIRM_MINT_LINE = CONFIRM_MINT_FACTOR * CONFIRM_DEV_MINT_REQUESTS;
