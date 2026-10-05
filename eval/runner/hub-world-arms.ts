/**
 * Hub-heavy world, several read-time arms over ONE index (plan P2, E1 dev).
 *
 * `search.hub_dampening` and `search.graph_signals` are read at search time,
 * so their arms do not need separate ingests: this runner builds one shared
 * index per gbrain build (eval/runner/relational-ab.ts core) and, inside its
 * after-index hook, runs every arm in turn by writing the arm's config and
 * checking that each search reports it back in its telemetry. A rival that
 * changes code (boost removed, boosts capped) is a separate `--gbrain` build.
 *
 * Families, all on the same index and the same pins (RELATIONAL_PINS,
 * relational retrieval off):
 *   concept    Cat 13 conceptual probes on the hub world (graded nDCG@5: target 3, co-occurrence peer 1);
 *   hub-answer the gold page is a hub; bridge: the gold entity is reached through a note that links a hub
 *              (generator gold from `_hub_probes.json`);
 *   one-hop    relational one-hop templates (recall@5 against the template gold).
 * Rows (rows.ndjson): one per arm, family and probe, with ndcg_at_5, recall_at_5, hit_at_1 and latency_ms.
 *
 * Usage: bun eval/runner/hub-world-arms.ts --corpus-dir <dir> --gbrain <checkout>@<sha>
 *          --arms off,32,100,200,600,graph-off [--embed keyword|openai] [--concept-probes N] --output <dir>
 *          [--paid --budget-run-id <id>]
 */
