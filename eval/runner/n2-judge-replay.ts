/**
 * W9 of the 2026-10 follow-up round: a judge-only replay of N2's prompt v4
 * contradiction judge on current models.
 *
 *   capture  ($0, hermetic) seeds the N2 world at a seed through gbrain's
 *            `put_page`, runs `runContradictionProbe` (keyword-only hybrid
 *            search, top five, cache off, four concurrent probe runs, as the
 *            2026-10-03 receipt) with a recording judge that stores every
 *            offered pair's exact judge input and answers with the oracle
 *            verdict. Run at gbrain 48ed5e8 (the receipt's build).
 *   verify   checks a capture against the paid receipt: every (query item,
 *            page, page) triple and the ledger fingerprint must match.
 *   select   builds the replay set: all same-item planted pairs, a seeded
 *            sample of the other judgments, and a fresh split of compatible
 *            negatives from captures at other seeds.
 *   judge    replays the selected inputs through gbrain's `judgeContradiction`
 *            (prompt v4, gbrain at the pin) with one model, under the ledger's
 *            paid-request guard; a reply cut at the output limit is a judge
 *            error.
 *   score    keyless: per model N2's rules with exact Clopper-Pearson bounds,
 *            paired exact McNemar against Haiku's receipt verdicts, weighted
 *            false alerts, cost per 1,000 judged pairs.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { JUDGE_MODEL, oracleVerdict } from './n2-contradiction-surfacing.ts';
import { attestPreregistration } from './prereg.ts';
import { clopperPearson } from './stats/exact.ts';
import { exactMcNemar, holmAdjusted, seededRandom, type PairedItem } from './stats/paired.ts';
import { N2_GENERATOR_VERSION, generateN2World, n2Gold, pairKey, renderN2Page } from '../generators/n2-contradiction-gen.ts';

const TOP_K = 5;
const SHARDS = 4;
const PROBE_BUDGET_USD = 6;
export const SAMPLE_SEED = 20261006;
export const SAMPLE_SIZE = 300;
export const FRESH_SEEDS = [20261011, 20261012, 20261013, 20261014, 20261015, 20261016];
export const FRESH_SIZE = 200;
export const LIMIT = 0.10;

export interface Side { slug: string; text: string; effective_date?: string | null }
export interface CapturedPair {
  query: string;
  item: string | null;
  a: Side;
  b: Side;
  key: string;
  gold_class: 'contradiction' | 'temporal' | 'compatible' | 'unplanted';
  gold_item: string | null;
}
export interface Capture { seed: number; generator_version: string; world_fingerprint: string; gbrain: unknown; prompt_version: string; offered: number; pairs: CapturedPair[] }

const arg = (argv: readonly string[], flag: string) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};

/** Class of a judgment: a planted pair judged under its own item's query keeps its gold class; everything else is `unplanted` (as the receipt labels it). */
export function judgmentClass(gold: { planted: boolean; gold_class?: string; item?: string }, queryItem: string | null): CapturedPair['gold_class'] {
  return gold.planted && gold.item === queryItem ? gold.gold_class as CapturedPair['gold_class'] : 'unplanted';
}

