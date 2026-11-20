import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { companyPageKey } from '../../../../eval/generators/company-dedupe-gen.ts';
import { mulberry32, pageKey, type DesignedPair } from '../../../../eval/generators/person-dedupe-gen.ts';
import { pairId, blockPairs } from '../../../../eval/runner/entity-h2h/blocker.ts';
import { OPERATING_POINTS, parseOutput, scoreOutput, type OperatingPoint } from '../../../../eval/runner/entity-h2h/score.ts';
import { loadWorld, type H2hWorld } from '../../../../eval/runner/entity-h2h/world.ts';
import { parseFinderOutput, scoreGroups, SELECTIONS, wilson } from '../../../../eval/runner/person-dedupe.ts';

const SCOPES = ['person', 'company', 'all'] as const;
type Scope = typeof SCOPES[number];
type Bounds = [number, number];
type Counts = [numerator: number, denominator: number];
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
const B = 4_000;

export function exactMcNemar(left: number, right: number) {
  const n = left + right;
  let term = 2 ** -n, tail = term;
  for (let k = 1; k <= Math.min(left, right); k++) {
    term *= (n - k + 1) / k;
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

export function pairedBounds(n: number, left: number, right: number) {
  const diff = (left - right) / n;
  const test = (d: number) => {
    if (d === diff) return 0;
    const log = (x: number, p: number) => x ? x * Math.log(p) : 0;
    const likelihood = (q: number) => log(left, (q + d) / 2) + log(right, (q - d) / 2) + log(n - left - right, 1 - q);
    let lo = Math.abs(d), hi = 1;
    for (let i = 0; i < 72; i++) {
      const a = (2 * lo + hi) / 3, b = (lo + 2 * hi) / 3;
      if (likelihood(a) < likelihood(b)) lo = a; else hi = b;
    }
    return Math.abs(diff - d) / Math.sqrt(Math.max(0, ((lo + hi) / 2 - d * d) / n));
  };
  const bound = (end: number, z: number) => {
    let inside = diff, outside = end;
    for (let i = 0; i < 40; i++) {
      const mid = (inside + outside) / 2;
      if (test(mid) > z) outside = mid; else inside = mid;
    }
    return (inside + outside) / 2;
  };
  const ci95: Bounds = [bound(-1, 1.959963984540054), bound(1, 1.959963984540054)];
  return { difference: diff, ci95, lower95: bound(-1, 1.6448536269514722), upper95: bound(1, 1.6448536269514722) };
}

function quantile(sorted: Float64Array, p: number) {
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function intervals(rep: Float64Array) {
  const sorted = rep.filter(Number.isFinite).sort();
  return sorted.length ? {
    ci95: [quantile(sorted, .025), quantile(sorted, .975)] as Bounds,
    lower95: quantile(sorted, .05),
    upper95: quantile(sorted, .95),
    used: sorted.length,
  } : null;
}

const clusterId = ({ family, instance }: { family: string; instance: number }) => `${family}/${instance}`;

function bootstrap(w: H2hWorld) {
  const clusterByPage = new Map([
    ...w.people.pages.map(p => [pageKey(p), clusterId(p)] as const),
    ...w.companies.pages.map(p => [companyPageKey(p), clusterId(p)] as const),
  ]);
  const families = new Map<string, string[]>();
  for (const id of new Set(clusterByPage.values())) {
    const family = id.slice(0, id.lastIndexOf('/'));
    if (!families.has(family)) families.set(family, []);
    families.get(family)!.push(id);
  }
  const draws = new Map<string, Uint8Array>();
  const random = mulberry32(1975418963);
  for (const instances of families.values()) {
    const strata = instances.map(id => {
      const weights = new Uint8Array(B);
      draws.set(id, weights);
      return weights;
    });
    for (let i = 0; i < B; i++) for (let j = 0; j < strata.length; j++) strata[Math.floor(random() * strata.length)][i]++;
  }
  const ratio = (totals: Map<string, Counts>) => {
    const result = new Float64Array(B), den = new Float64Array(B);
    for (const [id, [k, n]] of totals) {
      const weights = draws.get(id);
      if (!weights) throw new Error(`Unknown family instance: ${id}`);
      for (let i = 0; i < B; i++) { result[i] += k * weights[i]; den[i] += n * weights[i]; }
    }
    for (let i = 0; i < B; i++) result[i] /= den[i];
    return result;
  };
  return { clusterByPage, ratio };
}

function add(map: Map<string, Counts>, id: string, k: number, n: number) {
  const old = map.get(id);
  if (old) { old[0] += k; old[1] += n; } else map.set(id, [k, n]);
}

function ratioCounts(pairs: readonly DesignedPair[], hits: ReadonlyMap<string, number>) {
  const map = new Map<string, Counts>();
  for (const p of pairs) add(map, clusterId(p), hits.get(pairId(p.a, p.b)) ?? 0, 1);
  return map;
}

function compare(pairs: readonly DesignedPair[], a: Set<string>, b: Set<string>, resample: ReturnType<typeof bootstrap>['ratio']) {
  const signed = new Map<string, number>();
  let left = 0, right = 0;
  for (const { a: x, b: y } of pairs) {
    const key = pairId(x, y), d = Number(a.has(key)) - Number(b.has(key));
    if (d === 1) left++;
    if (d === -1) right++;
    signed.set(key, d);
  }
  return { n: pairs.length, left_only: left, right_only: right, mcnemar_p: exactMcNemar(left, right),
    ...pairedBounds(pairs.length, left, right), cluster: intervals(resample(ratioCounts(pairs, signed))) };
}

function components(known: ReadonlySet<string>, groups: string[][]) {
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    const next = parent.get(key);
    if (!next) return key;
    const r = root(next);
    parent.set(key, r);
    return r;
  };
  for (const g of groups) for (const key of g.slice(1)) {
    const a = root(g[0]), b = root(key);
    if (a !== b) parent.set(b, a);
  }
  const bins = new Map<string, string[]>();
  for (const key of known) {
    const r = root(key);
    if (!bins.has(r)) bins.set(r, []);
    bins.get(r)!.push(key);
  }
  return { root, bins: [...bins.values()] };
}

function groupPairs(groups: Iterable<string[]>) {
  const pairs = new Map<string, [string, string]>();
  for (const g of groups) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    if (g[i] !== g[j]) pairs.set(pairId(g[i], g[j]), [g[i], g[j]]);
  }
  return pairs;
}

function analyze(worldDir: string, counted: string) {
  const w = loadWorld(worldDir), known = new Set(w.gold.keys());
  const reveal = read<{ seed: number; nonce: string; commitment: string }>(join(counted, 'seed-reveal.json'));
  const preimage = `gbrain-evals er-h2h counted seed v1|seed=${reveal.seed}|nonce=${reveal.nonce}`;
  if (reveal.seed !== w.seed || createHash('sha256').update(preimage).digest('hex') !== reveal.commitment) throw new Error('Seed commitment mismatch');

  const { clusterByPage, ratio } = bootstrap(w);
  const pairScope = (p: DesignedPair) => w.people_gold.has(p.a) ? 'person' : 'company';
  const byScope = Object.fromEntries(SCOPES.map(scope => [scope, w.pairs.filter(p => scope === 'all' || pairScope(p) === scope)])) as Record<Scope, DesignedPair[]>;
  const blocked = blockPairs(w.pages.map(p => p.written));
  const candidates = new Set(blocked.pairs.map(([a, b]) => pairId(a, b)));
  const cells = readdirSync(counted, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  const pairTotals = (pairs: Iterable<[string, string]>, scope: Scope, accept: (a: string, b: string) => boolean) => {
    const res = new Map<string, Counts>();
    let k = 0, n = 0;
    const gold = scope === 'person' ? w.people_gold : scope === 'company' ? w.company_gold : w.gold;
    for (const [a, b] of pairs) {
      if (!gold.has(a) || !gold.has(b)) continue;
      const ok = Number(accept(a, b));
      n++; k += ok;
      add(res, clusterByPage.get(a)!, ok / 2, 1 / 2);
      add(res, clusterByPage.get(b)!, ok / 2, 1 / 2);
    }
    return { k, n, replicated: ratio(res) };
  };
  const correct = (a: string, b: string) => w.gold.get(a) === w.gold.get(b);
  const goldPairs = groupPairs(Object.values(Object.groupBy([...known], k => w.gold.get(k)!)).filter((g): g is string[] => !!g && g.length > 1));
  const finder = read<{ groups: Array<{ evidence: Array<{ rule: string; veto?: boolean }> }> }>(join(counted, 'gbrain', 'finder.json'));
  const parsed = parseFinderOutput(finder, known);
  const finderPairs = groupPairs(parsed.map(g => g.members));
  const confirm = { total: 0, real: 0, must_not_link: 0, vetoed: 0, vetoed_must_not_link: 0, marked_vetoed_outside: 0, outside_must_not_link: 0 };
  parsed.forEach((g, i) => {
    const marked = g.kind === 'cross_source' && finder.groups[i].evidence.some(e => e.rule === 'contact_key_only');
    const vetoed = finder.groups[i].evidence.some(e => e.rule === 'key_differs' && e.veto === true);
    const real = g.members.every(k => correct(k, g.members[0]));
    if (SELECTIONS['confirm-list'](g)) {
      confirm.total++; confirm.real += Number(real); confirm.must_not_link += Number(!real);
      confirm.vetoed += Number(vetoed); confirm.vetoed_must_not_link += Number(vetoed && !real);
    } else if (marked && vetoed) {
      confirm.marked_vetoed_outside++; confirm.outside_must_not_link += Number(!real);
    }
  });

  const details = cells.flatMap(id => {
    const dir = join(counted, id);
    const cell = read<{ status: string; world: { seed: number; people_ledger_sha256: string; company_ledger_sha256: string } }>(join(dir, 'cell.json'));
    if (cell.world.seed !== w.seed || cell.world.people_ledger_sha256 !== w.fingerprints.people || cell.world.company_ledger_sha256 !== w.fingerprints.companies) throw new Error(`${id} ran on another world`);
    if (cell.status === 'failed (infrastructure)') return [];
    if (cell.status !== 'complete') throw new Error(`${id} is not complete`);
    const out = parseOutput(read(join(dir, 'output.json')), known);
    const subjectsPath = join(dir, 'subjects.json');
    const unresolved = existsSync(subjectsPath) ? read<Array<{ key: string; node: null }>>(subjectsPath).filter(s => s.node === null).map(s => s.key) : undefined;
    const scores = scoreOutput(w, out, { candidates: out.system === 'llm-matcher' ? candidates : undefined, unresolved });
    const point = (tier: OperatingPoint) => {
      const groups = tier === 'auto' ? out.tiers.auto : [...out.tiers.auto, ...out.tiers.proposed];
      const mapped = groups.map(members => ({ members: [...new Set(members)].sort(), kind: 'cross_source', class: tier, rules: [] }));
      const sameAsScorer = new Set(scoreGroups(mapped, w.pairs.map(p => ({ ...p, label: 'different' as const })), w.gold).false_merge_cases.map(p => pairId(p.a, p.b)));
      const hit = new Map([...sameAsScorer].map(k => [k, 1]));
      const closed = components(known, groups);
      for (const p of w.pairs) if ((closed.root(p.a) === closed.root(p.b)) !== sameAsScorer.has(pairId(p.a, p.b))) throw new Error(`${id}/${tier}: closure disagrees with scorer`);
      const pairs = groupPairs(closed.bins);
      const cluster = Object.fromEntries(SCOPES.map(scope => {
        const relevant = byScope[scope];
        const summary = (subset: DesignedPair[], label: DesignedPair['label']) => intervals(ratio(ratioCounts(subset.filter(p => p.label === label), hit)))?.ci95 ?? null;
        const p = pairTotals(pairs.values(), scope, correct);
        const r = pairTotals(goldPairs.values(), scope, (a, b) => closed.root(a) === closed.root(b));
        const row = scores.points[tier][scope];
        if (p.k !== row.precision.k || p.n !== row.precision.n || r.k !== row.recall.k || r.n !== row.recall.n) throw new Error(`${id}/${tier}/${scope}: pair totals disagree with scorer`);
        return [scope, { false_merge: summary(relevant, 'different'), designed_recall: summary(relevant, 'same'),
          pairwise_precision: intervals(p.replicated)?.ci95 ?? null, pairwise_recall: intervals(r.replicated)?.ci95 ?? null,
          by_family: Object.fromEntries(Object.entries(Object.groupBy(relevant, p => p.family)).map(([f, ps]) => [f, {
            false_merge: summary(ps!, 'different'), designed_recall: summary(ps!, 'same'),
          }])) }];
      }));
      const falseMergeComponents = closed.bins.flatMap(members => {
        if (members.length < 2) return [];
        const sizes = Object.values(Object.groupBy(members, key => w.gold.get(key)!));
        const choose2 = (n: number) => n * (n - 1) / 2;
        const count = choose2(members.length) - sizes.reduce((sum, x) => sum + choose2(x!.length), 0);
        return count ? [{ first_page: members[0], pages: members.length, count }] : [];
      });
      if (falseMergeComponents.reduce((sum, g) => sum + g.count, 0) !== scores.points[tier].all.false_merges_anywhere) throw new Error(`${id}/${tier}: false-merge attribution disagrees with scorer`);
      return { merged: sameAsScorer, cluster, falseMergeComponents };
    };
    const [auto, proposed] = OPERATING_POINTS.map(point);
    const autoRoot = components(known, out.tiers.auto).root;
    const reviewGroups = out.tiers.proposed.filter(g => g.length > 1 && g.some(k => autoRoot(k) !== autoRoot(g[0])));
    const reviewPairs = [...groupPairs(reviewGroups).values()].filter(([a, b]) => autoRoot(a) !== autoRoot(b));
    const review = Object.fromEntries(SCOPES.map(scope => [scope, pairTotals(reviewPairs, scope, correct)])) as Record<Scope, ReturnType<typeof pairTotals>>;
    const real = reviewGroups.filter(g => g.every(k => correct(k, g[0]))).length;
    return [{ id, out, scores, auto, proposed, review, reviewLoad: {
      groups: reviewGroups.length, per_1000_pages: reviewGroups.length * 1000 / w.pages.length, real, share_real: reviewGroups.length ? real / reviewGroups.length : null,
      ...Object.fromEntries(SCOPES.map(scope => [scope, { correct: review[scope].k, pairs: review[scope].n, cluster_ci95: intervals(review[scope].replicated)?.ci95 ?? null }])),
    } }];
  });
  const gbrain = details.find(d => d.id === 'gbrain')!;
  const comparisons = details.filter(d => d !== gbrain).flatMap(d => (d.out.tiers.proposed.length ? OPERATING_POINTS : ['auto'] as const).flatMap(tier =>
    OPERATING_POINTS.map(reference => ({ left: `${d.id}/${tier}`, right: `gbrain/${reference}`,
      ...Object.fromEntries(SCOPES.map(scope => [scope, {
        false_merge: compare(byScope[scope].filter(p => p.label === 'different'), d[tier].merged, gbrain[reference].merged, ratio),
        recall: compare(byScope[scope].filter(p => p.label === 'same'), gbrain[reference].merged, d[tier].merged, ratio),
      }])),
    }))));
  const reviewPrecision = details.filter(d => d.out.system === 'llm-matcher').map(d => ({ left: d.id, right: 'gbrain',
    ...Object.fromEntries(SCOPES.map(scope => {
      const a = d.review[scope], b = gbrain.review[scope];
      return [scope, { difference: a.k / a.n - b.k / b.n, cluster: intervals(a.replicated.map((x, i) => x - b.replicated[i])) }];
    })),
  }));
  const modelPairing = details.filter(d => d.out.system === 'llm-matcher' && d.id !== 'claude').map(d => ({
    left: d.id, right: 'claude',
    ...Object.fromEntries(SCOPES.map(scope => [scope, Object.fromEntries(OPERATING_POINTS.map(tier => [tier, {
      false_merge: compare(byScope[scope].filter(p => p.label === 'different'), d[tier].merged, details.find(x => x.id === 'claude')![tier].merged, ratio),
    }]))])),
  }));
  const reached = (pairs: ReadonlySet<string>) => Object.fromEntries(SCOPES.map(scope => [scope, Object.fromEntries(
    (['different', 'same'] as const).map(label => {
      const ps = byScope[scope].filter(p => p.label === label);
      return [label, { k: ps.filter(p => pairs.has(pairId(p.a, p.b))).length, n: ps.length }];
    }))]));
  return {
    seed: w.seed, pages: w.pages.length, bootstrap_replicates: B,
    paired_difference_sign: { false_merge: 'left minus right', recall: 'right minus left (left shortfall)' },
    candidates: { matcher: { total: candidates.size, dropped: blocked.crowded, designed: reached(candidates) },
      gbrain_finder_groups: { total_pairs: finderPairs.size, designed: reached(new Set(finderPairs.keys())) } },
    confirm, gbrain_auto_wilson_upper: Object.fromEntries(SCOPES.map(s => [s, wilson(gbrain.scores.points.auto[s].false_merge.k, byScope[s].filter(p => p.label === 'different').length)?.[1]])),
    cells: details.map(d => ({ id: d.id, unresolved: d.scores.unresolved, auto: d.auto.cluster, proposed: d.proposed.cluster, review_load: d.reviewLoad, false_merge_components: { auto: d.auto.falseMergeComponents, proposed: d.proposed.falseMergeComponents } })),
    comparisons, review_precision_comparisons: reviewPrecision, matcher_false_merge_comparisons: modelPairing,
  };
}

if (import.meta.main) {
  const worldDir = process.argv[2];
  if (!worldDir) throw new Error('Pass the counted world directory as the first argument');
  const result = analyze(worldDir, process.argv[3] ?? join(import.meta.dir, '..', 'counted'));
  console.log('{' + Object.entries(result).map(([k, v]) =>
    `\n  ${JSON.stringify(k)}: ${Array.isArray(v) ? `[\n${v.map(row => '    ' + JSON.stringify(row)).join(',\n')}\n  ]` : JSON.stringify(v)}`
  ).join(',') + '\n}');
}
