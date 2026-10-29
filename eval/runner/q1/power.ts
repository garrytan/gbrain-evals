/**
 * Q1 scoreboard power and coverage simulation (plan §4.6, "Power first").
 *
 * Question: with BEAM-10M's ten conversations, about 20 questions each, a
 * Holm family of nine component comparisons (gbrain-defaults against every
 * other 8k component row) and the three-reader mean as the tested estimand,
 * what is the smallest true difference Family 1 detects with 80% power at a
 * family-wise 5%? And does the restricted wild cluster bootstrap-t with Webb
 * weights (eval/runner/stats/wild-cluster.ts) hold its size and coverage at
 * this family, including when clusters are unequal or missing?
 *
 *   bun eval/runner/q1/power.ts [--output <power.json>] [--sims N] [--draws N] [--seed N]
 *     [--dev-strength <json: {"<kind id>": <dev three-reader mean>, ...}>] [--json]
 *
 * Inputs (dev and public only; no sealed data):
 *   - graded BEAM scores from the starting-line rows of BEAM-1M dev and
 *     BEAM-100K dev (docs/benchmarks/2026-10-05-heldout-program/starting-line,
 *     `*-qa-master` shards), pooled by BEAM ability;
 *   - the within-conversation variance and the between-conversation spread of
 *     those rows;
 *   - the per-conversation SD 0.0732 of one external system's public BEAM-10M
 *     result (ten conversation means; exposure record of 2026-10-06).
 *
 * Generative model for one simulated S1 run (true difference 0):
 *   1. Each conversation has n_c questions, cycled through the ten BEAM
 *      abilities. Each question draws a base score from its ability's pool.
 *   2. Each arm (gbrain-defaults plus m comparators) keeps the base score
 *      with probability rho_arm, otherwise draws its own score from the same
 *      pool: correlated arms.
 *   3. Each of three readers keeps the arm's score with probability
 *      rho_reader, otherwise draws from the pool; the question's value is the
 *      three-reader mean, the scoreboard's estimand.
 *   4. Each (arm, conversation) adds u ~ Normal(0, tau_arm^2): some
 *      conversations suit one system.
 * gbrain-defaults' arm is shared by all m comparisons, so the family's tests
 * are correlated the way the real ones are. A true difference delta enters as
 * a location shift; the restricted test is equivariant in (data, null)
 * jointly, so testing H0: theta = -delta on data with truth 0 is testing
 * H0: theta = 0 on data with truth delta, and one set of shared weights gives
 * every delta on the grid.
 *
 * Reported per design and scenario: family-wise error at truth 0 (Holm over
 * the m two-sided p-values), coverage of the two-sided 95% interval (the test
 * at the true value), power with one true effect (the others null, the
 * conservative case: Holm's first step at alpha/m) and with all effects
 * equal, and the minimum detectable difference at 80% power.
 *
 * Decision rule (preregistered, plan §4.6): if the central scenario's
 * single-effect MDD on the balanced design exceeds 10 points for most rows,
 * Family 1 shrinks to gbrain-defaults against the four strongest dev rows
 * (component and whole-system families stay separate) and the MDD is
 * recomputed at m = 4; if that still exceeds 10 points, S1 is published
 * descriptively with its detectable difference and no superiority claim.
 * Comparator rows are exchangeable under these inputs (one rho_arm per
 * scenario), so one MDD applies to every row until dev smokes give per-row
 * correlations.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { holmAdjusted, seededRandom } from '../stats/paired.ts';
import { prepare, wildRestrictedP, type ClusterRow } from '../stats/wild-cluster.ts';
import { renderOperatorMessage } from '../decisions/errors.ts';

const ROOT = resolve(import.meta.dir, '../../..');
export const STARTING_LINE = 'docs/benchmarks/2026-10-05-heldout-program/starting-line';
export const DEV_SETS = ['beam-1m-qa-master', 'beam-100k-qa-master'] as const;
/** Ten BEAM-10M conversation means of one external system's public result (exposure record, 2026-10-06). */
export const PUBLIC_10M_CONVERSATION_SD = 0.0732;
export const DEFAULT_OUTPUT = 'docs/benchmarks/2026-10-06-scoreboard/power.json';
export const MDD_THRESHOLD_POINTS = 10;
export const TARGET_POWER = 0.8;
export const ALPHA = 0.05;
export const READERS = 3;
export const FAMILY1_SIZE = 9;
export const SHRUNK_SIZE = 4;