async function capture(argv: readonly string[]): Promise<Capture> {
  const seed = Number(arg(argv, '--seed') ?? 20261001);
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const { ledger, fingerprint } = generateN2World({ seed });
  const gold = n2Gold(ledger);
  const itemById = new Map(ledger.items.map(i => [i.id, i]));
  return withHermeticEnv('n2-judge-replay', async () => {
    const gw = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; isAvailable: (t: string) => boolean }>(gut, 'src/core/ai/gateway.ts');
    gw.configureGateway({ chat_model: JUDGE_MODEL, expansion_model: JUDGE_MODEL, env: {} });
    if (gw.isAvailable('embedding')) throw new Error('an embedding provider is available, so retrieval would not be keyword-only');
    const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => any }>(gut, 'src/core/pglite-engine.ts');
    const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (c: unknown, p: Record<string, unknown>) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
    const { runContradictionProbe } = await importGbrain<{ runContradictionProbe: (o: Record<string, unknown>) => Promise<any> }>(gut, 'src/core/eval-contradictions/runner.ts');
    const { PROMPT_VERSION } = await importGbrain<{ PROMPT_VERSION: string }>(gut, 'src/core/eval-contradictions/types.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      const putPage = operations.find(o => o.name === 'put_page')!;
      const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, sourceId: 'default' };
      for (const p of ledger.pages) await putPage.handler(ctx, { slug: p.slug, content: renderN2Page(p) });
      const pairs: CapturedPair[] = [];
      const qs = ledger.items.map(i => ({ query: i.query, item: i.id }));
      const itemOf = new Map(qs.map(q => [q.query, q.item]));
      const shards = Array.from({ length: SHARDS }, (_, k) => qs.filter((_q, i) => i % SHARDS === k));
      await Promise.all(shards.map(shard => runContradictionProbe({
        engine, queries: shard.map(q => q.query), topK: TOP_K, noCache: true, yesOverride: true, budgetUsd: PROBE_BUDGET_USD, judgeModel: JUDGE_MODEL,
        judgeFn: async (input: { query: string; a: Side; b: Side }) => {
          const g = gold(input.a, input.b) as { planted: boolean; gold_class?: string; item?: string };
          const item = itemOf.get(input.query) ?? null;
          pairs.push({ query: input.query, item, a: { slug: input.a.slug, text: input.a.text, effective_date: input.a.effective_date ?? null }, b: { slug: input.b.slug, text: input.b.text, effective_date: input.b.effective_date ?? null },
            key: pairKey(input.a.slug, input.b.slug), gold_class: judgmentClass(g, item), gold_item: g.planted ? g.item ?? null : null });
          const verdict = oracleVerdict(g as never, g.planted && g.item ? itemById.get(g.item) as never : undefined);
          return { verdict: { verdict, severity: 'info', axis: '', confidence: 1, resolution_kind: null }, usage: { inputTokens: 0, outputTokens: 0 } };
        },
      })));
      pairs.sort((x, y) => `${x.item}\u0000${x.key}`.localeCompare(`${y.item}\u0000${y.key}`));
      return { seed, generator_version: N2_GENERATOR_VERSION, world_fingerprint: fingerprint, gbrain: overlaySummary(gut), prompt_version: PROMPT_VERSION, offered: pairs.length, pairs };
    } finally {
      await engine.disconnect().catch(() => {});
    }
  });
}

export interface ReceiptJudgment { q: string; a: string; b: string; gold: string; verdict: string | null; error: string | null }

/** Every captured (item, a, b) triple and the ledger fingerprint must equal the receipt's. Pages are compared as an unordered pair. */
export function verifyCapture(cap: Pick<Capture, 'world_fingerprint' | 'pairs'>, receipt: { ledgerSha: string; judgments: ReceiptJudgment[] }) {
  const triple = (q: string | null, a: string, b: string) => `${q}\u0000${pairKey(a, b)}`;
  const mine = cap.pairs.map(p => triple(p.item, p.a.slug, p.b.slug)).sort();
  const theirs = receipt.judgments.map(j => triple(j.q, j.a, j.b)).sort();
  const theirSet = new Set(theirs), mySet = new Set(mine);
  const missing = theirs.filter(t => !mySet.has(t));
  const extra = mine.filter(t => !theirSet.has(t));
  const classMismatch = cap.pairs.filter(p => {
    const r = receipt.judgments.find(j => j.q === p.item && pairKey(j.a, j.b) === p.key);
    const rc = r ? (r.gold.includes(':') ? r.gold.split(':')[1] : r.gold) : null;
    return rc !== null && rc !== p.gold_class;
  }).length;
  return { captured: mine.length, receipt: theirs.length, missing: missing.length, extra: extra.length, gold_class_mismatches: classMismatch,
    ledger_sha_matches: cap.world_fingerprint === receipt.ledgerSha,
    ok: mine.length === theirs.length && missing.length === 0 && extra.length === 0 && classMismatch === 0 && cap.world_fingerprint === receipt.ledgerSha };
}

export interface SelectedPair extends CapturedPair { split: 'planted' | 'sample' | 'fresh'; seed: number; id: string }

