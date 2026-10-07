/**
 * Keyless $0 re-score of a Cat 20 receipt with per-idea judgments (W7).
 *
 * Decision rule (preregistered): Cat 20 passes when the median of the judges'
 * mean overall scores on passing ideas is at least 2.5; inconclusive when
 * fewer than 10 ideas pass. Also reports, per judge, the mean on passing,
 * rejected and all ideas with a 95% cluster-bootstrap interval (cluster: the
 * generation context, i.e. question plus close and far page), the passing
 * minus rejected gap, judge errors, and, across judges, pairwise Spearman
 * correlation and mean absolute difference on ideas both judges scored.
 *
 *   bun eval/runner/cat20-judges.ts <receipt.json> [<degraded receipt.json>]
 *
 * With a second receipt (the shuffled-corpus arm), it also prints the
 * negative-control ratio degraded / real on the same statistic.
 */
import { readFileSync } from 'node:fs';
import { seededRandom } from './stats/paired.ts';

export const FLOOR = 2.5;
export const MIN_PASSING = 10;
export const SEED = 20261006;
export const DRAWS = 10_000;

interface Idea { id: string; text: string; close_slug: string; far_slug: string; passes: boolean }
interface Judgment { judge: string; idea_id: string; overall: number | null; error: string | null }
interface Question { question: string; ideas?: Idea[]; idea_judgments?: Judgment[] }

export interface Row { key: string; cluster: string; passes: boolean; judge: string; overall: number | null }

export function rows(perQuestion: Question[]): Row[] {
  return perQuestion.flatMap((q, qi) => {
    const ideas = new Map((q.ideas ?? []).map(i => [i.id, i]));
    return (q.idea_judgments ?? []).map(j => {
      const idea = ideas.get(j.idea_id)!;
      return { key: `q${qi + 1}:${j.idea_id}`, cluster: `q${qi + 1}|${idea.close_slug}|${idea.far_slug}`, passes: idea.passes, judge: j.judge, overall: j.overall };
    });
  });
}

export function mean(xs: number[]): number | null { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Cluster-bootstrap percentile interval of a mean. */
export function clusterMeanCI(items: Array<{ cluster: string; value: number }>, seed = SEED, draws = DRAWS): [number, number] | null {
  const byCluster = new Map<string, number[]>();
  for (const it of items) byCluster.set(it.cluster, [...(byCluster.get(it.cluster) ?? []), it.value]);
  const clusters = [...byCluster.keys()].sort().map(k => byCluster.get(k)!);
  if (clusters.length < 2) return null;
  const rand = seededRandom(seed);
  const boot: number[] = [];
  for (let d = 0; d < draws; d++) {
    let sum = 0, n = 0;
    for (let c = 0; c < clusters.length; c++) { const pick = clusters[Math.floor(rand() * clusters.length)]!; for (const v of pick) { sum += v; n++; } }
    boot.push(sum / n);
  }
  boot.sort((a, b) => a - b);
  return [boot[Math.floor(draws * 0.025)]!, boot[Math.ceil(draws * 0.975) - 1]!];
}

function ranks(xs: number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation with average ranks for ties; null when either side is constant. */
export function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ra = ranks(a), rb = ranks(b);
  const ma = mean(ra)!, mb = mean(rb)!;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { num += (ra[i]! - ma) * (rb[i]! - mb); da += (ra[i]! - ma) ** 2; db += (rb[i]! - mb) ** 2; }
  return da === 0 || db === 0 ? null : num / Math.sqrt(da * db);
}

export function summarize(perQuestion: Question[]) {
  const all = rows(perQuestion);
  const judges = [...new Set(all.map(r => r.judge))];
  const ideasTotal = perQuestion.reduce((n, q) => n + (q.ideas?.length ?? 0), 0);
  const passingTotal = perQuestion.reduce((n, q) => n + (q.ideas?.filter(i => i.passes).length ?? 0), 0);
  const perJudge = judges.map(judge => {
    const mine = all.filter(r => r.judge === judge);
    const scored = mine.filter(r => r.overall !== null) as Array<Row & { overall: number }>;
    const pass = scored.filter(r => r.passes), rej = scored.filter(r => !r.passes);
    return {
      judge, judgments: mine.length, errors: mine.length - scored.length,
      mean_passing: mean(pass.map(r => r.overall)), ci_passing: clusterMeanCI(pass.map(r => ({ cluster: r.cluster, value: r.overall }))),
      mean_rejected: mean(rej.map(r => r.overall)), mean_all: mean(scored.map(r => r.overall)),
      passing_minus_rejected: pass.length && rej.length ? mean(pass.map(r => r.overall))! - mean(rej.map(r => r.overall))! : null,
      crosses_floor: (mean(pass.map(r => r.overall)) ?? -1) >= FLOOR,
    };
  });
  const pairs: Array<{ a: string; b: string; n: number; spearman: number | null; mean_abs_diff: number | null }> = [];
  for (let i = 0; i < judges.length; i++) for (let j = i + 1; j < judges.length; j++) {
    const a = new Map(all.filter(r => r.judge === judges[i] && r.overall !== null).map(r => [r.key, r.overall!]));
    const both = all.filter(r => r.judge === judges[j] && r.overall !== null && a.has(r.key));
    const xa = both.map(r => a.get(r.key)!), xb = both.map(r => r.overall!);
    pairs.push({ a: judges[i]!, b: judges[j]!, n: both.length, spearman: spearman(xa, xb), mean_abs_diff: mean(xa.map((v, k) => Math.abs(v - xb[k]!))) });
  }
  const means = perJudge.map(p => p.mean_passing).filter((v): v is number => v !== null);
  const statistic = median(means);
  const decision = passingTotal < MIN_PASSING ? 'inconclusive' : statistic === null ? 'inconclusive' : statistic >= FLOOR ? 'pass' : 'fail';
  return { ideas: ideasTotal, passing: passingTotal, judges: perJudge, pairs, median_of_judge_means_on_passing: statistic,
    judges_crossing_floor: perJudge.filter(p => p.crosses_floor).length, decision,
    median_of_judge_means_on_all: median(perJudge.map(p => p.mean_all).filter((v): v is number => v !== null)) };
}

if (import.meta.main) {
  const [real, degraded] = process.argv.slice(2);
  if (!real) { console.error('usage: bun eval/runner/cat20-judges.ts <receipt.json> [<degraded receipt.json>]'); process.exit(2); }
  const load = (p: string) => summarize((JSON.parse(readFileSync(p, 'utf8')) as { data: { per_question: Question[] } }).data.per_question);
  const r = load(real);
  const out: Record<string, unknown> = { real: r };
  if (degraded) {
    const d = load(degraded);
    const realStat = r.median_of_judge_means_on_all, degStat = d.median_of_judge_means_on_all;
    out.degraded = d;
    out.negative_control = { statistic: 'median of the judges\' mean overall on all generated ideas', real: realStat, degraded: degStat,
      ratio: realStat && degStat !== null ? degStat / realStat : null };
  }
  console.log(JSON.stringify(out, null, 2));
}