// ─── Dev inputs ─────────────────────────────────────────────────────

export interface DevRow { id: string; conversation: string; category: string; score: number }
export interface DevSource { path: string; sha256: string; rows: number }
export interface DevInputs {
  sources: DevSource[];
  pools: Record<string, number[]>;
  /** Pooled variance of a question's score around its ability mean, inside a conversation. */
  within_variance: number;
  /** Method-of-moments SD of a conversation's true mean, BEAM-1M dev (11 conversations). */
  dev_tau: number;
  dev_conversation_mean_sd: number;
  /** The public BEAM-10M spread with the question-sampling part removed (20 questions per conversation). */
  public_10m_tau: number;
}

export function readDevRows(root = ROOT): { rows: Record<string, DevRow[]>; sources: DevSource[] } {
  const rows: Record<string, DevRow[]> = {}, sources: DevSource[] = [];
  for (const set of DEV_SETS) {
    const dir = join(root, STARTING_LINE, set);
    rows[set] = [];
    for (const shard of readdirSync(dir).filter(d => d.startsWith('shard-')).sort()) {
      const path = join(dir, shard, 'rows.ndjson.gz');
      const buf = readFileSync(path);
      const parsed = gunzipSync(buf).toString('utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, unknown>);
      for (const r of parsed) {
        if (typeof r.qa_score !== 'number') throw new Error(`${relative(root, path)}: ${String(r.id)} has no graded qa_score`);
        rows[set].push({ id: String(r.id), conversation: String(r.conversation), category: String(r.category), score: r.qa_score });
      }
      sources.push({ path: relative(root, path), sha256: createHash('sha256').update(buf).digest('hex'), rows: parsed.length });
    }
  }
  return { rows, sources };
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const variance = (xs: readonly number[]) => { const m = mean(xs); return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1); };

export function devInputs(rows: Record<string, DevRow[]>, sources: DevSource[]): DevInputs {
  const all = Object.values(rows).flat();
  const pools: Record<string, number[]> = {};
  for (const r of all) (pools[r.category] ??= []).push(r.score);
  for (const k of Object.keys(pools)) pools[k].sort((a, b) => a - b);
  let ss = 0, df = 0;
  for (const set of Object.values(rows)) {
    const cells = new Map<string, number[]>();
    for (const r of set) { const k = `${r.conversation}\u0000${r.category}`; cells.set(k, [...(cells.get(k) ?? []), r.score]); }
    for (const xs of cells.values()) if (xs.length > 1) { const m = mean(xs); ss += xs.reduce((s, x) => s + (x - m) ** 2, 0); df += xs.length - 1; }
  }
  const within = ss / df;
  const m1 = rows['beam-1m-qa-master'];
  const byConv = new Map<string, number[]>();
  for (const r of m1) byConv.set(r.conversation, [...(byConv.get(r.conversation) ?? []), r.score]);
  const convMeans = [...byConv.values()].map(mean);
  const perConv = mean([...byConv.values()].map(xs => xs.length));
  const devTau = Math.sqrt(Math.max(0, variance(convMeans) - within / perConv));
  return {
    sources,
    pools,
    within_variance: within,
    dev_tau: devTau,
    dev_conversation_mean_sd: Math.sqrt(variance(convMeans)),
    public_10m_tau: Math.sqrt(Math.max(0, PUBLIC_10M_CONVERSATION_SD ** 2 - within / 20)),
  };
}

// ─── Scenarios and designs ──────────────────────────────────────────

export interface Scenario { name: 'optimistic' | 'central' | 'pessimistic'; tau_arm: number; rho_arm: number; rho_reader: number; source: string }

/**
 * Three assumption sets. tau comes from the inputs; rho_arm and rho_reader
 * are stated assumptions until dev smokes give paired cross-system and
 * cross-reader rows (the starting line has one system and one reader).
 * Readers that agree more are the pessimistic case: averaging three readers
 * then removes less noise from the estimand.
 */
export function scenarios(d: DevInputs): Scenario[] {
  const r = (x: number) => Number(x.toFixed(5));
  return [
    { name: 'optimistic', tau_arm: r(d.public_10m_tau), rho_arm: 0.5, rho_reader: 0.5, source: `tau: public BEAM-10M per-conversation SD ${PUBLIC_10M_CONVERSATION_SD} minus the question-sampling part at 20 questions (dev within-conversation variance); arms agree on 50% of questions; readers keep the arm's score 50% of the time` },
    { name: 'central', tau_arm: r(d.dev_tau), rho_arm: 0.35, rho_reader: 0.7, source: 'tau: BEAM-1M dev between-conversation spread beyond question sampling, all of it treated as specific to one system; arms agree on 35%; readers keep the arm\'s score 70% of the time' },
    { name: 'pessimistic', tau_arm: PUBLIC_10M_CONVERSATION_SD, rho_arm: 0.2, rho_reader: 0.9, source: `tau: the whole public BEAM-10M per-conversation SD ${PUBLIC_10M_CONVERSATION_SD} treated as system-specific; arms agree on 20%; readers keep the arm's score 90% of the time` },
  ];
}

export interface Design { id: string; label: string; sizes: number[]; comparisons: number; drop_clusters: number; drop_question_share: number }

export const DESIGNS: Design[] = [
  { id: 'balanced', label: '10 conversations x 20 questions, Holm over 9', sizes: Array(10).fill(20), comparisons: FAMILY1_SIZE, drop_clusters: 0, drop_question_share: 0 },
  { id: 'unequal', label: '10 conversations of 10 to 30 questions (200 total), Holm over 9', sizes: [10, 12, 14, 16, 18, 22, 24, 26, 28, 30], comparisons: FAMILY1_SIZE, drop_clusters: 0, drop_question_share: 0 },
  { id: 'missing', label: '9 of 10 conversations retained and 5% of the rest missing per comparison, Holm over 9', sizes: Array(10).fill(20), comparisons: FAMILY1_SIZE, drop_clusters: 1, drop_question_share: 0.05 },
  { id: 'shrunk', label: '10 conversations x 20 questions, Holm over 4 (the shrink rule)', sizes: Array(10).fill(20), comparisons: SHRUNK_SIZE, drop_clusters: 0, drop_question_share: 0 },
];

// ─── Simulation ─────────────────────────────────────────────────────

export interface SimOptions { sims: number; draws: number; seed: number; deltas_points: number[] }

export interface SimResult {
  design: string;
  scenario: string;
  comparisons: number;
  sims: number;
  draws: number;
  /** Share of simulated runs in which Holm rejects at least one true null. */
  fwer: number;
  /** Share of comparisons whose two-sided 95% interval holds the true difference. */
  coverage: number;
  /** Per-question SD of the four-reader-mean paired difference actually simulated. */
  diff_sd: number;
  power_single: Array<{ delta_points: number; power: number }>;
  power_all: Array<{ delta_points: number; power: number }>;
  mdd_points_single: number | null;
  mdd_points_all: number | null;
}

const normal = (rng: () => number) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

/** Smallest delta (linear interpolation on the grid) whose power reaches the target; null if the grid never does. */
export function minimumDetectable(curve: ReadonlyArray<{ delta_points: number; power: number }>, target = TARGET_POWER): number | null {
  for (let i = 0; i < curve.length; i++) {
    if (curve[i].power < target) continue;
    if (i === 0) return curve[0].delta_points;
    const a = curve[i - 1], b = curve[i];
    return Number((a.delta_points + (target - a.power) / (b.power - a.power) * (b.delta_points - a.delta_points)).toFixed(2));
  }
  return null;
}

export function simulate(d: DevInputs, scenario: Scenario, design: Design, o: SimOptions): SimResult {
  const rng = seededRandom(o.seed);
  const cats = Object.keys(d.pools).sort();
  const pools = cats.map(k => Float64Array.from(d.pools[k]));
  const draw = (k: number) => pools[k][Math.floor(rng() * pools[k].length)];
  const m = design.comparisons, arms = m + 1;
  const deltas = o.deltas_points.map(x => x / 100);
  const theta0s = deltas.map(x => -x);
  const zero = o.deltas_points.indexOf(0);
  if (zero < 0) throw new Error('the delta grid must include 0');
  let fwerHits = 0, covered = 0, tests = 0, diffSum = 0, diffSq = 0, diffN = 0;
  const single = new Float64Array(deltas.length), all = new Float64Array(deltas.length);
  const G = design.sizes.length;
  for (let s = 0; s < o.sims; s++) {
    const values: Float64Array[][] = Array.from({ length: arms }, () => []);
    for (let c = 0; c < G; c++) {
      const n = design.sizes[c];
      const base = new Float64Array(n), cat = new Int32Array(n);
      for (let q = 0; q < n; q++) { cat[q] = q % cats.length; base[q] = draw(cat[q]); }
      for (let a = 0; a < arms; a++) {
        const u = scenario.tau_arm * normal(rng);
        const v = new Float64Array(n);
        for (let q = 0; q < n; q++) {
          const own = rng() < scenario.rho_arm ? base[q] : draw(cat[q]);
          let r = 0;
          for (let k = 0; k < READERS; k++) r += rng() < scenario.rho_reader ? own : draw(cat[q]);
          v[q] = r / READERS + u;
        }
        values[a].push(v);
      }
    }
    const dropped = new Set<number>();
    while (dropped.size < design.drop_clusters) dropped.add(Math.floor(rng() * G));
    const p = Array.from({ length: m }, (_, j) => {
      const rows: ClusterRow[] = [];
      for (let c = 0; c < G; c++) {
        if (dropped.has(c)) continue;
        let n = 0, sum = 0;
        for (let q = 0; q < design.sizes[c]; q++) {
          if (design.drop_question_share > 0 && rng() < design.drop_question_share) continue;
          const diff = values[0][c][q] - values[j + 1][c][q];
          n++; sum += diff; diffSum += diff; diffSq += diff * diff; diffN++;
        }
        if (n) rows.push({ id: `c${c}`, stratum: 's1', n, sum });
      }
      return wildRestrictedP(prepare(rows), theta0s, { draws: o.draws, seed: o.seed * 7919 + s * 31 + j, weights: 'webb', alternative: 'two-sided' });
    });
    const atZero = p.map(x => x[zero]);
    if (holmAdjusted(atZero).some(x => x <= ALPHA)) fwerHits++;
    for (const x of atZero) { tests++; if (x > ALPHA) covered++; }
    deltas.forEach((_, i) => {
      if (holmAdjusted([p[0][i], ...atZero.slice(1)])[0] <= ALPHA) single[i]++;
      all[i] += holmAdjusted(p.map(x => x[i])).filter(x => x <= ALPHA).length / m;
    });
  }
  const r4 = (x: number) => Number(x.toFixed(4));
  const curve = (h: Float64Array) => o.deltas_points.map((delta_points, i) => ({ delta_points, power: r4(h[i] / o.sims) }));
  const ps = curve(single), pa = curve(all);
  const dm = diffSum / diffN;
  return {
    design: design.id, scenario: scenario.name, comparisons: m, sims: o.sims, draws: o.draws,
    fwer: r4(fwerHits / o.sims), coverage: r4(covered / tests), diff_sd: r4(Math.sqrt(diffSq / diffN - dm * dm)),
    power_single: ps, power_all: pa, mdd_points_single: minimumDetectable(ps), mdd_points_all: minimumDetectable(pa),
  };
}

// ─── Decision ───────────────────────────────────────────────────────

export type Family1Plan = 'full' | 'shrunk' | 'descriptive';

export interface PowerDecision {
  rule: string;
  threshold_points: number;
  scenario: 'central';
  full_family: { comparisons: number; mdd_points: number | null; rows_over_threshold: number };
  shrunk_family: { comparisons: number; mdd_points: number | null } | null;
  family1: Family1Plan;
  /** Comparators kept by the shrink rule, strongest dev three-reader mean first; null until dev smokes supply the means. */
  shrunk_comparators: string[] | null;
  detectable_difference_points: number | null;
  note: string;
}

/** The shrink rule's comparators: the four strongest dev rows by mean, ties broken by kind id. */
export function strongestDevRows(devMeans: Record<string, number>, k = SHRUNK_SIZE): string[] {
  return Object.entries(devMeans).filter(([id]) => id !== 'gbrain-defaults').sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, k).map(([id]) => id);
}

