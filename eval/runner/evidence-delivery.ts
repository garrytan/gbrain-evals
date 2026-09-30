/**
 * Evidence-delivery study (2026-09-30): the executable decision manifest, the
 * frozen evidence manifest, the E1 delivery ablation, the E3 product-path
 * parity check and the E2 sealed bridge. Preregistration:
 * docs/benchmarks/2026-09-30-evidence-delivery-preregistration.md.
 *
 * Keyless:
 *   cluster-map  --dataset <longmemeval_s_cleaned.json>
 *   power        [--sims N] [--out <json>]
 *   parity       --frozen-dir <dir> --dataset <json> [--out <json>]
 *   analyze      --rows-dir <dir> --stage pilot|confirmatory [--pilot-decision <json>] [--frozen-dir <dir>] [--out <json>]
 *   costs
 *
 * Paid (every request is reserved in the budget ledger; real runs join the
 * campaign run with --budget-run-id; --smoke runs open their own run, <= $3):
 *   campaign-open --budget-usd <= 400
 *   freeze     --dataset <json> --out-dir <dir> [--set pilot|confirmatory|all] [--limit N] [--ids a,b] [--embed-cache <sqlite>]
 *   e1         --frozen-dir <dir> --dataset <json> --out-dir <dir> --set pilot|confirmatory --arms a,b [--reader sonnet|gpt4o] [--decision <json>]
 *   e3         --frozen-dir <dir> --dataset <json> --out-dir <dir> --arms page,a,b [--limit 100] [--score]
 *   e2-freeze  --questions <sealed questions.json> --out-dir <dir>
 *   e2-answer  --questions <json> --frozen-dir <dir> --decision <confirmatory decision json> --out <jsonl>
 *   e2-score   --questions <json> --labels <private labels.json> --answers <jsonl> --decision <json> --purpose <text> --out <json>
 *
 * GBRAIN_DIR (or --gbrain-dir) names the gbrain checkout under test.
 */
import './budget-ledger.ts';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BudgetExceededError, BudgetRun, budgetOptionsFrom, receiptCost, startPaidRun, type BudgetOptions } from './budget-ledger.ts';
import { decideConfirmatory, gpt4oSecondArm, loadDecisionManifest, selectPilot, validateDecisionManifest, type ArmRows, type DecisionManifest } from './evidence-delivery/decision.ts';
import { CLUSTER_MAP_PATH, REPO_ROOT, STUDY_DIR, buildClusterMap, loadClusterMap, loadDataset, pilotIds, sha256 } from './evidence-delivery/data.ts';
import { runPowerAnalysis } from './evidence-delivery/power.ts';
import { configureGbrainGateway, loadGbrain, resolveGbrainDir, type GbrainModules } from './evidence-delivery/gbrain.ts';
import { RERANK_TIMEOUT_MS, freeze, type FreezeInput } from './evidence-delivery/freeze.ts';
import { readFrozen } from './evidence-delivery/store.ts';
import { parityCheck, type R1Call } from './evidence-delivery/parity.ts';
import { GPT4O, SONNET, estimateE1Usd, readRows, rendererFrom, rowsPath, runE1, toOutcome, type E1Context } from './evidence-delivery/e1.ts';
import { checkQuestion, guardedStdioDriver, makeBrainHome, requestFromSerialized, resultsOf, type E3QuestionRecord } from './evidence-delivery/e3.ts';
import { readerCall, gbrainJudge, officialJudge, providerInputTokens } from './evidence-delivery/calls.ts';
import { buildSealedRequests, decisionIdFor, gbrainJudgeId, scoreSealed, sealedDatasetView, sealedFreezeInputs, type SealedAnswerRow } from './evidence-delivery/e2-bridge.ts';
import { requestSha } from './evidence-delivery/arms.ts';

export const R1_DIR = join(REPO_ROOT, 'docs/benchmarks/2026-09-29-longmemeval-opaque-qa/reranker-on/r1');
export const CAMPAIGN_RUNNER = 'evidence-delivery-campaign';
export const SMOKE_CAP_USD = 3;