/** Seeded draw of `n` without replacement (Fisher-Yates on a copy). */
export function seededSample<T>(xs: readonly T[], n: number, seed: number): T[] {
  const a = [...xs];
  const rand = seededRandom(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a.slice(0, n);
}

export function selectPairs(main: Capture, fresh: Capture[]): SelectedPair[] {
  const id = (seed: number, p: CapturedPair) => `${seed}:${p.item}:${p.key}`;
  const planted = main.pairs.filter(p => p.gold_class !== 'unplanted').map(p => ({ ...p, split: 'planted' as const, seed: main.seed, id: id(main.seed, p) }));
  const others = main.pairs.filter(p => p.gold_class === 'unplanted');
  const sample = seededSample(others, SAMPLE_SIZE, SAMPLE_SEED).map(p => ({ ...p, split: 'sample' as const, seed: main.seed, id: id(main.seed, p) }));
  const freshPool = fresh.flatMap(c => c.pairs.filter(p => p.gold_class === 'compatible').map(p => ({ ...p, split: 'fresh' as const, seed: c.seed, id: id(c.seed, p) })));
  if (freshPool.length < FRESH_SIZE) throw new Error(`fresh compatible pool has ${freshPool.length} pairs, need ${FRESH_SIZE}; capture more seeds`);
  return [...planted, ...sample, ...freshPool.slice(0, FRESH_SIZE)];
}

export interface Judged { id: string; verdict: string | null; error: string | null; input_tokens: number; output_tokens: number; ms: number }

async function judge(argv: readonly string[]) {
  const model = arg(argv, '--model');
  const selected = JSON.parse(readFileSync(arg(argv, '--selection')!, 'utf8')) as { pairs: SelectedPair[] };
  const prereg = arg(argv, '--preregistration');
  if (!model || !prereg) throw new Error('judge needs --model <provider:model> --selection <file> --preregistration <file> --output <file>');
  const attestation = attestPreregistration(prereg);
  const concurrency = Number(arg(argv, '--concurrency') ?? 6);
  const { run, guard } = startPaidRun(`n2-judge-replay-${model.replace(/[^a-z0-9.-]+/gi, '-')}`, { ...budgetOptionsFrom(argv), estimateUsd: Number(arg(argv, '--estimate-usd') ?? 5) });
  const { configureGateway, chat } = await import('../../node_modules/gbrain/src/core/ai/gateway.ts');
  const { judgeContradiction } = await import('../../node_modules/gbrain/src/core/eval-contradictions/judge.ts');
  const { PROMPT_VERSION } = await import('../../node_modules/gbrain/src/core/eval-contradictions/types.ts');
  configureGateway({ chat_model: model, env: process.env as Record<string, string | undefined> });
  const truncatingChat: typeof chat = async (opts) => {
    const res = await chat(opts);
    if (res.stopReason === 'length') throw new Error(`truncated at the ${opts.maxTokens}-token output limit`);
    return res;
  };
  const results: Judged[] = [];
  const queue = [...selected.pairs];
  const started = Date.now();
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const t = Date.now();
        if (guard.exhausted) { results.push({ id: p.id, verdict: null, error: 'budget exhausted: not judged', input_tokens: 0, output_tokens: 0, ms: 0 }); continue; }
        try {
          const o = await judgeContradiction({ query: p.query, a: p.a, b: p.b, model, chatFn: truncatingChat } as never) as { verdict: { verdict: string }; usage: { inputTokens: number; outputTokens: number } };
          results.push({ id: p.id, verdict: o.verdict.verdict, error: null, input_tokens: o.usage.inputTokens, output_tokens: o.usage.outputTokens, ms: Date.now() - t });
        } catch (e) {
          results.push({ id: p.id, verdict: null, error: String((e as Error).message ?? e).slice(0, 300), input_tokens: 0, output_tokens: 0, ms: Date.now() - t });
        }
        if (results.length % 50 === 0) process.stderr.write(`[w9] ${model}: ${results.length}/${selected.pairs.length}\n`);
      }
    }));
  } finally {
    guard.uninstall();
  }
  const cost = receiptCost(run.close());
  results.sort((x, y) => x.id.localeCompare(y.id));
  return { kind: 'n2-judge-replay', model, prompt_version: PROMPT_VERSION, gbrain: 'node_modules/gbrain (the round pin)', preregistration_attestation: attestation, concurrency,
    wall_ms: Date.now() - started, judged: results.length, errors: results.filter(r => r.error).length, cost, results };
}

const isContradiction = (v: string | null) => v === 'contradiction';

