/**
 * Hub-heavy world (R1): do ranking changes that depend on entity degree help
 * or hurt when a few entities have thousands of inbound links?
 *
 * Corpus: a directory written by eval/generators/hub-world-gen.ts (world-v1
 * plus routine notes giving a heavy-tailed inbound degree and hubs with
 * 5,000-30,000 inbound links). Probes (`_hub_probes.json`, generator gold):
 *   hub-answer  the gold page IS a hub ("Which organization runs the X program?");
 *   bridge      the gold entity is reached through a note that links a hub and
 *               states a fact found nowhere else.
 * Also runs the relational-ab templates on the same index as a one-hop guard.
 *
 * Arms come from the shared-index harness (relational-ab's core): one
 * extracted index per ingestion seed, relational retrieval off and on over it,
 * search pins from RELATIONAL_PINS plus GBRAIN_EVAL_SEARCH_PINS (for example
 * `search.hub_dampening=...`), checked by config readback. A decision compares
 * a baseline run and a feature run row by row.
 *
 * Rows (data.rows, one per probe, seed and relational arm): ndcg_at_5,
 * recall_at_5 (gold), support_at_5 (bridge notes), hit_at_1.
 *
 * Usage: bun eval/runner/hub-world.ts --corpus-dir <dir> [--gbrain <checkout>@<sha>] [--seeds 1]
 *          [--embed keyword|stub|openai] [--limit-probes N] [--output <dir>] [--paid --budget-run-id <id>]
 */
import './budget-ledger.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';
import { gbrainSpecFrom, overlaySummary, productIdentityFor, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { loadRelationalProduct, runSharedIndexPairs, RELATIONAL_PINS, evalSearchPins, type EmbedMode, type PairedRow, type SharedIndexQuery } from './relational-ab.ts';
import { buildRelationalQueries, loadWorldCorpus } from './queries/relational.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { ndcgAtK, uniqueInOrder } from './metrics.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, receiptPath, sourceTreeIdentity, writeReceipt, noModelSpend, type Receipt } from './receipt.ts';
import { gbrainPin } from './gbrain-version.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import type { HubProbe } from '../generators/hub-world-gen.ts';

export const CATEGORY = 'hub-world';
const K = 5;

export interface HubRow { id: string; seed: number; kind: string; hub: string; arm: 'off' | 'on'; ndcg_at_5: number | null; recall_at_5: number | null; support_at_5: number | null; hit_at_1: number | null; error?: string | null; error_origin?: string }

