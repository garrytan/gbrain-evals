/**
 * RS1's estimand and decision rule, written once (docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md, gate C1).
 * eval/runner/rs1/power.ts's simulation and eval/runner/rs1/verdict.ts both call it, so the rule the power was computed
 * for is the rule the verdict applies.
 *
 *   Score     for each question, a row's score under a judge view is the mean over the three readers (claude-opus-5-5
 *             and gpt-6.1-sol live, particle-1 from its byte-for-byte re-read) of that reader's BEAM graded score x 100.
 *   Common    one question set for all four tests: a question enters only when gbrain and both servers have a value
 *             under both judge views. A product failure scores 0 and stays in; a harness failure, a missing judgment or
 *             a missing re-read answer drops the question, counted by reason and side.
 *   Estimate  a conversation's difference is the mean over its common questions of gbrain minus server; the statistic
 *             is the mean of the conversation differences, with its one-sided 95% t lower bound on n - 1 df.
 *   Primary   four tests (memory-bank and extract-first, each under the frontier and the bridge view); the claim passes
 *             only when all four lower bounds are above -3.5 (intersection-union, no alpha split).
 *   Validity  a comparison that drops more than 5% of its planned questions, or whose row fails the delivered-context
 *             gate, is invalid: no verdict, not a pass, and the claim is not made.
 *   Secondary superiority (lower bound above 0 under both views), in a fixed sequence after the primary passes:
 *             extract-first first, then memory-bank (eval/runner/stats/fixed-sequence.ts).
 *   Worst case every gbrain-side drop scores 0 and every server-side drop 100, reported beside the verdict.
 */
import { fixedSequence, type SequenceResult } from '../stats/fixed-sequence.ts';

export const RS1_MARGIN = 3.5;
export const RS1_ALPHA = 0.05;
/** A comparison that drops more than this share of its planned questions is invalid. */
export const RS1_DROP_CAP = 0.05;
export const SERVERS = ['memory-bank', 'extract-first'] as const;
export const VIEWS = ['frontier', 'bridge'] as const;
export type Server = (typeof SERVERS)[number];
export type View = (typeof VIEWS)[number];
export type Row = 'gbrain' | Server;
export type ComparisonKey = `${Server}/${View}`;
/** The four tests, in the order power.ts's covariance matrix lists them. */
export const COMPARISONS: ComparisonKey[] = ['memory-bank/frontier', 'memory-bank/bridge', 'extract-first/frontier', 'extract-first/bridge'];

// ─── Student t (regularized incomplete beta, as GBEV-48's model computes it) ───

