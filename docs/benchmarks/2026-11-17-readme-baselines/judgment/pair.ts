/**
 * Keyless paired analysis for the judgment group's chronicle and Cat 35 rows
 * (analysis-plan.md in this folder). Reads only committed files.
 *
 *   bun docs/benchmarks/2026-11-17-readme-baselines/judgment/pair.ts > docs/benchmarks/2026-11-17-readme-baselines/judgment/paired.json
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clusteredPairedDelta, exactMcNemar, type PairedItem } from '../../../../eval/runner/stats/paired.ts';

const HERE = import.meta.dir;
const ROOT = join(HERE, '../../../..');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** Exact two-sided sign test on paired values (ties dropped), with the paired mean difference b - a and its bootstrap interval. */
function signTest(items: PairedItem[]) {
  const sign = exactMcNemar(items.filter(i => i.a !== i.b).map(i => ({ ...i, a: i.a > i.b ? 1 : 0, b: i.b > i.a ? 1 : 0 })));
  const d = clusteredPairedDelta(items, { seed: 20261117, draws: 10_000 });
  return { n: items.length, mean_gbrain: d.mean_a, mean_baseline: d.mean_b, baseline_minus_gbrain: d.delta, ci95: d.ci95,
    gbrain_higher: sign.losses, baseline_higher: sign.wins, ties: items.length - sign.discordant, p_sign_two_sided: sign.p_two_sided, clusters: d.n_clusters };
}

// ── Chronicle: wrong events per labeled page, and recall per labeled event ──
const gold = read(join(ROOT, 'eval/data/chronicle-lift-v1/gold-events.json')) as { pages: Array<{ slug: string; events: Array<{ id: string }> }> };
const gb = read(join(ROOT, 'docs/benchmarks/2026-10-04-auto-chronicle-rerun/scores.json'));
const pl = read(join(HERE, 'chronicle/scores.json'));
const matchPage = (await import('../../../../eval/runner/chronicle-lift.ts')).matchPage;
const wrongByPage = (arm: any) => {
  const m = new Map<string, number>();
  for (const u of arm.unmatched_labeled) if (u.premature || u.review === 'false') m.set(u.depth, (m.get(u.depth) ?? 0) + 1);
  return (slug: string) => m.get(slug) ?? 0;
};
const [ga, gbb, pa, pb] = [gb['on-a'], gb['on-b'], pl['plain-a'], pl['plain-b']].map(wrongByPage);
const chronWrong = signTest(gold.pages.map(p => ({ id: p.slug, cluster: p.slug, a: (ga(p.slug) + gbb(p.slug)) / 2, b: (pa(p.slug) + pb(p.slug)) / 2 })));
const eventsOf = (dir: string, arm: string) => read(join(dir, 'events-' + arm + '.json'));
const found = (events: any[]) => {
  const hit = new Set<string>();
  for (const g of gold.pages as any[]) for (const [gi] of matchPage(g.events, events.filter((e: any) => e.depth === g.slug))) hit.add(g.events[gi].id);
  return hit;
};
const gbDir = join(ROOT, 'docs/benchmarks/2026-10-04-auto-chronicle-rerun'), plDir = join(HERE, 'chronicle');
const [fa, fb, fpa, fpb] = [found(eventsOf(gbDir, 'on-a')), found(eventsOf(gbDir, 'on-b')), found(eventsOf(plDir, 'plain-a')), found(eventsOf(plDir, 'plain-b'))];
const chronRecall = signTest((gold.pages as any[]).flatMap(p => p.events.map((e: any) => ({ id: e.id, cluster: p.slug,
  a: (fa.has(e.id) ? 1 : 0) + (fb.has(e.id) ? 1 : 0), b: (fpa.has(e.id) ? 1 : 0) + (fpb.has(e.id) ? 1 : 0) }))));
const totals = (s: any) => ({ matched: s.labeled.matched, premature: s.labeled.premature, false: s.labeled.false, wrong_per_labeled_page: s.labeled.false_plus_premature_per_judged_labeled_page,
  events_written: s.events_written, slack_sample_false: s.conversations.sample.false, slack_premature: s.conversations.premature, controls_judged: s.controls_judged, cost_per_judged_page: s.cost.per_judged_page_metered });

// ── Cat 35: per gold item, judged credit and evidence-verified credit ──
const credit = (s: string) => (s === 'FULL' ? 1 : s === 'PARTIAL' ? 0.5 : 0);
const cat35 = (gbrainReceipt: string, gbrainLane: string, baselineReceipt: string, baselineLane: string) => {
  const g = read(gbrainReceipt), b = read(baselineReceipt);
  const rows = (r: any, lane: string) => new Map<string, any>(r.per_item.filter((x: any) => x.lane === lane).map((x: any) => [x.item_id, x]));
  const gr = rows(g, gbrainLane), br = rows(b, baselineLane);
  const both = [...gr.keys()].filter(id => br.has(id)).sort();
  const failed = (id: string) => gr.get(id).status === 'JUDGE_FAILED' || br.get(id).status === 'JUDGE_FAILED';
  const judgedFailed = both.filter(failed);
  const ids = both.filter(id => !failed(id));
  const pair = (f: (x: any) => number) => signTest(ids.map(id => ({ id, cluster: gr.get(id).transcript_id, a: f(gr.get(id)), b: f(br.get(id)) })));
  const summary = (r: any, lane: string) => ({ coverage: r.coverage_by_lane?.[lane] ?? null, hallucination: r.hallucination?.[lane] ?? null, distractor_leakage: r.distractor_leakage?.[lane] ?? null,
    usability: r.usability_by_lane?.[lane] ?? null, quote_fidelity: r.verbatim_quote_fidelity ?? null, emission: r.emission ?? null, attribution_hazards: r.attribution_hazards ?? null, judge_model: r.judge_model, judge_prompt_version: r.judge_prompt_version });
  return { items_paired: ids.length, items_excluded_for_a_judge_failure_in_either_arm: judgedFailed, judged_credit: pair(x => credit(x.status)), evidence_verified_credit: pair(x => x.joint ?? 0),
    gbrain: summary(g, gbrainLane), baseline: summary(b, baselineLane) };
};
const CAT35 = join(ROOT, 'docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill');
const out = {
  kind: 'readme-baselines-judgment-paired',
  chronicle: { wrong_events_per_labeled_page: chronWrong, recall_per_labeled_event_runs_found_0_to_2: chronRecall,
    gbrain: { 'on-a': totals(gb['on-a']), 'on-b': totals(gb['on-b']) }, baseline: { 'plain-a': totals(pl['plain-a']), 'plain-b': totals(pl['plain-b']) } },
  cat35_primary: cat35(join(CAT35, 'receipt-2026-08-31-v0.47.8.0-wave-079941d2.json'), 'dream', join(HERE, 'cat35/receipt-plain.json'), 'plain'),
  cat35_judge_drift_control: cat35(join(CAT35, 'baseline-receipt.json'), 'dream', join(HERE, 'cat35/receipt-gbrain-aug25-rejudged.json'), 'gbrain-aug25'),
};
console.log(JSON.stringify(out, null, 1));