export interface ModelScore {
  model: string;
  recall_conflicts: { hits: number; n: number; lower95: number };
  false_dated: { hits: number; n: number; upper95: number };
  false_compatible_original: { hits: number; n: number; upper95: number };
  false_compatible_pooled: { hits: number; n: number; upper95: number } | null;
  judge_errors: number;
  truncations: number;
  sample_false_alerts: { hits: number; n: number };
  false_alerts_per_1000_candidates: number | null;
  passes: boolean;
  failed_rules: string[];
}

/** N2's rules: recall on offered conflicts >= 0.80 and false contradictions on dated changes <= 0.10 (point rules), plus the decisive compatible-negative rule on its exact upper bound. Judge errors count against the model (a miss on conflicts, an alert-free non-answer elsewhere is still an error). */
export function scoreModel(model: string, pairs: SelectedPair[], verdicts: Map<string, { verdict: string | null; error: string | null }>, opts: { offeredTotal: number; othersTotal: number; pooled: boolean }): ModelScore {
  const by = (split: SelectedPair['split'], cls?: CapturedPair['gold_class']) => pairs.filter(p => p.split === split && (!cls || p.gold_class === cls));
  const v = (p: SelectedPair) => verdicts.get(p.id);
  const flagged = (ps: SelectedPair[]) => ps.filter(p => isContradiction(v(p)?.verdict ?? null)).length;
  const conflicts = by('planted', 'contradiction'), dated = by('planted', 'temporal'), compat = by('planted', 'compatible'), fresh = by('fresh'), sample = by('sample');
  const judgedAll = pairs.filter(p => v(p));
  const errors = judgedAll.filter(p => v(p)!.error).length;
  const truncations = judgedAll.filter(p => /^truncated/.test(v(p)!.error ?? '')).length;
  const rc = flagged(conflicts), fd = flagged(dated), fc = flagged(compat), ff = flagged(fresh), fs = flagged(sample);
  const pooledN = compat.length + fresh.length;
  const pooled = opts.pooled ? { hits: fc + ff, n: pooledN, upper95: clopperPearson(fc + ff, pooledN).upper } : null;
  const decisive = pooled ?? { hits: fc, n: compat.length, upper95: clopperPearson(fc, compat.length).upper };
  const failed: string[] = [];
  if (!(rc / conflicts.length >= 0.8)) failed.push('classification recall on offered conflicts < 0.80');
  if (!(fd / dated.length <= LIMIT)) failed.push('false-contradiction rate on offered dated changes > 0.10');
  if (!(decisive.upper95 < LIMIT)) failed.push(`compatible-negative false-contradiction upper 95% bound ${decisive.upper95.toFixed(3)} not under 0.10`);
  const plantedFalse = fd + fc;
  const alertsPer1000 = sample.length ? ((fs / sample.length) * opts.othersTotal + plantedFalse) / opts.offeredTotal * 1000 : null;
  return {
    model,
    recall_conflicts: { hits: rc, n: conflicts.length, lower95: clopperPearson(rc, conflicts.length).lower },
    false_dated: { hits: fd, n: dated.length, upper95: clopperPearson(fd, dated.length).upper },
    false_compatible_original: { hits: fc, n: compat.length, upper95: clopperPearson(fc, compat.length).upper },
    false_compatible_pooled: pooled,
    judge_errors: errors, truncations,
    sample_false_alerts: { hits: fs, n: sample.length },
    false_alerts_per_1000_candidates: alertsPer1000,
    passes: failed.length === 0,
    failed_rules: failed,
  };
}

/** Paired exact McNemar on correctness (contradiction iff gold contradiction) against a reference model, over pairs both judged. */
export function pairedVsReference(pairs: SelectedPair[], model: Map<string, { verdict: string | null }>, reference: Map<string, { verdict: string | null }>) {
  const correct = (p: SelectedPair, v: string | null) => (isContradiction(v) === (p.gold_class === 'contradiction') ? 1 : 0);
  const items: PairedItem[] = pairs.filter(p => model.has(p.id) && reference.has(p.id)).map(p => ({ id: p.id, cluster: p.id, a: correct(p, reference.get(p.id)!.verdict), b: correct(p, model.get(p.id)!.verdict) }));
  return exactMcNemar(items);
}