function betacf(a: number, b: number, x: number): number {
  const qab = a + b, qap = a + 1, qam = a - 1;
  const tiny = (v: number) => (Math.abs(v) > 1e-30 ? v : 1e-30);
  let c = 1, d = 1 / tiny(1 - qab * x / qap), h = d;
  for (let m = 1; m < 400; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 / tiny(1 + aa * d); c = tiny(1 + aa / c); h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 / tiny(1 + aa * d); c = tiny(1 + aa / c);
    const de = d * c; h *= de;
    if (Math.abs(de - 1) < 1e-13) break;
  }
  return h;
}
function lgamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5, ser = 1.000000000190015;
  tmp -= (x + 0.5) * Math.log(tmp);
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function ibeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
export function tCdf(t: number, df: number): number {
  const p = 0.5 * ibeta(df / 2, 0.5, df / (df + t * t));
  return t > 0 ? 1 - p : p;
}
/** The p quantile of Student t on df degrees of freedom, by bisection. */
export function tQuantile(p: number, df: number): number {
  let lo = -60, hi = 60;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (tCdf(m, df) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

// ─── The bound and the rule ──────────────────────────────────────────

export interface Bound { n: number; mean: number; sd: number; lower: number }

/** The one-sided (1 - alpha) t lower bound on the mean of conversation differences (n - 1 df). */
export function tLowerBound(xs: readonly number[], alpha = RS1_ALPHA, quantile?: number): Bound {
  const n = xs.length;
  if (n < 2) throw new Error(`a t bound needs at least two conversations, got ${n}`);
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd, lower: mean - (quantile ?? tQuantile(1 - alpha, n - 1)) * sd / Math.sqrt(n) };
}

export interface TestResult extends Bound { key: ComparisonKey; pass: boolean; valid: boolean; invalid_reasons: string[] }
export interface Decision {
  /** pass: every comparison valid and all four bounds above -margin; fail: every comparison valid and one is not; invalid: the claim is not made. */
  verdict: 'pass' | 'fail' | 'invalid';
  tests: TestResult[];
  secondaries: Array<SequenceResult<{ frontier: Bound; bridge: Bound }>>;
}

/**
 * The primary decision on per-conversation differences (one array per comparison, aligned by conversation), with the
 * validity reasons verdict.ts found (drops over the cap, a failed delivered-context gate). power.ts calls it with no
 * invalid reasons and a precomputed t quantile; the arithmetic is the same.
 */
export function decide(diffs: Record<ComparisonKey, readonly number[]>, opts: { margin?: number; alpha?: number; invalid?: Partial<Record<ComparisonKey, string[]>>; quantile?: number } = {}): Decision {
  const margin = opts.margin ?? RS1_MARGIN;
  const tests = COMPARISONS.map(key => {
    const b = tLowerBound(diffs[key], opts.alpha, opts.quantile);
    const invalid_reasons = opts.invalid?.[key] ?? [];
    return { key, ...b, pass: b.lower > -margin, valid: !invalid_reasons.length, invalid_reasons };
  });
  const verdict = tests.some(t => !t.valid) ? 'invalid' as const : tests.every(t => t.pass) ? 'pass' as const : 'fail' as const;
  const bound = (key: ComparisonKey) => tests.find(t => t.key === key)!;
  const secondaries = verdict !== 'pass' ? [] : fixedSequence((['extract-first', 'memory-bank'] as const).map(server => ({
    id: `superiority/${server}`,
    evaluate: () => { const f = bound(`${server}/frontier`), m = bound(`${server}/bridge`); return { pass: f.lower > 0 && m.lower > 0, detail: { frontier: f, bridge: m } }; },
  }))).results;
  return { verdict, tests, secondaries };
}

/** Whether the primary passes, for power.ts's simulation: decide's verdict on valid comparisons. */
export const passes = (diffs: Record<ComparisonKey, readonly number[]>, margin = RS1_MARGIN, quantile?: number) => decide(diffs, { margin, quantile }).verdict === 'pass';

// ─── Question scores and the common set ──────────────────────────────

/** One reader's value for one row and question: a graded score in [0, 1] per judge view, or why it is missing. */
export type ReaderValue = { frontier: number; bridge: number } | { drop: string };
/** One question: each row's reader values, by reader. */
export interface QuestionInput { id: string; conversation: string; rows: Record<Row, Record<string, ReaderValue>> }
export interface Drop { question: string; conversation: string; row: Row; side: 'gbrain' | 'server'; reason: string }
export interface Scored { id: string; conversation: string; scores: Record<Row, Record<View, number> | null> }

/** The three-reader mean x 100 per view for each row, or null with the drop reasons when any reader's value is missing. */
export function questionScores(q: QuestionInput, readers: readonly string[]): { scored: Scored; drops: Drop[] } {
  const drops: Drop[] = [];
  const scores = {} as Scored['scores'];
  for (const row of ['gbrain', ...SERVERS] as Row[]) {
    const values = readers.map(r => q.rows[row]?.[r] ?? { drop: 'answer_missing' });
    const missing = values.filter((v): v is { drop: string } => 'drop' in v);
    for (const m of missing) drops.push({ question: q.id, conversation: q.conversation, row, side: row === 'gbrain' ? 'gbrain' : 'server', reason: m.drop });
    const ok = values.filter((v): v is { frontier: number; bridge: number } => !('drop' in v));
    scores[row] = missing.length ? null : { frontier: 100 * ok.reduce((s, v) => s + v.frontier, 0) / ok.length, bridge: 100 * ok.reduce((s, v) => s + v.bridge, 0) / ok.length };
  }
  return { scored: { id: q.id, conversation: q.conversation, scores }, drops };
}

/** A question is in the common set when gbrain and both servers have a score under both views. */
export const inCommonSet = (s: Scored) => s.scores.gbrain !== null && SERVERS.every(x => s.scores[x] !== null);

/**
 * Per-conversation differences (gbrain minus server, mean over the conversation's questions) per comparison, in
 * conversation order. The value function gives a row's score for a question, or null to leave the question out
 * (default: the common set's scores).
 */
export function conversationDifferences(questions: readonly Scored[], value: (s: Scored, row: Row, view: View) => number | null = (s, row, view) => (inCommonSet(s) ? s.scores[row]![view] : null)): { conversations: string[]; diffs: Record<ComparisonKey, number[]> } {
  const conversations = [...new Set(questions.map(q => q.conversation))].sort();
  const diffs = Object.fromEntries(COMPARISONS.map(k => [k, [] as number[]])) as Record<ComparisonKey, number[]>;
  const kept: string[] = [];
  for (const c of conversations) {
    const qs = questions.filter(q => q.conversation === c);
    const per = COMPARISONS.map(key => {
      const [server, view] = key.split('/') as [Server, View];
      const xs = qs.flatMap(q => { const g = value(q, 'gbrain', view), s = value(q, server, view); return g === null || s === null ? [] : [g - s]; });
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    });
    if (per.some(x => x === null)) continue;
    kept.push(c);
    COMPARISONS.forEach((k, i) => diffs[k].push(per[i]!));
  }
  return { conversations: kept, diffs };
}

/** The worst-case sensitivity's values: a gbrain-side drop scores 0 and a server-side drop 100; every planned question counts. */
export const worstCase = (s: Scored, row: Row, view: View): number => s.scores[row]?.[view] ?? (row === 'gbrain' ? 0 : 100);

/** Drops over the cap per comparison: the share of planned questions outside the common set (one set for all four tests). */
export function dropValidity(questions: readonly Scored[]): { planned: number; common: number; share: number; invalid: Partial<Record<ComparisonKey, string[]>> } {
  const planned = questions.length;
  const common = questions.filter(inCommonSet).length;
  const share = planned ? (planned - common) / planned : 1;
  const invalid = share > RS1_DROP_CAP ? Object.fromEntries(COMPARISONS.map(k => [k, [`${planned - common} of ${planned} planned questions dropped (${(100 * share).toFixed(1)}%, above the 5% cap)`]])) : {};
  return { planned, common, share, invalid };
}