export function scoreHubRow(pages: string[], gold: string[], support: string[]): Pick<HubRow, 'ndcg_at_5' | 'recall_at_5' | 'support_at_5' | 'hit_at_1'> {
  const top = uniqueInOrder(pages).slice(0, K);
  const g = new Set(gold);
  return {
    ndcg_at_5: ndcgAtK(top, new Map(gold.map(x => [x, 1])), K),
    recall_at_5: gold.length ? gold.filter(x => top.includes(x)).length / gold.length : null,
    support_at_5: support.length ? support.filter(x => top.includes(x)).length / support.length : null,
    hit_at_1: top.length ? (g.has(top[0]) ? 1 : 0) : 0,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const corpusDir = resolve(val('--corpus-dir') ?? '');
  if (!existsSync(join(corpusDir, '_hub_probes.json'))) throw new Error('--corpus-dir must point at a hub-world-gen output directory');
  const embed = (val('--embed') ?? 'keyword') as EmbedMode;
  const seeds = (val('--seeds') ?? '1').split(',').map(Number);
  const output = val('--output');
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const product = await loadRelationalProduct(gut);
  const pages = loadWorldCorpus(corpusDir);
  const probes = JSON.parse(readFileSync(join(corpusDir, '_hub_probes.json'), 'utf8')) as HubProbe[];
  const limitProbes = val('--limit-probes') ? Number(val('--limit-probes')) : null;
  const hubQueries: SharedIndexQuery[] = (limitProbes ? probes.slice(0, limitProbes) : probes).map(p => ({
    id: p.id, tier: 'medium', text: p.text, expected_output_type: 'cited-source-pages', gold: { relevant: p.gold }, split: p.kind, template: p.hub,
  } as unknown as SharedIndexQuery));
  const relational = buildRelationalQueries(pages).map(q => ({ ...q, split: 'one-hop', template: 'relational' } as SharedIndexQuery));
  const queries = [...hubQueries, ...relational];
  const paid = embed === 'openai' ? startPaidRun(CATEGORY, { ...budgetOptionsFrom(argv), estimateUsd: 1 }) : null;
  const accounting = new ProbeAccounting(queries.length * seeds.length * 2);
  const started = new Date().toISOString();
  let run: { rows: PairedRow[]; indices: Array<Record<string, unknown>> } = { rows: [], indices: [] };
  let harnessError: string | null = null;
  try {
    const go = () => runSharedIndexPairs({ product, pages, queries, seeds, embed, limit: K, accounting, log: s => process.stderr.write(s + '\n') });
    run = embed === 'openai' ? await go() : await withHermeticEnv(CATEGORY, go);
  } catch (e) { harnessError = (e as Error).message; }
  const byId = new Map(probes.map(p => [p.id, p]));
  const rows: HubRow[] = [];
  for (const r of run.rows) for (const arm of ['off', 'on'] as const) {
    const a = r[arm];
    const p = byId.get(r.query_id);
    const gold = p ? p.gold : r.relevant;
    const support = p ? p.support : [];
    rows.push({ id: `${r.query_id}|${r.seed}|${arm}`, seed: r.seed, kind: r.split, hub: r.template, arm,
      ...(a.error ? { ndcg_at_5: null, recall_at_5: null, support_at_5: null, hit_at_1: null, error: a.error.message, error_origin: a.error.origin } : scoreHubRow(a.pages, gold, support)) });
  }
  const mean = (kind: string, arm: string, k: keyof HubRow) => { const xs = rows.filter(r => r.kind === kind && r.arm === arm && typeof r[k] === 'number').map(r => r[k] as number); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const summary = Object.fromEntries(['hub-answer', 'bridge', 'one-hop'].flatMap(kind => ['off', 'on'].map(arm => [`${kind}:${arm}`, { ndcg_at_5: mean(kind, arm, 'ndcg_at_5'), recall_at_5: mean(kind, arm, 'recall_at_5'), hit_at_1: mean(kind, arm, 'hit_at_1'), support_at_5: mean(kind, arm, 'support_at_5') }])));
  const world = existsSync(join(corpusDir, '_hub_world.json')) ? JSON.parse(readFileSync(join(corpusDir, '_hub_world.json'), 'utf8')) : null;
  let cost: unknown = null;
  if (paid) { cost = receiptCost(paid.run.close()); paid.guard.uninstall(); }
  const acc = accounting.summary();
  const receipt = {
    ...(paid ? {} : noModelSpend('keyword or hash embeddings only')), ...(cost ? { cost } : {}),
    schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: CATEGORY,
    run_status: harnessError || acc.errors.some(e => e.origin !== 'sut') ? 'error' : 'completed', ...(harnessError ? {} : { verdict: 'pass' as const }),
    n_total: acc.n_total, n_scored: acc.n_scored, completion_rate: acc.completion_rate, errors: acc.errors, publishable: !harnessError && world?.salted === false,
    gbrain_version: gut.version, gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: { embed, seeds, k: K, common_search_pins: { ...RELATIONAL_PINS, ...evalSearchPins() }, world: world ? { version: world.version, seed: world.seed, salted: world.salted, scale: world.scale, pages: world.pages, links: world.links, hubs: world.hubs, inbound_quantiles: world.inbound_quantiles } : null, gbrain_overlay: overlaySummary(gut) },
    started_at: started, finished_at: new Date().toISOString(),
    data: { summary, rows, indices: run.indices, harness_error: harnessError },
  } as unknown as Receipt;
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  writeReceipt(outPath, receipt);
  for (const [k, v] of Object.entries(summary)) process.stderr.write(`${k}: ${JSON.stringify(v)}\n`);
  process.stderr.write(`receipt: ${outPath}\n`);
  process.exit(harnessError ? 3 : 0);
}

if (import.meta.main) await main();