const over = (mdd: number | null) => mdd === null || mdd > MDD_THRESHOLD_POINTS;

export function decide(results: readonly SimResult[], devMeans: Record<string, number> | null): PowerDecision {
  const find = (design: string) => results.find(r => r.design === design && r.scenario === 'central');
  const full = find('balanced'), shrunk = find('shrunk');
  if (!full || !shrunk) throw new Error('decide needs the central balanced and shrunk results');
  const rowsOver = over(full.mdd_points_single) ? FAMILY1_SIZE : 0;
  const shrink = rowsOver > FAMILY1_SIZE / 2;
  const family1: Family1Plan = !shrink ? 'full' : over(shrunk.mdd_points_single) ? 'descriptive' : 'shrunk';
  const used = family1 === 'full' ? full : shrunk;
  return {
    rule: `If the central scenario's single-effect minimum detectable difference on the balanced design exceeds ${MDD_THRESHOLD_POINTS} points for most of the ${FAMILY1_SIZE} rows, Family 1 shrinks to gbrain-defaults against the ${SHRUNK_SIZE} strongest dev rows; if the shrunk family's still exceeds ${MDD_THRESHOLD_POINTS} points, S1 is published descriptively with its detectable difference and no superiority claim.`,
    threshold_points: MDD_THRESHOLD_POINTS,
    scenario: 'central',
    full_family: { comparisons: FAMILY1_SIZE, mdd_points: full.mdd_points_single, rows_over_threshold: rowsOver },
    shrunk_family: shrink ? { comparisons: SHRUNK_SIZE, mdd_points: shrunk.mdd_points_single } : null,
    family1,
    // The shrink happens whenever the full family is underpowered; a still-underpowered shrunk family is published
    // descriptively, and its detectable difference is the four named comparisons'.
    shrunk_comparators: shrink && devMeans ? strongestDevRows(devMeans) : null,
    detectable_difference_points: used.mdd_points_single,
    note: shrink && !devMeans
      ? 'The four comparators are chosen from the dev smokes\' three-reader means (rerun with --dev-strength) and written into the preregistration before any S1 cell runs.'
      : shrink ? `The four comparators are the strongest dev rows by three-reader mean; ${family1 === 'descriptive' ? 'their comparisons are still underpowered, so S1 is published descriptively with this detectable difference' : 'Family 1 tests gbrain-defaults against them'}. Comparator rows are exchangeable under these inputs, so one detectable difference applies to every row.`
      : 'Comparator rows are exchangeable under these inputs, so one detectable difference applies to every row; rerun when dev smokes give paired cross-system rows.',
  };
}