import './budget-ledger.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';
import { gbrainSpecFrom, overlaySummary, productIdentityFor, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { loadRelationalProduct, runSharedIndexPairs, RELATIONAL_PINS, type EmbedMode } from './relational-ab.ts';
import { buildRelationalQueries, loadWorldCorpus } from './queries/relational.ts';
import { buildProbes, loadCorpus as loadCat13Corpus } from './cat13-conceptual.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { ndcgAtK, uniqueInOrder, percentile } from './metrics.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import type { HubProbe } from '../generators/hub-world-gen.ts';

const K = 5;

export interface ArmSpec { label: string; config: Record<string, string>; halfDegree: number | 'off' }

/** `off` | a half degree H | `graph-off` (graph signals disabled, no dampening). */
export function parseArms(raw: string): ArmSpec[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(label => {
    if (label === 'off') return { label, config: { 'search.hub_dampening': 'off', 'search.graph_signals': 'true' }, halfDegree: 'off' };
    if (label === 'graph-off') return { label, config: { 'search.hub_dampening': 'off', 'search.graph_signals': 'false' }, halfDegree: 'off' };
    const h = Number(label);
    if (!Number.isFinite(h) || h <= 0) throw new Error(`--arms: ${label} is not off, graph-off or a positive half degree`);
    return { label, config: { 'search.hub_dampening': String(h), 'search.graph_signals': 'true' }, halfDegree: h };
  });
}

interface Probe { id: string; family: 'concept' | 'hub-answer' | 'bridge' | 'one-hop'; text: string; grades: Map<string, number> }
export interface ArmRow { arm: string; family: string; id: string; ndcg_at_5: number | null; recall_at_5: number | null; hit_at_1: number | null; latency_ms: number | null; error?: string }

export function scoreTop(pages: string[], grades: Map<string, number>): Pick<ArmRow, 'ndcg_at_5' | 'recall_at_5' | 'hit_at_1'> {
  const top = uniqueInOrder(pages).slice(0, K);
  const relevant = [...grades.entries()].filter(([, g]) => g > 0).map(([s]) => s);
  const best = Math.max(0, ...grades.values());
  return {
    ndcg_at_5: ndcgAtK(top, grades, K),
    recall_at_5: relevant.length ? relevant.filter(s => top.includes(s)).length / relevant.length : null,
    hit_at_1: top.length ? (grades.get(top[0]) === best ? 1 : 0) : 0,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const corpusDir = resolve(val('--corpus-dir') ?? '');
  if (!existsSync(join(corpusDir, '_hub_probes.json'))) throw new Error('--corpus-dir must point at a hub-world-gen output directory');
  const output = val('--output');
  if (!output) throw new Error('--output <dir> is required');
  mkdirSync(output, { recursive: true });
  const embed = (val('--embed') ?? 'keyword') as EmbedMode;
  const arms = parseArms(val('--arms') ?? 'off');
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const product = await loadRelationalProduct(gut);
  const pages = loadWorldCorpus(corpusDir);

  const probes: Probe[] = [];
  const concept = buildProbes(loadCat13Corpus(corpusDir), Number(val('--concept-probes') ?? 400));
  for (const p of concept.probes) probes.push({ id: `concept:${p.q.id}`, family: 'concept', text: p.q.text, grades: concept.gradesByQuery.get(p.q.id) ?? new Map() });
  for (const p of JSON.parse(readFileSync(join(corpusDir, '_hub_probes.json'), 'utf8')) as HubProbe[]) {
    probes.push({ id: p.id, family: p.kind as Probe['family'], text: p.text, grades: new Map(p.gold.map(s => [s, 1])) });
  }
  for (const q of buildRelationalQueries(pages)) probes.push({ id: q.id, family: 'one-hop', text: q.text, grades: new Map((q.gold.relevant ?? []).map(s => [s, 1])) });

  const rowsPath = join(output, 'rows.ndjson');
  writeFileSync(rowsPath, '');
  const paid = embed === 'openai' ? startPaidRun('hub-world-arms', { ...budgetOptionsFrom(argv), estimateUsd: 3 }) : null;
  const accounting = new ProbeAccounting(probes.length * arms.length);
  const started = new Date().toISOString();
  const readbacks: Record<string, Record<string, string | null>> = {};
  let harnessError: string | null = null;
  const go = () => runSharedIndexPairs({
    product, pages, queries: [], seeds: [1], embed, limit: K, accounting, log: s => process.stderr.write(s + '\n'),
    afterIndex: async (engine, _seed, search) => {
      const vectors = new Map<string, Float32Array>();
      for (const arm of arms) {
        for (const [k, v] of Object.entries(arm.config)) await engine.setConfig(k, v);
        readbacks[arm.label] = Object.fromEntries(await Promise.all(Object.keys(arm.config).map(async k => [k, await engine.getConfig(k)] as const)));
        process.stderr.write(`[hub-world-arms] arm ${arm.label}: ${probes.length} probes\n`);
        for (const p of probes) {
          const row: ArmRow = { arm: arm.label, family: p.family, id: p.id, ndcg_at_5: null, recall_at_5: null, hit_at_1: null, latency_ms: null };
          try {
            let vector: Float32Array | null = null;
            if (embed !== 'keyword') {
              vector = vectors.get(p.text) ?? null;
              if (!vector) { vector = await product.embedQuery(p.text); vectors.set(p.text, vector); }
            }
            let meta: { hub_dampening?: { half_degree?: unknown } } | null = null;
            const t0 = performance.now();
            const results = await search(engine, p.text, {
              limit: K, relationalRetrieval: false, expansion: false, autocut: false, adaptiveReturn: false,
              ...(vector ? { queryEmbedFn: () => new Float32Array(vector!) } : {}),
              onMeta: m => { meta = m as typeof meta; },
            });
            row.latency_ms = Math.round((performance.now() - t0) * 10) / 10;
            const observed = (meta as { hub_dampening?: { half_degree?: unknown } } | null)?.hub_dampening?.half_degree ?? 'off';
            if (String(observed) !== String(arm.halfDegree)) throw new Error(`search telemetry reports hub_dampening ${String(observed)}, arm is ${String(arm.halfDegree)}`);
            Object.assign(row, scoreTop(results.map(r => r.slug), p.grades));
            accounting.score(`${arm.label}:${p.id}`, row.ndcg_at_5 ?? 0);
          } catch (e) {
            row.error = (e as Error).message.slice(0, 300);
            accounting.error(`${arm.label}:${p.id}`, 'harness', row.error);
          }
          appendFileSync(rowsPath, JSON.stringify(row) + '\n');
        }
      }
    },
  });
  try { await (embed === 'openai' ? go() : withHermeticEnv('hub-world-arms', go)); } catch (e) { harnessError = (e as Error).message; }

  const rows = readFileSync(rowsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ArmRow);
  const summary: Record<string, Record<string, unknown>> = {};
  for (const arm of arms) for (const family of ['concept', 'hub-answer', 'bridge', 'one-hop']) {
    const rs = rows.filter(r => r.arm === arm.label && r.family === family && !r.error);
    const mean = (k: keyof ArmRow) => { const xs = rs.map(r => r[k]).filter((x): x is number => typeof x === 'number'); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    summary[`${arm.label}:${family}`] = { n: rs.length, ndcg_at_5: mean('ndcg_at_5'), recall_at_5: mean('recall_at_5'), hit_at_1: mean('hit_at_1'),
      latency_p95_ms: rs.length ? percentile(rs.map(r => r.latency_ms ?? 0), 95) : null };
  }
  let cost: unknown = null;
  if (paid) { cost = receiptCost(paid.run.close()); paid.guard.uninstall(); }
  const world = existsSync(join(corpusDir, '_hub_world.json')) ? JSON.parse(readFileSync(join(corpusDir, '_hub_world.json'), 'utf8')) : null;
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({
    kind: 'hub-world-arms', schema_version: 1, run_status: harnessError ? 'error' : 'completed', harness_error: harnessError,
    started_at: started, finished_at: new Date().toISOString(), embed, k: K, arms, config_readback: readbacks,
    common_search_pins: RELATIONAL_PINS, product: productIdentityFor(gut), overlay: overlaySummary(gut),
    world: world ? { seed: world.seed, salted: world.salted, pages: world.pages, links: world.links, hubs: world.hubs, inbound_quantiles: world.inbound_quantiles } : null,
    accounting: accounting.summary(), cost, summary, rows_file: 'rows.ndjson',
  }, null, 2) + '\n');
  for (const [k, v] of Object.entries(summary)) process.stderr.write(`${k}: ${JSON.stringify(v)}\n`);
  process.exit(harnessError ? 3 : 0);
}

if (import.meta.main) await main();