export class Args {
  private values = new Map<string, string>();
  private switches = new Set<string>();
  readonly positional: string[] = [];
  constructor(readonly argv: string[]) {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { this.positional.push(a); continue; }
      const eq = a.indexOf('=');
      if (eq > 0) { this.values.set(a.slice(0, eq), a.slice(eq + 1)); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { this.values.set(a, next); i++; }
      else this.switches.add(a);
    }
  }
  get(name: string): string | null { return this.values.get(name) ?? null; }
  need(name: string): string { const v = this.get(name); if (!v) throw new Error(`${name} is required`); return v; }
  num(name: string, fallback: number): number { const v = this.get(name); return v === null ? fallback : Number(v); }
  list(name: string): string[] | null { const v = this.get(name); return v === null ? null : v.split(',').map(s => s.trim()).filter(Boolean); }
  flag(name: string): boolean { return this.switches.has(name); }
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
const log = (line: string) => process.stderr.write(line + '\n');
export const readJsonl = (path: string) => readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

function manifestOrThrow() {
  const { manifest, sha256: sha } = loadDecisionManifest();
  const problems = validateDecisionManifest(manifest);
  if (problems.length) throw new Error(`decision manifest invalid: ${problems.join('; ')}`);
  return { manifest, sha };
}

export function evalsCommit(): string {
  return execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/** The decision manifest must be committed and unchanged before any non-smoke paid call. */
export const DECISION_MANIFEST_REL = 'docs/benchmarks/2026-09-30-evidence-delivery/decision-manifest.json';

export function assertManifestCommitted(root = REPO_ROOT, rel = DECISION_MANIFEST_REL): void {
  try { execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', rel], { stdio: 'pipe' }); }
  catch { throw new Error(`${rel} is not committed; commit the decision manifest before any paid run`); }
  const diff = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', rel], { encoding: 'utf8' }).trim();
  if (diff) throw new Error(`${rel} has uncommitted changes; paid runs use the committed manifest only`);
}

/** Budget options with the manifest's program cap unless one was given explicitly. */
export interface CampaignBudget { budget: { campaign_cap_usd: number; program_cap_usd: number; campaign_runner?: string } }

export function budgetOptions(a: Args, m: CampaignBudget): BudgetOptions {
  const o = budgetOptionsFrom(a.argv);
  const explicit = a.get('--program-cap-usd') !== null || process.env.BRAINBENCH_PROGRAM_CAP_USD !== undefined;
  return { ...o, programCapUsd: explicit ? o.programCapUsd : m.budget.program_cap_usd };
}

/**
 * Open the paid guard. Real runs must join the campaign run (the $400 plan cap
 * binds across every subcommand); smoke runs open their own run of at most $3.
 */
export function paidGuard(a: Args, m: CampaignBudget, runner: string, estimateUsd: number, manifestRel = DECISION_MANIFEST_REL) {
  const campaignRunner = m.budget.campaign_runner ?? CAMPAIGN_RUNNER;
  const smoke = a.flag('--smoke');
  const o = budgetOptions(a, m);
  if (smoke) {
    if (o.runId) throw new Error('--smoke opens its own run; do not pass --budget-run-id');
    if (o.budgetUsd === null || o.budgetUsd > SMOKE_CAP_USD) throw new Error(`--smoke needs --budget-usd <= ${SMOKE_CAP_USD}`);
    return startPaidRun(`${runner}-smoke`, { ...o, estimateUsd: Math.min(estimateUsd, o.budgetUsd), log });
  }
  assertManifestCommitted(REPO_ROOT, manifestRel);
  if (!o.runId) throw new Error(`join the campaign run with --budget-run-id (open it once with campaign-open --budget-usd ${m.budget.campaign_cap_usd})`);
  const ledger = JSON.parse(readFileSync(o.ledgerPath, 'utf8'));
  const run = ledger.runs.find((r: any) => r.run_id === o.runId);
  if (run?.runner !== campaignRunner) throw new Error(`${o.runId} is not an ${campaignRunner} run`);
  if (run.budget_usd > m.budget.campaign_cap_usd) throw new Error(`campaign run budget $${run.budget_usd} exceeds the manifest cap $${m.budget.campaign_cap_usd}`);
  return startPaidRun(runner, { ...o, estimateUsd, log });
}

export async function gbrainFor(a: Args, requireEvidence = false): Promise<GbrainModules> {
  const g = await loadGbrain(resolveGbrainDir(a.get('--gbrain-dir')), { requireEvidence });
  configureGbrainGateway(g);
  return g;
}

export function r1Rows(): Map<string, any> {
  return new Map(readJsonl(join(R1_DIR, 'rows.ndjson')).filter((r: any) => r.question_id).map((r: any) => [r.question_id, r]));
}

export function r1Calls(): Map<string, R1Call> {
  const lines = gunzipSync(readFileSync(join(R1_DIR, 'calls.ndjson.gz'))).toString('utf8').split('\n').filter(l => l.trim());
  const out = new Map<string, R1Call>();
  for (const l of lines) { const r = JSON.parse(l); if (r.lane === 'reader' && typeof r.question === 'string') out.set(r.question, { system: r.system, user: r.user }); }
  return out;
}

function selectIds(a: Args, m: DecisionManifest, all: string[]): string[] {
  const pilot = new Set(pilotIds(m));
  const set = a.get('--set') ?? 'pilot';
  const explicit = a.list('--ids');
  let ids = explicit ?? (set === 'all' ? all : all.filter(id => (set === 'pilot') === pilot.has(id)));
  if (set === 'pilot') ids = pilotIds(m).filter(id => ids.includes(id));
  const shard = a.get('--shard');
  if (shard) {
    const [k, n] = shard.split('/').map(Number);
    if (!(n > 0 && k >= 0 && k < n)) throw new Error('--shard must be k/n with 0 <= k < n');
    ids = ids.filter((_, i) => i % n === k);
  }
  return ids.slice(0, a.num('--limit', ids.length));
}

// ─── Keyless commands ────────────────────────────────────────────────

async function cmdClusterMap(a: Args) {
  const { manifest } = manifestOrThrow();
  const questions = loadDataset(a.need('--dataset'), manifest.data.longmemeval_s.sha256);
  const map = buildClusterMap(questions, manifest.data.longmemeval_s.sha256);
  writeJson(a.get('--out') ?? CLUSTER_MAP_PATH, map);
  const sizes = new Map<string, number>();
  for (const c of Object.values(map.clusters)) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  process.stdout.write(JSON.stringify({ questions: questions.length, clusters: sizes.size, multi_question_clusters: [...sizes.values()].filter(n => n > 1).length }) + '\n');
}

async function cmdPower(a: Args) {
  const { manifest, sha } = manifestOrThrow();
  const pilot = new Set(pilotIds(manifest));
  const clusterMap = loadClusterMap();
  const confirmatoryIds = Object.keys(clusterMap).filter(id => !pilot.has(id));
  const clusters = new Map(confirmatoryIds.map((id, k) => [k, clusterMap[id]]));
  const report = runPowerAnalysis(manifest, sha, { sims: a.num('--sims', 400), selectionSims: a.num('--selection-sims', 2000), e2Sims: a.num('--e2-sims', 1000), seed: a.num('--seed', 20260930), draws: a.num('--draws', 2000), clusters });
  writeJson(a.get('--out') ?? join(STUDY_DIR, 'power-analysis.json'), report);
  process.stdout.write(JSON.stringify({ confirmatory: report.confirmatory.map(c => [c.chunk_accuracy, c.closure, c.success]), e2: report.e2.map(c => [c.reader_noise, c.chunk_accuracy, c.true_delta, c.pass, c.reject]) }) + '\n');
}

async function cmdParity(a: Args) {
  const { manifest } = manifestOrThrow();
  const g = await gbrainFor(a);
  const frozen = readFrozen(a.need('--frozen-dir'));
  const ds = new Map(loadDataset(a.need('--dataset'), manifest.data.longmemeval_s.sha256).map(q => [q.question_id, q]));
  const report = parityCheck([...frozen.questions.values()], frozen.store, rendererFrom(g), id => ({ question: ds.get(id)!.question, question_date: ds.get(id)!.question_date }), r1Calls(), SONNET, manifest.reader.max_tokens);
  writeJson(a.get('--out') ?? join(a.need('--frozen-dir'), 'parity.json'), { frozen_manifest_sha256: frozen.sha256, gbrain_commit: frozen.header.gbrain.commit, ...report });
  process.stdout.write(JSON.stringify({ ok: report.ok, harness_vs_r1: { eligible: report.harness_vs_r1.eligible, identical: report.harness_vs_r1.identical }, product_page_vs_harness: report.product_page_vs_harness && { ...report.product_page_vs_harness, examples: report.product_page_vs_harness.examples.length } }, null, 2) + '\n');
}

function loadArmRows(dir: string, set: string, arms: string[], model: string): ArmRows {
  return Object.fromEntries(arms.map(arm => [arm, readRows(rowsPath(dir, set, arm, model)).map(toOutcome)]));
}

async function cmdAnalyze(a: Args) {
  const { manifest, sha } = manifestOrThrow();
  const dir = a.need('--rows-dir');
  const stage = a.need('--stage');
  const all = Object.keys(loadClusterMap());
  const pilot = pilotIds(manifest);
  const confirmatory = all.filter(id => !pilot.includes(id));
  const out: Record<string, unknown> = { decision_manifest_sha256: sha, stage, rows_dir: dir };
  if (stage === 'pilot') {
    const arms = ['chunk', 'page', ...manifest.family.candidates, 'page_legacy'];
    const rows = loadArmRows(dir, 'pilot', arms, SONNET);
    out.selection = selectPilot(manifest, rows, pilot);
    for (const extra of ['k10', 'agent_fetch']) {
      const r = readRows(rowsPath(dir, 'pilot', extra, SONNET));
      if (r.length) out[extra] = { n: r.length, correct: r.filter(x => x.primary === 1).length, mean_provider_input: r.reduce((s, x) => s + (x.tokens.provider_input ?? 0), 0) / r.length, ...(extra === 'agent_fetch' ? { mean_tool_calls: r.reduce((s, x) => s + (x.reader?.tool_calls ?? 0), 0) / r.length } : {}) };
    }
    const legacy = readRows(rowsPath(dir, 'pilot', 'page_legacy', SONNET));
    if (legacy.length && a.get('--frozen-dir')) {
      const frozen = readFrozen(a.get('--frozen-dir')!);
      const r1 = r1Rows();
      const same = legacy.filter(r => frozen.questions.get(r.question_id)?.r1?.identical_slug_chunk_rank);
      const agree = same.filter(r => (r.primary === 1) === (r1.get(r.question_id)?.judge_correct === true)).length;
      out.test_retest = { questions: same.length, agree, disagree: same.length - agree, page_legacy_correct: same.filter(r => r.primary === 1).length, r1_correct: same.filter(r => r1.get(r.question_id)?.judge_correct === true).length };
    }
  } else if (stage === 'confirmatory') {
    const pilotDecision = JSON.parse(readFileSync(a.need('--pilot-decision'), 'utf8'));
    const advanced: string[] = pilotDecision.selection.advanced;
    const rows = loadArmRows(dir, 'confirmatory', ['chunk', 'page', ...advanced], SONNET);
    const decision = decideConfirmatory(manifest, rows, confirmatory, advanced);
    out.decision = decision;
    out.gpt4o_second_arm = gpt4oSecondArm(manifest, decision);
    const g4 = loadArmRows(dir, 'confirmatory', ['chunk', ...(out.gpt4o_second_arm as any).arm ? [(out.gpt4o_second_arm as any).arm] : []], GPT4O);
    if (g4.chunk?.length) out.gpt4o = Object.fromEntries(Object.entries(g4).map(([k, v]) => [k, { n: v.length, correct: v.filter(r => r.primary === 1).length }]));
  } else throw new Error('--stage must be pilot or confirmatory');
  writeJson(a.get('--out') ?? join(dir, `${stage}-decision.json`), out);
  process.stdout.write(JSON.stringify(out, (k, v) => (k === 'per_type' ? undefined : v), 2).slice(0, 4000) + '\n');
}

/** The paid program, per question, from measured R1/c1 token counts at list prices (Sonnet $3/$15, gpt-4o $2.50/$10 per 1M). */
export function costPlan() {
  const sonnet = (inTok: number, outTok = 300) => inTok * 3e-6 + outTok * 15e-6;
  const gpt4o = (inTok: number, outTok = 250) => inTok * 2.5e-6 + outTok * 10e-6;
  const judges = 0.0017;
  const perArm: Record<string, number> = {
    chunk: sonnet(3500), window1: sonnet(6600), window2: sonnet(6600), section: sonnet(6600), page: sonnet(15800),
    auto4k: sonnet(4600), auto6k: sonnet(6600), auto7_5k: sonnet(8200), k10: sonnet(6600), page_legacy: sonnet(15800), agent_fetch: sonnet(30000, 700),
  };
  const lines = [
    { step: 'freeze LongMemEval-S (500 questions): embeddings on a cold cache plus two reranks per question', usd: 500 * (116_000 * 0.13e-6 + 2 * 14_000 * 0.05e-6) },
    { step: 'E1 pilot: 10 arms x 100 questions (9 delivery arms + page_legacy), both judges', usd: 100 * (Object.entries(perArm).filter(([k]) => k !== 'agent_fetch').reduce((s, [, v]) => s + v + judges, 0)) },
    { step: 'E1b agent_fetch: 100 pilot questions, up to 5 get_page fetches', usd: 100 * (perArm.agent_fetch + judges) },
    { step: 'E3: 100 pilot questions, page + 2 advanced arms, product evidence scored for the advanced arms (import embeddings cached)', usd: 100 * (2 * (sonnet(6600) + judges) + 0.003) },
    { step: 'E1 confirmatory: chunk, page, 2 advanced candidates x 400', usd: 400 * (perArm.chunk + perArm.page + 2 * sonnet(6600) + 4 * judges) },
    { step: 'gpt-4o: chunk + winner x 400 confirmatory', usd: 400 * (gpt4o(3500) + gpt4o(6600) + 2 * judges) },
    { step: 'E2 sealed: freeze 30 haystacks, chunk + winner x 150, both judges', usd: 30 * 60_000 * 0.13e-6 + 150 * (sonnet(2500) + sonnet(4500) + 2 * judges) },
  ];
  const total = lines.reduce((s, l) => s + l.usd, 0);
  return { lines: lines.map(l => ({ ...l, usd: Number(l.usd.toFixed(2)) })), total_usd: Number(total.toFixed(2)), with_retry_margin_usd: Number((total * 1.25).toFixed(2)) };
}

async function cmdCosts() {
  process.stdout.write(JSON.stringify(costPlan(), null, 2) + '\n');
}

// ─── Paid commands ───────────────────────────────────────────────────

async function cmdCampaignOpen(a: Args) {
  const { manifest } = manifestOrThrow();
  assertManifestCommitted();
  const o = budgetOptions(a, manifest);
  if (o.budgetUsd === null || o.budgetUsd > manifest.budget.campaign_cap_usd) throw new Error(`--budget-usd must be at most the manifest's campaign cap $${manifest.budget.campaign_cap_usd}`);
  const run = BudgetRun.open({ runner: CAMPAIGN_RUNNER, budgetUsd: o.budgetUsd, estimateUsd: costPlan().with_retry_margin_usd, ledgerPath: o.ledgerPath, programCapUsd: o.programCapUsd });
  process.stdout.write(run.runId + '\n');
}

async function cmdFreeze(a: Args) {
  const { manifest, sha } = manifestOrThrow();
  const smoke = a.flag('--smoke');
  const g = await gbrainFor(a, !smoke);
  const questions = loadDataset(a.need('--dataset'), manifest.data.longmemeval_s.sha256);
  const byId = new Map(questions.map(q => [q.question_id, q]));
  const ids = selectIds(a, manifest, questions.map(q => q.question_id));
  const pilot = new Set(pilotIds(manifest));
  const r1 = r1Rows();
  const inputs: FreezeInput[] = ids.map(id => ({ question: byId.get(id)!, set: pilot.has(id) ? 'pilot' : 'confirmatory', r1Retrieved: r1.get(id)?.retrieved }));
  const { run, guard } = paidGuard(a, manifest, 'evidence-delivery-freeze', inputs.length * 0.018);
  try {
    const res = await freeze({ g, manifest, manifestSha: sha, outDir: resolve(a.need('--out-dir')), inputs, embedCachePath: resolve(a.get('--embed-cache') ?? join(REPO_ROOT, 'eval/reports/longmemeval/embed-cache/evidence-delivery.sqlite')), datasetSha: manifest.data.longmemeval_s.sha256, smoke, log });
    process.stdout.write(JSON.stringify({ ...res, cost: receiptCost(run.close()) }, null, 2) + '\n');
    if (res.errors.length) process.exitCode = 1;
  } finally { guard.uninstall(); }
}

/** Merge freeze shards made at one gbrain commit (one process per embedding cache) into one frozen manifest. */
export async function cmdMergeFrozen(a: Args) {
  const out = resolve(a.need('--out-dir'));
  const from = (a.list('--from') ?? []).map(d => resolve(d));
  if (from.length < 1) throw new Error('--from needs the shard directories');
  const shards = from.map(d => readFrozen(d));
  const h0 = shards[0].header;
  for (const [i, s] of shards.entries()) {
    const h = s.header;
    if (h.gbrain.commit !== h0.gbrain.commit || h.gbrain.dirty_sha256 !== h0.gbrain.dirty_sha256 || h.decision_manifest_sha256 !== h0.decision_manifest_sha256 || h.smoke !== h0.smoke || h.dataset_sha256 !== h0.dataset_sha256 || JSON.stringify(h.product_arms) !== JSON.stringify(h0.product_arms)) throw new Error(`${from[i]} was frozen under different identities than ${from[0]}`);
  }
  if (existsSync(join(out, 'frozen-manifest.jsonl'))) throw new Error(`${out} already holds a frozen manifest`);
  mkdirSync(join(out, 'blobs'), { recursive: true });
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [i, s] of shards.entries()) {
    for (const sub of readdirSync(join(from[i], 'blobs')).sort()) {
      mkdirSync(join(out, 'blobs', sub), { recursive: true });
      for (const f of readdirSync(join(from[i], 'blobs', sub)).sort()) if (!existsSync(join(out, 'blobs', sub, f))) copyFileSync(join(from[i], 'blobs', sub, f), join(out, 'blobs', sub, f));
    }
    for (const q of s.questions.values()) {
      if (seen.has(q.question_id)) throw new Error(`${q.question_id} appears in two shards`);
      seen.add(q.question_id);
      for (const hash of [q.hits5, q.hits10].flat().map(h => h.text)) if (!s.store.has(hash)) throw new Error(`missing blob ${hash}`);
      lines.push(JSON.stringify(q));
    }
  }
  writeFileSync(join(out, 'frozen-manifest.jsonl'), lines.join('\n') + '\n');
  const header = { ...h0, embed_cache: { sha256_before: null, sha256_after: null, misses: shards.reduce((n, s) => n + (s.header.embed_cache.misses ?? 0), 0), shards: shards.map((s, i) => ({ dir: `shard-${i}`, questions: s.questions.size, ...s.header.embed_cache })) } };
  writeJson(join(out, 'frozen-header.json'), header);
  const merged = readFrozen(out);
  process.stdout.write(JSON.stringify({ questions: merged.questions.size, frozen_manifest_sha256: merged.sha256 }) + '\n');
}

export function e1Context(a: Args, g: GbrainModules, manifest: DecisionManifest, sha: string, set: string, readerModel: string): E1Context {
  const frozen = readFrozen(a.need('--frozen-dir'));
  const smoke = a.flag('--smoke');
  if (!smoke) {
    if (frozen.header.smoke) throw new Error('the frozen manifest is a smoke freeze');
    if (frozen.header.gbrain.commit !== manifest.candidate_commits.gbrain) throw new Error(`frozen at ${frozen.header.gbrain.commit}, the manifest pins ${manifest.candidate_commits.gbrain}`);
  }
  const renderer = rendererFrom(g);
  if (sha256(renderer.system) !== manifest.reader.system_sha256) throw new Error('the reader system text differs from the manifest pin');
  const dataset = new Map(loadDataset(a.need('--dataset'), manifest.data.longmemeval_s.sha256).map(q => [q.question_id, q]));
  return { g, manifest, manifestSha: sha, header: frozen.header, frozenSha: frozen.sha256, store: frozen.store, questions: frozen.questions, renderer, dataset, clusters: loadClusterMap(), outDir: resolve(a.need('--out-dir')), set, readerModel, evalsCommit: evalsCommit(), smoke };
}

async function cmdE1(a: Args) {
  const { manifest, sha } = manifestOrThrow();
  const set = a.need('--set');
  const readerModel = a.get('--reader') === 'gpt4o' ? GPT4O : SONNET;
  const arms = a.list('--arms') ?? [];
  const known = new Set(manifest.arms.map(x => x.id));
  const unknown = arms.filter(x => !known.has(x));
  if (!arms.length || unknown.length) throw new Error(`--arms must list manifest arms (unknown: ${unknown.join(', ')})`);
  const smoke = a.flag('--smoke');
  if (!smoke) {
    if (set === 'pilot') {
      const bad = arms.filter(x => !manifest.arms.find(s => s.id === x)!.sets.includes('pilot'));
      if (bad.length || readerModel !== SONNET) throw new Error(`pilot arms are the Sonnet arms listed for the pilot (not: ${bad.join(', ')})`);
    } else if (set === 'confirmatory') {
      const d = JSON.parse(readFileSync(a.need('--decision'), 'utf8'));
      if (readerModel === SONNET) {
        if (d.stage !== 'pilot' || d.selection?.status !== 'ok' || !d.selection.reference_guard?.ok) throw new Error('confirmatory Sonnet arms need a pilot decision with status ok and a passing page reference guard');
        const allowed = new Set(['chunk', 'page', ...d.selection.advanced]);
        if (arms.some(x => !allowed.has(x))) throw new Error(`confirmatory arms are chunk, page and the advanced candidates (${d.selection.advanced.join(', ')})`);
      } else {
        if (d.stage !== 'confirmatory' || !d.gpt4o_second_arm?.arm) throw new Error('gpt-4o arms need the confirmatory decision');
        const allowed = new Set(['chunk', d.gpt4o_second_arm.arm]);
        if (arms.some(x => !allowed.has(x))) throw new Error(`gpt-4o arms are chunk and ${d.gpt4o_second_arm.arm}`);
      }
    } else throw new Error('--set must be pilot or confirmatory');
  }
  const g = await gbrainFor(a);
  const ctx = e1Context(a, g, manifest, sha, set, readerModel);
  const ids = selectIds(a, manifest, Object.keys(ctx.clusters));
  const missing = ids.filter(id => !ctx.questions.has(id));
  if (missing.length && !smoke) throw new Error(`${missing.length} question(s) are not frozen (${missing.slice(0, 3).join(', ')})`);
  const runIds = ids.filter(id => ctx.questions.has(id));
  // Byte-level harness check before any model call.
  const parity = parityCheck(runIds.map(id => ctx.questions.get(id)!), ctx.store, ctx.renderer, id => ({ question: ctx.dataset.get(id)!.question, question_date: ctx.dataset.get(id)!.question_date }), r1Calls(), SONNET, manifest.reader.max_tokens);
  writeJson(join(ctx.outDir, `parity-${set}.json`), parity);
  if (!parity.ok) throw new Error(`parity check failed before any model call: ${parity.problems.join('; ')}`);
  log(`[e1] parity: ${parity.harness_vs_r1.identical}/${parity.harness_vs_r1.eligible} page_legacy requests byte-identical to R1`);
  const estimate = estimateE1Usd(ctx, runIds.map(id => ctx.questions.get(id)!), arms, g.tokens.estimateTokens);
  const { run, guard } = paidGuard(a, manifest, `evidence-delivery-e1-${set}`, estimate);
  try {
    const res = await runE1(ctx, arms, runIds, a.num('--concurrency', 4), log);
    process.stdout.write(JSON.stringify({ ...res, estimate_usd: Number(estimate.toFixed(2)), cost: receiptCost(run.close()) }, null, 2) + '\n');
  } catch (e) {
    run.close();
    throw e;
  } finally { guard.uninstall(); }
}

async function cmdE3(a: Args) {
  const { manifest, sha } = manifestOrThrow();
  const smoke = a.flag('--smoke');
  const g = await gbrainFor(a, !smoke);
  const ctx = e1Context(a, g, manifest, sha, 'e3', SONNET);
  const armIds = a.list('--arms') ?? ['page'];
  const specs = armIds.map(id => { const s = manifest.arms.find(x => x.id === id); if (!s || s.source !== 'product') throw new Error(`${id} is not a product arm`); return s; });
  const ids = selectIds(a, manifest, [...ctx.questions.keys()]).filter(id => ctx.questions.has(id)).slice(0, a.num('--limit', 100));
  const score = a.flag('--score');
  const { run, guard } = paidGuard(a, manifest, 'evidence-delivery-e3', ids.length * (0.004 + (score ? specs.length * 0.03 : 0)));
  process.env.BRAINBENCH_BUDGET_RUN_ID = run.runId;
  const { PGLiteEngine } = await import(join(g.dir, 'src/core/pglite-engine.ts'));
  const cache = new g.embedCache.EmbeddingCache(resolve(a.get('--embed-cache') ?? join(REPO_ROOT, 'eval/reports/longmemeval/embed-cache/evidence-delivery.sqlite')));
  const installed = g.embedCache.installEmbedCache(cache, { realTransport: null });
  const outPath = join(ctx.outDir, 'e3.ndjson');
  mkdirSync(ctx.outDir, { recursive: true });
  const done = new Set(existsSync(outPath) ? readJsonl(outPath).map((r: any) => r.question_id) : []);
  try {
    for (const id of ids) {
      if (done.has(id)) continue;
      const q = ctx.questions.get(id)!;
      const d = ctx.dataset.get(id)!;
      const brain = makeBrainHome(process.env);
      try {
        const engine = new PGLiteEngine();
        await engine.connect({ engine: 'pglite', database_path: brain.databasePath });
        await engine.initSchema();
        await engine.setConfig('search.mode', 'balanced');
        await engine.setConfig('search.reranker.enabled', 'true');
        await engine.setConfig('search.autocut', 'false');
        await engine.setConfig('search.reranker.timeout_ms', String(RERANK_TIMEOUT_MS));
        await cache.withTransaction(async () => { for (const p of g.adapter.haystackToPages(d)) await g.importFile.importFromContent(engine, p.slug, p.content, { noEmbed: false }); });
        await engine.disconnect();
        const driver = guardedStdioDriver(g.dir, brain.env);
        await driver.start();
        let record: E3QuestionRecord & { scored?: unknown[] };
        try {
          record = await checkQuestion(driver, q, d.question, specs, ctx.store, g.evidence ? g.evidence.evidenceFingerprint : () => 'unavailable', g.tokens.estimateTokens);
          if (score) {
            record.scored = [];
            for (const spec of specs) {
              const resp = await driver.call('query', { query: d.question, limit: 5, expand: false, return_unit: spec.unit, ...(spec.return_window ? { return_window: spec.return_window } : {}), ...(spec.budget_tokens ? { token_budget: spec.budget_tokens } : {}) });
              const { request } = requestFromSerialized(ctx.renderer, q, { question: d.question, question_date: d.question_date }, resultsOf(resp.data), SONNET, manifest.reader.max_tokens);
              const rr = await readerCall(g, request);
              const jq = { question_id: id, question_type: d.question_type, question: d.question, answer: d.answer };
              const [gj, oj] = await Promise.all([gbrainJudge(g, jq, rr.text), officialJudge(jq, rr.text)]);
              (record.scored as unknown[]).push({ arm: spec.id, request_sha256: requestSha(request), serialized_sha256: sha256(resp.raw), provider_input: providerInputTokens(rr.usage), primary: gj.judge_correct === true ? 1 : gj.judge_correct === false ? 0 : null, confirmation: (oj as any).off_judge_correct === true ? 1 : (oj as any).off_judge_correct === false ? 0 : null, hypothesis: rr.text });
            }
          }
        } finally { await driver.close(); }
        writeFileSync(outPath, JSON.stringify(record) + '\n', { flag: 'a' });
        log(`[e3] ${id} live=${record.live_hits_match_frozen ? 'same' : 'drift'} ${record.arms.map(x => `${x.arm}:lr=${x.local_remote_match} pp=${x.product_path_match} tok=${x.tokens_match} unc=${x.uncontained_segments}`).join(' ')}`);
      } finally { brain.cleanup(); }
    }
    process.stdout.write(JSON.stringify({ questions: ids.length, out: outPath, cost: receiptCost(run.close()) }, null, 2) + '\n');
  } finally { installed.uninstall(); cache.close?.(); guard.uninstall(); }
}

async function cmdE2Freeze(a: Args) {
  const { manifest, sha } = manifestOrThrow();
  const { loadManifest, loadQuestions, toLmeRows, DEFAULT_MANIFEST } = await import('./sealed-confirmation.ts');
  const q = loadQuestions(a.need('--questions'), loadManifest(a.get('--sealed-manifest') ?? DEFAULT_MANIFEST));
  const g = await gbrainFor(a, true);
  const inputs = sealedFreezeInputs(toLmeRows(q));
  const { run, guard } = paidGuard(a, manifest, 'evidence-delivery-e2-freeze', inputs.length * 0.01);
  try {
    const res = await freeze({ g, manifest, manifestSha: sha, outDir: resolve(a.need('--out-dir')), inputs, embedCachePath: resolve(a.get('--embed-cache') ?? join(REPO_ROOT, 'eval/reports/longmemeval/embed-cache/evidence-delivery-sealed.sqlite')), datasetSha: sha256(readFileSync(a.need('--questions'))), smoke: false, log });
    process.stdout.write(JSON.stringify({ ...res, cost: receiptCost(run.close()) }, null, 2) + '\n');
  } finally { guard.uninstall(); }
}

function e2Winner(a: Args, m: DecisionManifest): string {
  const d = JSON.parse(readFileSync(a.need('--decision'), 'utf8'));
  if (d.stage !== 'confirmatory' || d.decision?.outcome !== 'success' || !d.decision.winner) throw new Error('E2 runs only after an E1 confirmatory success (manifest e2.run_only_if)');
  decisionIdFor(m, d.decision.winner);
  return d.decision.winner;
}

async function cmdE2Answer(a: Args) {
  const { manifest, sha } = manifestOrThrow();
  const winner = e2Winner(a, manifest);
  const { loadManifest, loadQuestions, DEFAULT_MANIFEST } = await import('./sealed-confirmation.ts');
  const questions = loadQuestions(a.need('--questions'), loadManifest(a.get('--sealed-manifest') ?? DEFAULT_MANIFEST));
  const g = await gbrainFor(a);
  const frozen = readFrozen(a.need('--frozen-dir'));
  if (frozen.header.gbrain.commit !== manifest.candidate_commits.gbrain) throw new Error('sealed freeze is not at the pinned gbrain commit');
  const ctx = { store: frozen.store, renderer: rendererFrom(g), dataset: sealedDatasetView(questions), readerModel: SONNET, manifest };
  const outPath = resolve(a.need('--out'));
  const { run, guard } = paidGuard(a, manifest, 'evidence-delivery-e2-answer', questions.questions.length * 0.06);
  const rows: SealedAnswerRow[] = [];
  try {
    for (const sq of questions.questions) {
      const fq = frozen.questions.get(sq.question_id);
      if (!fq) throw new Error(`${sq.question_id} is not frozen`);
      const reqs = buildSealedRequests(ctx, fq, winner);
      for (const [arm, built] of [['chunk', reqs.chunk], [winner, reqs.winner]] as const) {
        const row: SealedAnswerRow = { question_id: sq.question_id, arm, provider_input_tokens: null, request_sha256: requestSha(built.request), evidence_sha256: built.frozenArm.evidence_sha256 };
        try { const r = await readerCall(g, built.request); row.hypothesis = r.text; row.provider_input_tokens = providerInputTokens(r.usage); }
        catch (e: any) { if (e instanceof BudgetExceededError) throw e; row.reader_error = String(e?.message ?? e).slice(0, 300); }
        rows.push(row);
      }
    }
    writeFileSync(outPath, rows.map(r => JSON.stringify({ ...r, decision_manifest_sha256: sha })).join('\n') + '\n');
    process.stdout.write(JSON.stringify({ rows: rows.length, cost: receiptCost(run.close()) }) + '\n');
  } finally { guard.uninstall(); }
}

async function cmdE2Score(a: Args) {
  const { manifest } = manifestOrThrow();
  const winner = e2Winner(a, manifest);
  const sealed = await import('./sealed-confirmation.ts');
  const lib = await import('./sealed-confirmation-lib.ts');
  const sealedManifest = sealed.loadManifest(a.get('--sealed-manifest') ?? sealed.DEFAULT_MANIFEST);
  const questions = sealed.loadQuestions(a.need('--questions'), sealedManifest);
  const answersPath = a.need('--answers');
  const answers = readJsonl(answersPath) as SealedAnswerRow[];
  const g = await gbrainFor(a);
  const outPath = resolve(a.need('--out'));
  const { run, guard } = paidGuard(a, manifest, 'evidence-delivery-e2-score', questions.questions.length * 2 * 0.004);
  const llm = new lib.LlmClient({ ledger: new lib.SpendLedger(join(dirname(outPath), 'e2-judge-spend.jsonl'), a.num('--cap-usd', 5)), cacheDir: join(dirname(outPath), 'e2-llm-cache') });
  try {
    const labelsPath = a.need('--labels');
    const result = await scoreSealed({
      manifest, winner, questions, answers,
      openLabels: decisionId => sealed.openLabels(labelsPath, sealedManifest, { path: a.get('--access-log') ?? join(dirname(resolve(labelsPath)), 'access-log.jsonl'), action: 'score', purpose: a.need('--purpose'), decision_id: decisionId, run_sha256: sha256(readFileSync(answersPath)) }),
      judgePrimary: async (l, question, hyp) => { const f = await gbrainJudge(g, { question_id: gbrainJudgeId(l), question_type: l.question_type, question, answer: l.answer }, hyp); return f.judge_correct === true ? 1 : f.judge_correct === false ? 0 : null; },
      judgeConfirm: async (l, question, hyp) => ((await sealed.judge(llm, `e2 ${l.question_id}`, l.question_type, question, l.answer, hyp)) ? 1 : 0),
    });
    writeJson(outPath, { decision_id: result.decision_id, decision: result.decision, cost: receiptCost(run.close()) });
    writeJson(`${outPath}.private-judgments.json`, result.judgments);
    process.stdout.write(JSON.stringify(result.decision, null, 2) + '\n');
  } finally { guard.uninstall(); }
}

/** Keyless E3 summary against the manifest's pass rule, with the E1 frozen-evidence answers for the same questions. */
export async function cmdE3Summary(a: Args) {
  const records = readJsonl(a.need('--e3')) as Array<E3QuestionRecord & { scored?: Array<{ arm: string; primary: 0 | 1 | null; confirmation: 0 | 1 | null; provider_input: number }> }>;
  const arms = [...new Set(records.flatMap(r => r.arms.map(x => x.arm)))];
  const count = (f: (x: any) => unknown, arm: string, v: unknown) => records.filter(r => f(r.arms.find(x => x.arm === arm)) === v).length;
  const perArm = Object.fromEntries(arms.map(arm => {
    const scored = records.map(r => r.scored?.find(x => x.arm === arm)).filter(Boolean) as Array<{ primary: 0 | 1 | null; confirmation: 0 | 1 | null; provider_input: number; question_id?: string }>;
    const e1 = a.get('--rows-dir') ? new Map(readRows(rowsPath(a.get('--rows-dir')!, 'pilot', arm, SONNET)).map(r => [r.question_id, r])) : null;
    const agree = e1 ? records.filter(r => { const s = r.scored?.find(x => x.arm === arm); const e = e1.get(r.question_id); return s && e && s.primary === e.primary; }).length : null;
    const pageParity = arm === 'page' ? records.reduce((acc: Record<string, number>, r) => { for (const [k, v] of Object.entries(r.arms.find(x => x.arm === arm)?.page_parity ?? {})) acc[k] = (acc[k] ?? 0) + (v as number); return acc; }, {}) : undefined;
    return [arm, {
      local_remote_match: { true: count(x => x?.local_remote_match, arm, true), false: count(x => x?.local_remote_match, arm, false), null: count(x => x?.local_remote_match, arm, null) },
      product_path_match: { true: count(x => x?.product_path_match, arm, true), false: count(x => x?.product_path_match, arm, false), null: count(x => x?.product_path_match, arm, null) },
      tokens_match: { true: count(x => x?.tokens_match, arm, true), false: count(x => x?.tokens_match, arm, false), null: count(x => x?.tokens_match, arm, null) },
      uncontained_segments: records.reduce((n, r) => n + (r.arms.find(x => x.arm === arm)?.uncontained_segments ?? 0), 0),
      errors: records.reduce((n, r) => n + (r.arms.find(x => x.arm === arm)?.errors.length ?? 0), 0),
      ...(pageParity ? { page_parity: pageParity } : {}),
      scored: { n: scored.length, primary: scored.filter(x => x.primary === 1).length, confirmation: scored.filter(x => x.confirmation === 1).length, mean_provider_input: scored.length ? scored.reduce((t, x) => t + x.provider_input, 0) / scored.length : null },
      ...(agree !== null ? { primary_agrees_with_e1_frozen_answer: agree } : {}),
    }];
  }));
  const pass = records.length > 0 && arms.every(arm => (perArm[arm] as any).local_remote_match.true === records.length && (perArm[arm] as any).product_path_match.true === records.length && (perArm[arm] as any).tokens_match.true === records.length && (perArm[arm] as any).uncontained_segments === 0);
  const out = { questions: records.length, live_hits_match_frozen: records.filter(r => r.live_hits_match_frozen).length, arms: perArm, pass };
  if (a.get('--out')) writeJson(a.get('--out')!, out);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

const COMMANDS: Record<string, (a: Args) => Promise<void>> = {
  'cluster-map': cmdClusterMap, power: cmdPower, 'e3-summary': cmdE3Summary, parity: cmdParity, analyze: cmdAnalyze, costs: cmdCosts,
  'campaign-open': cmdCampaignOpen, freeze: cmdFreeze, 'merge-frozen': cmdMergeFrozen, e1: cmdE1, e3: cmdE3, 'e2-freeze': cmdE2Freeze, 'e2-answer': cmdE2Answer, 'e2-score': cmdE2Score,
};

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[cmd];
  if (!fn) { process.stderr.write(`usage: bun eval/runner/evidence-delivery.ts <${Object.keys(COMMANDS).join('|')}> ...\n`); process.exit(2); }
  fn(new Args(rest)).then(() => process.exit(process.exitCode ?? 0)).catch(e => { process.stderr.write(`[evidence-delivery] FATAL: ${e?.stack ?? e}\n`); process.exit(1); });
}