// ─── CLI ────────────────────────────────────────────────────────────

export const DEFAULT_SIM: SimOptions = { sims: 1000, draws: 1999, seed: 20261006, deltas_points: Array.from({ length: 31 }, (_, i) => i) };

export interface PowerReport {
  schema: 'gbrain-evals/q1-power/v1';
  command: string;
  method: string;
  inputs: Omit<DevInputs, 'pools'> & { public_10m_conversation_sd: number; pools: Record<string, { n: number; mean: number }> };
  options: SimOptions & { alpha: number; target_power: number; readers: number; weights: 'webb' };
  scenarios: Scenario[];
  designs: Design[];
  results: SimResult[];
  decision: PowerDecision;
}

export function runPower(o: SimOptions, devMeans: Record<string, number> | null, root = ROOT): PowerReport {
  const { rows, sources } = readDevRows(root);
  const d = devInputs(rows, sources);
  const sc = scenarios(d);
  const results: SimResult[] = [];
  for (const design of DESIGNS) for (const s of sc) results.push(simulate(d, s, design, o));
  const r5 = (x: number) => Number(x.toFixed(5));
  return {
    schema: 'gbrain-evals/q1-power/v1',
    command: `bun eval/runner/q1/power.ts --sims ${o.sims} --draws ${o.draws} --seed ${o.seed}${devMeans ? ' --dev-strength <file>' : ''}`,
    method: 'restricted wild cluster bootstrap-t, Webb weights, two-sided, Holm within the family; estimand: per-question three-reader mean, clustered by conversation',
    inputs: {
      sources: d.sources, within_variance: r5(d.within_variance), dev_tau: r5(d.dev_tau), dev_conversation_mean_sd: r5(d.dev_conversation_mean_sd), public_10m_tau: r5(d.public_10m_tau),
      public_10m_conversation_sd: PUBLIC_10M_CONVERSATION_SD,
      pools: Object.fromEntries(Object.entries(d.pools).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, { n: v.length, mean: r5(mean(v)) }])),
    },
    options: { ...o, alpha: ALPHA, target_power: TARGET_POWER, readers: READERS, weights: 'webb' },
    scenarios: sc,
    designs: DESIGNS,
    results,
    decision: decide(results, devMeans),
  };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const num = (name: string, dflt: number) => {
    const raw = flag(argv, name);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) {
      const op = { code: 'SPEC_INVALID' as const, message: `${name} must be a positive integer, got ${raw}`, why: 'the simulation counts set the Monte Carlo error of every power and coverage figure', fix: { next: 'run' as const, argv: ['bun', 'eval/runner/q1/power.ts', name, String(dflt)], verify: ['bun', 'eval/runner/q1/power.ts', '--sims', '50', '--draws', '199', '--output', '/dev/null'] } };
      if (argv.includes('--json')) console.log(JSON.stringify(op, null, 2)); else console.error(renderOperatorMessage(op));
      process.exit(2);
    }
    return n;
  };
  const o: SimOptions = { ...DEFAULT_SIM, sims: num('--sims', DEFAULT_SIM.sims), draws: num('--draws', DEFAULT_SIM.draws), seed: num('--seed', DEFAULT_SIM.seed) };
  const strengthPath = flag(argv, '--dev-strength');
  if (strengthPath && !existsSync(strengthPath)) {
    const op = { code: 'SPEC_MISSING' as const, message: `--dev-strength file ${strengthPath} does not exist`, why: 'the shrink rule keeps the four strongest dev rows, read from that file', fix: { next: 'run' as const, argv: ['bun', 'eval/runner/q1/power.ts'], user_message: 'omit --dev-strength to record the rule without choosing comparators', verify: ['ls', strengthPath] } };
    if (argv.includes('--json')) console.log(JSON.stringify(op, null, 2)); else console.error(renderOperatorMessage(op));
    process.exit(2);
  }
  const report = runPower(o, strengthPath ? JSON.parse(readFileSync(strengthPath, 'utf8')) as Record<string, number> : null);
  const output = resolve(flag(argv, '--output') ?? join(ROOT, DEFAULT_OUTPUT));
  if (output !== '/dev/null') mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (argv.includes('--json')) console.log(JSON.stringify(report.decision, null, 2));
  else {
    for (const r of report.results) console.log(`${r.design.padEnd(9)} ${r.scenario.padEnd(11)} m=${r.comparisons} fwer ${r.fwer.toFixed(3)} coverage ${r.coverage.toFixed(3)} mdd single ${r.mdd_points_single ?? '>30'} all ${r.mdd_points_all ?? '>30'} points`);
    console.log(`Family 1: ${report.decision.family1}; detectable difference ${report.decision.detectable_difference_points ?? 'over 30'} points (central). Wrote ${relative(ROOT, output) || output}`);
  }
}