function score(argv: readonly string[]) {
  const selection = JSON.parse(readFileSync(arg(argv, '--selection')!, 'utf8')) as { pairs: SelectedPair[]; offered_total: number; others_total: number };
  const receipt = JSON.parse(readFileSync(arg(argv, '--receipt')!, 'utf8')) as { data: { paid: { judgments: ReceiptJudgment[] } } };
  const runs = argv.filter(a => a.endsWith('.json') && a !== arg(argv, '--selection') && a !== arg(argv, '--receipt') && a !== arg(argv, '--output'));
  const haiku = new Map(receipt.data.paid.judgments.map(j => [`${selection.pairs[0]!.seed}:${j.q}:${pairKey(j.a, j.b)}`, { verdict: j.verdict, error: j.error }]));
  const original = selection.pairs.filter(p => p.split !== 'fresh');
  const opts = { offeredTotal: selection.offered_total, othersTotal: selection.others_total };
  const models = runs.map(f => JSON.parse(readFileSync(f, 'utf8')) as { model: string; results: Judged[]; cost: { usd: number }; wall_ms: number });
  const rows = models.map(m => {
    const vm = new Map(m.results.map(r => [r.id, r]));
    const s = scoreModel(m.model, selection.pairs, vm, { ...opts, pooled: true });
    return { ...s, cost_usd: m.cost.usd, cost_per_1000_judged_pairs: m.cost.usd / m.results.length * 1000, wall_ms: m.wall_ms,
      vs_haiku: pairedVsReference(original, vm, haiku) };
  });
  const holm = holmAdjusted(rows.map(r => r.vs_haiku.p_two_sided));
  rows.forEach((r, i) => Object.assign(r.vs_haiku, { p_holm: holm[i] }));
  const haikuRow = { ...scoreModel('anthropic:claude-haiku-4-5 (2026-10-03 receipt)', original, haiku, { ...opts, pooled: false }),
    full_population_unplanted_alerts: receipt.data.paid.judgments.filter(j => !j.gold.includes(':') && j.verdict === 'contradiction').length };
  const alertedUnplanted = [...new Set([...models.flatMap(m => m.results.filter(r => r.verdict === 'contradiction').map(r => r.id)), ...[...haiku].filter(([, v]) => v.verdict === 'contradiction').map(([k]) => k)])]
    .filter(id => selection.pairs.find(p => p.id === id)?.split === 'sample').sort();
  return { kind: 'n2-judge-replay-score', models: rows, haiku: haikuRow, unplanted_alert_union_in_sample: alertedUnplanted };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const output = arg(rest, '--output');
  let result: unknown;
  if (cmd === 'capture') result = await capture(rest);
  else if (cmd === 'verify') {
    const cap = JSON.parse(readFileSync(arg(rest, '--capture')!, 'utf8')) as Capture;
    const receipt = JSON.parse(readFileSync(arg(rest, '--receipt')!, 'utf8')) as { hashes: { ledger_sha256: string }; data: { paid: { judgments: ReceiptJudgment[] } } };
    result = verifyCapture(cap, { ledgerSha: receipt.hashes.ledger_sha256, judgments: receipt.data.paid.judgments });
    if (!(result as { ok: boolean }).ok) process.exitCode = 1;
  } else if (cmd === 'select') {
    const main = JSON.parse(readFileSync(arg(rest, '--capture')!, 'utf8')) as Capture;
    const fresh = rest.filter(a => a.endsWith('.json') && a !== arg(rest, '--capture') && a !== output).map(f => JSON.parse(readFileSync(f, 'utf8')) as Capture);
    const pairs = selectPairs(main, fresh);
    result = { seed: main.seed, world_fingerprint: main.world_fingerprint, offered_total: main.pairs.length, others_total: main.pairs.filter(p => p.gold_class === 'unplanted').length,
      sample_seed: SAMPLE_SEED, fresh_seeds: fresh.map(c => c.seed), counts: { planted: pairs.filter(p => p.split === 'planted').length, sample: pairs.filter(p => p.split === 'sample').length, fresh: pairs.filter(p => p.split === 'fresh').length },
      sha256: createHash('sha256').update(JSON.stringify(pairs.map(p => [p.id, p.query, p.a, p.b]))).digest('hex'), pairs };
  } else if (cmd === 'judge') result = await judge(rest);
  else if (cmd === 'score') result = score(rest);
  else throw new Error('usage: n2-judge-replay.ts capture|verify|select|judge|score (see the header)');
  const text = JSON.stringify(result, null, 1) + '\n';
  if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, text); }
  else process.stdout.write(text);
}

if (import.meta.main) await main();
