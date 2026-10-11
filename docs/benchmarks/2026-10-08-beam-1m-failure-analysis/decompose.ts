/**
 * B2 free decomposition of BEAM-1M dev ($0). Joins the committed 2026-10-06 bridge answer rows (top-10 ranked session
 * lists, gpt-4.1-mini answers and rubric scores) with the dataset's gold sessions and the keyless hash-embedding arm in
 * arms/hash-6622a119e, and writes decomposition.json: retrieval feasibility, batch-granularity rescoring, the none@5
 * classification, committed-wrong tags and the category x bucket table. With --check it exits 1 when the committed
 * decomposition.json differs.
 *
 * Needs the BEAM-1M files (`bun run eval:decide fetch --benchmark beam-1m`, free); reads only the dev conversations.
 * Usage: bun docs/benchmarks/2026-10-08-beam-1m-failure-analysis/decompose.ts [--check]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadBeam, type Session } from '../../../eval/runner/memory-qa/corpus.ts';
import { devConversations } from '../../../eval/runner/decisions/splits.ts';
import { DECLINE } from './decline.ts';

const here = import.meta.dir;
type Row = { id: string; conversation: string; category: string; abstention: boolean; gold_count: number; retrieved: string[]; qa_score?: number; qa_answer?: string; error: string | null };

function rows(dir: string): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const shard of readdirSync(dir).filter(d => d.startsWith('shard-')).sort()) {
    for (const line of gunzipSync(readFileSync(join(dir, shard, 'rows.ndjson.gz'))).toString('utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as Row; out.set(r.id, r);
    }
  }
  return out;
}

const bridge = rows(join(here, '../2026-10-06-beam-1m-dates/qa/baseline'));
const hash = rows(join(here, 'arms/hash-6622a119e'));
const corpus = loadBeam('1m', devConversations('beam-1m')!);
const questions = new Map(corpus.questions.map(q => [q.id, q]));
const sessions = new Map(corpus.conversations.flatMap(c => c.sessions.map(s => [`${c.id}/${s.id}`, s] as const)));
const labels = (JSON.parse(readFileSync(join(here, 'committed-wrong-labels.json'), 'utf8')) as { labels: Record<string, string> }).labels;

const all = [...bridge.values()].sort((a, b) => a.id.localeCompare(b.id));
const gold = (r: Row) => questions.get(r.id)!.gold;
if (all.length !== 220 || all.some(r => gold(r).length !== r.gold_count)) throw new Error('committed rows and dataset gold disagree');
const withGold = all.filter(r => !r.abstention && r.gold_count > 0);
const hitsAll = (list: string[], g: string[], k: number) => g.every(x => list.slice(0, k).includes(x));
const hitsAny = (list: string[], g: string[], k: number) => g.some(x => list.slice(0, k).includes(x));
const bucket = (r: Row) => r.abstention ? 'abstention' : r.gold_count === 0 ? 'no_gold' : hitsAll(r.retrieved, gold(r), 5) ? 'all@5' : hitsAny(r.retrieved, gold(r), 5) ? 'some@5' : 'none@5';
const score = (r: Row) => r.qa_score ?? 0;
const strict = (xs: Row[]) => ({ n: xs.length, mean_score: round(xs.reduce((s, r) => s + score(r), 0) / Math.max(1, xs.length)), all_items_met: xs.filter(r => score(r) === 1).length, zero: xs.filter(r => score(r) === 0).length });
function round(x: number, d = 4) { return Math.round(x * 10 ** d) / 10 ** d; }

// 1. Strict-recall feasibility, reported apart from the answer rubric.
const byGoldCount = (k: number) => {
  const feasible = withGold.filter(r => r.gold_count <= k);
  return { feasible: feasible.length, infeasible: withGold.length - feasible.length, strict_hits: feasible.filter(r => hitsAll(r.retrieved, gold(r), k)).length };
};
const goldHistogram: Record<string, number> = {};
for (const r of withGold) { const key = r.gold_count > 10 ? '>10' : r.gold_count > 5 ? '6-10' : String(r.gold_count); goldHistogram[key] = (goldHistogram[key] ?? 0) + 1; }
const feasibility = {
  answerable_questions: all.filter(r => !r.abstention).length,
  answerable_with_gold: withGold.length,
  answerable_without_gold: all.filter(r => !r.abstention && r.gold_count === 0).map(r => r.id),
  gold_turn_groups: { histogram: goldHistogram, max: Math.max(...withGold.map(r => r.gold_count)), median: [...withGold.map(r => r.gold_count)].sort((a, b) => a - b)[Math.floor(withGold.length / 2)] },
  strict_at_5: byGoldCount(5), strict_at_10: byGoldCount(10),
  strict_at_5_by_gold_count: Object.fromEntries([1, 2, 3, 4, 5].map(n => { const xs = withGold.filter(r => r.gold_count === n); return [n, { n: xs.length, at_5: xs.filter(r => hitsAll(r.retrieved, gold(r), 5)).length, at_10: xs.filter(r => hitsAll(r.retrieved, gold(r), 10)).length }]; })),
  answers_on_infeasible_at_5: strict(withGold.filter(r => r.gold_count > 5)),
  answers_on_feasible_at_5: strict(withGold.filter(r => r.gold_count <= 5)),
};

// 2. Batch granularity. A BEAM batch is one dated block of about 100k tokens (10 per 1M conversation); its turn groups
// are BEAM's own `turn_chunk` retrieval unit, which gbrain-evals imports as sessions.
const batchOf = (s: string) => s.split('-')[0];
const goldBatches = (r: Row) => [...new Set(gold(r).map(batchOf))];
const distinctBatches = (list: string[]) => [...new Set(list.map(batchOf))];
const batchHist: Record<string, number> = {};
for (const r of withGold) { const n = goldBatches(r).length; batchHist[n] = (batchHist[n] ?? 0) + 1; }
const batches = {
  batches_per_conversation: Object.fromEntries(corpus.conversations.map(c => [c.id, new Set(c.sessions.map(s => batchOf(s.id))).size])),
  turn_groups_per_conversation: Object.fromEntries(corpus.conversations.map(c => [c.id, c.sessions.length])),
  gold_batches_histogram: batchHist,
  top5_turn_groups_cover_every_gold_batch: withGold.filter(r => goldBatches(r).every(b => r.retrieved.slice(0, 5).map(batchOf).includes(b))).length,
  top5_turn_groups_touch_any_gold_batch: withGold.filter(r => goldBatches(r).some(b => r.retrieved.slice(0, 5).map(batchOf).includes(b))).length,
  top10_turn_groups_cover_every_gold_batch: withGold.filter(r => goldBatches(r).every(b => r.retrieved.slice(0, 10).map(batchOf).includes(b))).length,
  top5_distinct_batches_cover_every_gold_batch: withGold.filter(r => goldBatches(r).every(b => distinctBatches(r.retrieved).slice(0, 5).includes(b))).length,
  feasible_at_5_by_batch: withGold.filter(r => goldBatches(r).length <= 5).length,
  denominator: withGold.length,
};

// 3. none@5 classification over the turn-group text.
const STOP = new Set('the and for with that this from what which when where who whom whose how did does was were are have has had you your yours mine about into over after before during between since until than then them they their there these those been being also just only mention items item order list many much some any all each other more most such very can could would should will shall may might must not but our out its it is be do to of in on at by as or an a my me we us i his her him she he say said tell told give gave get got make made use used one two three four five six seven eight nine ten first second third'.split(' '));
const terms = (text: string) => new Set(text.toLowerCase().replace(/mention only and only[^.?]*[.?]?/g, ' ').split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOP.has(t)).map(t => t.replace(/(ies)$/, 'y').replace(/(?<!s)s$/, '')));
const textOf = (conv: string, ids: string[]) => ids.map(id => sessions.get(`${conv}/${id}`) as Session).map(s => s.turns.map(t => t.content).join(' ')).join(' ');
const coverage = (q: Set<string>, text: string) => { const t = terms(text); return q.size ? [...q].filter(x => t.has(x)).length / q.size : 0; };
const DATE_SCOPED = /\b(?:jan(?:uary)?|feb(?:ruary)?|march|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b20\d\d\b|\b(?:before|after|since|until|during|between|ago|earlier|later|first|last|latest|recent(?:ly)?|current(?:ly)?|now|initially|originally|previously|yesterday|week|month|year)\b/i;
const noneRows = withGold.filter(r => bucket(r) === 'none@5');
const classified = noneRows.map(r => {
  const q = questions.get(r.id)!;
  const qt = terms(q.question);
  const goldCov = coverage(qt, textOf(r.conversation, gold(r)));
  const topCov = coverage(qt, textOf(r.conversation, r.retrieved.slice(0, 5)));
  const h = hash.get(r.id);
  const dateScoped = DATE_SCOPED.test(q.question);
  const label = goldCov < 0.5 ? 'lexical_gap' : dateScoped ? 'date_scoped' : 'semantic_drift';
  return { id: r.id, category: r.category, gold_count: r.gold_count, question_terms: qt.size, gold_term_coverage: round(goldCov, 3), top5_term_coverage: round(topCov, 3), date_scoped: dateScoped,
    hash_any_at_5: h ? hitsAny(h.retrieved, gold(r), 5) : null, label };
});
const countBy = <T>(xs: T[], key: (x: T) => string) => xs.reduce((m, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {} as Record<string, number>);
const none_at_5 = {
  n: noneRows.length,
  rule: 'lexical_gap when under half of the question\'s content words appear anywhere in its gold turn groups; else date_scoped when the question names a date or a time relation; else semantic_drift (the words are in the gold text but other turn groups outranked it)',
  by_label: countBy(classified, c => c.label),
  by_label_and_category: countBy(classified, c => `${c.label} / ${c.category}`),
  date_scoped_any_label: classified.filter(c => c.date_scoped).length,
  distractors_lexically_closer: classified.filter(c => c.top5_term_coverage >= c.gold_term_coverage).length,
  hash_arm_finds_some_gold_at_5: classified.filter(c => c.hash_any_at_5).length,
  hash_arm_finds_some_gold_by_label: countBy(classified.filter(c => c.hash_any_at_5), c => c.label),
  answers: strict(noneRows),
  questions: classified,
};

// 4. Committed-wrong tagging regardless of hedge wording: hand labels on every zero-score answer, and how a
// deterministic decline detector agrees with them.
const zero = all.filter(r => score(r) === 0);
const detector = (r: Row) => (DECLINE.test((r.qa_answer ?? '').slice(-700)) ? 'declined' : 'committed');
const labelled = zero.map(r => ({ id: r.id, abstention: r.abstention, label: labels[r.id], detector: detector(r), truncated: (r.qa_answer ?? '').length >= 2000 }));
if (labelled.some(l => !l.label)) throw new Error(`zero-score rows without a label: ${labelled.filter(l => !l.label).map(l => l.id).join(', ')}`);
const committedWrong = {
  zero_score_answers: zero.length,
  labels: countBy(labelled, l => `${l.abstention ? 'abstention' : 'answerable'} / ${l.label}`),
  committed_wrong: { all: labelled.filter(l => l.label === 'committed').length, answerable: labelled.filter(l => l.label === 'committed' && !l.abstention).length, abstention: labelled.filter(l => l.label === 'committed' && l.abstention).length, of: all.length },
  committed_wrong_upper_bound_with_undetermined: labelled.filter(l => l.label !== 'declined').length,
  false_abstention_on_answerable: labelled.filter(l => l.label === 'declined' && !l.abstention).length,
  partial_credit_answers: all.filter(r => score(r) > 0 && score(r) < 1).length,
  stored_answers_cut_at_2000_chars: all.filter(r => (r.qa_answer ?? '').length >= 2000).length,
  detector_agreement_on_decided_labels: (() => { const d = labelled.filter(l => l.label !== 'undetermined'); return { agree: d.filter(l => l.label === l.detector).length, of: d.length }; })(),
};

// 5. Category x bucket.
const cats = [...new Set(all.map(r => r.category))].sort();
const categoryBucket = Object.fromEntries(cats.map(c => {
  const xs = all.filter(r => r.category === c);
  const med = [...xs.map(r => r.gold_count)].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return [c, { n: xs.length, median_gold: med, answers: strict(xs), ...Object.fromEntries(['all@5', 'some@5', 'none@5', 'no_gold', 'abstention'].map(b => [b, strict(xs.filter(r => bucket(r) === b))]).filter(([, v]) => (v as { n: number }).n > 0)) }];
}));
const overallBucket = Object.fromEntries(['all@5', 'some@5', 'none@5', 'no_gold', 'abstention'].map(b => [b, strict(all.filter(r => bucket(r) === b))]));

const hashRows = [...hash.values()].filter(r => !r.abstention && r.gold_count > 0);
const out = {
  note: 'BEAM-1M dev (11 conversations, 220 questions), committed 2026-10-06 bridge rows at gbrain 6622a119e: hybridSearch, balanced, reranker off, openai:text-embedding-3-large 1536, top 10; reader and judge openai:gpt-4.1-mini, top 5 turn groups. Free recount; no model call.',
  answers_overall: { ...strict(all), answerable: strict(all.filter(r => !r.abstention)), abstention: strict(all.filter(r => r.abstention)) },
  feasibility, batches, none_at_5, committed_wrong: committedWrong, category_bucket: categoryBucket, overall_bucket: overallBucket,
  hash_arm: { build: '6622a119e', retrieval: 'hybridSearch with hash bag-of-words vectors (keyword arm plus a lexical vector arm; no provider)', strict_at_5: hashRows.filter(r => hitsAll(r.retrieved, gold(r), 5)).length,
    any_at_5: hashRows.filter(r => hitsAny(r.retrieved, gold(r), 5)).length, strict_at_10: hashRows.filter(r => hitsAll(r.retrieved, gold(r), 10)).length, of: hashRows.length,
    real_embedding_any_at_5: withGold.filter(r => hitsAny(r.retrieved, gold(r), 5)).length },
};
const text = JSON.stringify(out, null, 2) + '\n';
const path = join(here, 'decomposition.json');
if (process.argv.includes('--check')) {
  const ok = existsSync(path) && readFileSync(path, 'utf8') === text;
  console.log(ok ? 'decomposition.json matches the committed rows' : 'decomposition.json differs from the committed rows');
  process.exit(ok ? 0 : 1);
}
writeFileSync(path, text);
const f = feasibility;
console.log(`feasible strict@5 ${f.strict_at_5.strict_hits}/${f.strict_at_5.feasible}, strict@10 ${f.strict_at_10.strict_hits}/${f.strict_at_10.feasible}; none@5 ${noneRows.length}: ${JSON.stringify(none_at_5.by_label)}; committed-wrong ${committedWrong.committed_wrong.all}/220`);
