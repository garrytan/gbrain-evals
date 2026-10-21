#!/usr/bin/env bun
/**
 * External ideas wave A (GBRA-162): does gbrain's `search.evidence_resolve_dates`
 * flag, which adds absolute date brackets to relative phrases in delivered
 * conversation turns ("three weeks ago [≈2023-05-07]"), change LongMemEval-S
 * answer accuracy? Retrieval is frozen once; arm `auto` (flag off) and arm
 * `auto_dates` (flag on) are both delivered by gbrain's own
 * assembleEvidenceForHits on the same hits, so the only difference a reader
 * sees is the delivered text. Study manifest:
 * docs/benchmarks/2026-10-21-external-ideas-wave-a/study-manifest.json.
 *
 *   freeze    --dataset <json> --out-dir <dir> --budget-usd <cap> [--shard k/n] [--limit N] [--ids a,b] [--embed-cache <sqlite>] [--smoke]
 *   affected  --frozen-dir <dir> --dataset <json>
 *   answer    --frozen-dir <dir> --dataset <json> --arm auto|auto_dates --sample 1|2 --model <gateway id> --set all|affected
 *             --out-dir <dir> --budget-usd <cap> [--wait] [--retry] [--judge-only] [--list-price] [--smoke]
 *   analyze   --rows-dir <dir> --frozen-dir <dir> [--model <id>] [--samples 1,2] [--scope all|affected] [--out <prefix>]
 *   verdict   --longmemeval <analysis.json> --synthetic <analysis.json> [--secondary <a.json,b.json>] [--audit <audit.json>] [--out <json>]
 *   audit     --frozen-dir <dir> --n 100 --seed 20261021 --model anthropic:claude-opus-5-5 --budget-usd 3 [--smoke]
 *   estimate  --dataset <json> [--frozen-dir <dir>] [--questions N] [--models a,b] [--samples 2]   (keyless)
 *
 * GBRAIN_DIR (or --gbrain-dir) is the gbrain checkout under test. Every paid
 * request is reserved in the lane's one budget ledger (GBRA162_LEDGER, default
 * ~/.capy/work/gbra162-external-ideas/ledger.sqlite; $220 across waves A and
 * B; a run over $50 needs --gbra108-approval). Exit codes: 0 done, 1 failed or
 * incomplete, 2 preflight refused, 4 STOP (budget).
 */
import './budget-ledger.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BudgetExceededError, chatPrice, initLedger, ledgerStatus, receiptCost, startPaidRun, type BudgetRun, type PaidRequestGuard } from './budget-ledger.ts';
import { Args, evalsCommit, writeJson } from './evidence-delivery.ts';
import { REPO_ROOT, sha256 } from './evidence-delivery/data.ts';
import { freeze, type FreezeInput } from './evidence-delivery/freeze.ts';
import { configureGbrainGateway, gbrainIdentity, loadGbrain, resolveGbrainDir, type GbrainModules } from './evidence-delivery/gbrain.ts';
import { readFrozen, type FrozenHeader } from './evidence-delivery/store.ts';
import { rendererFrom } from './evidence-delivery/e1.ts';
import { gbrainJudge, officialJudge } from './evidence-delivery/calls.ts';
import { bodySha, buildManifest, freezeManifest, MODEL_SETTINGS } from './batch/manifest.ts';
import { JUDGE_PROTOCOL, readerBody, seededSample } from './batch/sources.ts';
import { anthropicTransport, openAiTransport } from './batch/transport.ts';
import { BatchLane } from './batch/submit.ts';
import { attestPreregistration, type Attestation } from './prereg.ts';
import { answerStep, type QuestionMeta, type StepResult } from './external-ideas-wave-a/answer.ts';
import {
  AFFECTED_FILE, ARMS, PREREG_REL, analysisMarkdown, analyze, auditCandidates, auditPrompt, auditVerdict, computeAffected, flipVerdict, latestRows, loadStudyManifest, modelKey,
  preflightProblems, readRows, readerText, rowsPath, validateStudyManifest, verdicts, type AffectedReport, type AnswerRow, type Analysis, type AuditSummary, type Arm, type JudgeVerdicts, type QuestionText,
  type StudyManifest,
} from './external-ideas-wave-a/lib.ts';

export const LANE_LEDGER = process.env.GBRA162_LEDGER ?? join(homedir(), '.capy/work/gbra162-external-ideas/ledger.sqlite');
/** Mean reader output tokens per request in the W10 batch receipts (docs/benchmarks/2026-10-07-longmemeval-w10a/-w10b). */
export const EXPECTED_OUTPUT_TOKENS: Record<string, number> = { 'claude-sonnet-5-5': 203, 'claude-opus-5-5': 294, 'gpt-6.1-sol': 110 };
/**
 * Provider input tokens per gbrain estimateTokens token of the same request. Anthropic: measured on the
 * 2026-10-21 smoke (5 Sonnet 5.5 requests, 116,356 billed input tokens against about 72,865 estimated, 1.60).
 * OpenAI: W10c measured gpt-6.1-sol at 0.62 of Sonnet 5.5's count on identical prompts, so 1.0.
 */
const TOKENIZER_RATIO: Record<string, number> = { anthropic: 1.6, openai: 1.0 };
/** Both judges, per answered row, synchronous at list price (official gpt-4o about 450 input tokens, framed about 800). */
const JUDGE_USD_PER_ROW = 450 * 2.5e-6 + 2 * 10e-6 + 800 * 2.5e-6 + 60 * 10e-6;
const BATCH_FACTOR = 0.5;

class Stop extends Error { constructor(readonly reason: string, message: string, readonly fix?: string) { super(message); } }
class Refused extends Error { constructor(readonly problems: Array<{ code: string; message: string; fix: string }>) { super('preflight refused'); } }

const log = (line: string) => process.stderr.write(line + '\n');
const out = (v: unknown) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n');
const fileSha = (path: string) => (existsSync(path) ? sha256(readFileSync(path)) : null);

function study(): { manifest: StudyManifest; sha: string } {
  const { manifest, sha256: sha } = loadStudyManifest();
  const problems = validateStudyManifest(manifest);
  if (problems.length) throw new Error(`study manifest invalid: ${problems.join('; ')}`);
  return { manifest, sha };
}

async function gbrain(a: Args): Promise<GbrainModules> {
  const g = await loadGbrain(resolveGbrainDir(a.get('--gbrain-dir')), { requireEvidence: true });
  configureGbrainGateway(g);
  return g;
}

const gitOut = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function suiteOf(m: StudyManifest, datasetSha: string): 'longmemeval' | 'synthetic' | null {
  return datasetSha === m.data.longmemeval_s.sha256 ? 'longmemeval' : datasetSha === m.data.synthetic.sha256 ? 'synthetic' : null;
}

function loadDataset(path: string): { sha: string; questions: Array<QuestionText & { question_id: string; haystack_sessions: unknown[] }> } {
  if (!existsSync(path)) throw new Stop('dataset_missing', `no dataset at ${path}`, 'download longmemeval_s_cleaned.json (sha256 d6f21ea9...) or pass eval/data/external-ideas/synthetic-dates-v1.json');
  const bytes = readFileSync(path);
  return { sha: sha256(bytes), questions: JSON.parse(bytes.toString('utf8')) };
}

/** Keyless preflight; refuses with every problem's code and fix. */
function preflight(g: GbrainModules, m: StudyManifest, header: FrozenHeader | null, o: { datasetSha: string | null; keys: string[]; smoke: boolean; needsPrereg: boolean }): Attestation | null {
  let attestation: Attestation | null = null;
  const problems = preflightProblems({
    header, gbrainHead: gitOut(g.dir, ['rev-parse', 'HEAD']), gbrainStatus: gitOut(g.dir, ['status', '--porcelain']), datasetSha: o.datasetSha, env: process.env,
    keys: [...new Set(o.keys)], smoke: o.smoke, manifest: m, readerSystemSha: sha256(g.reader.READER_NOTES_SYSTEM_TEXT),
    codeSha: Object.fromEntries(Object.keys(m.pinned_code_sha256).map(f => [f, fileSha(join(g.dir, f))])),
    needsPrereg: o.needsPrereg, attest: () => { attestation = attestPreregistration(PREREG_REL, REPO_ROOT); },
  });
  if (problems.length) throw new Refused(problems);
  return attestation;
}

/** Open (or resume) a run in the lane's single ledger. Never starts a second ledger. */
function laneRun(a: Args, m: StudyManifest, runner: string, estimate: { expected_usd: number; worst_usd: number }, runFile?: string): { run: BudgetRun; guard: PaidRequestGuard } {
  const ledgerPath = resolve(a.get('--budget-ledger') ?? LANE_LEDGER);
  const cap = m.budget.lane_cap_usd;
  if (ledgerStatus({ ledgerPath }).state === 'missing') {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    initLedger({ ledgerPath, programCapUsd: cap, reason: 'GBRA-162 external-ideas lane (waves A and B share this ledger)' });
  }
  const status = ledgerStatus({ ledgerPath });
  if (status.totals.program_cap_usd !== cap) throw new Stop('ledger_cap_mismatch', `${ledgerPath} records a $${status.totals.program_cap_usd} cap, the lane's is $${cap}`, 'ask GBRA-108; never start a second ledger');
  let runId = a.get('--budget-run-id') ?? (runFile && existsSync(runFile) ? (JSON.parse(readFileSync(runFile, 'utf8')) as { run_id: string }).run_id : null);
  if (runId && ledgerStatus({ ledgerPath, runId }).run?.finished_at) runId = null;
  let budgetUsd: number | null = null;
  if (!runId) {
    budgetUsd = a.num('--budget-usd', NaN);
    if (!(budgetUsd > 0)) throw new Stop('budget_required', 'pass --budget-usd <cap> for this run', '--budget-usd <dollars>');
    if (budgetUsd > m.budget.single_run_approval_usd && !a.get('--gbra108-approval')) throw new Stop('run_over_approval_limit', `a run over $${m.budget.single_run_approval_usd} needs GBRA-108's approval`, '--gbra108-approval "<GBRA-108 message reference>"');
    const left = status.totals.remaining_usd ?? 0;
    if (budgetUsd > left) throw new Stop('budget_exhausted', `--budget-usd $${budgetUsd.toFixed(2)} exceeds the $${left.toFixed(2)} left of the lane's $${cap} (${ledgerPath})`);
    if (estimate.expected_usd > budgetUsd) throw new Stop('estimate_over_cap', `expected $${estimate.expected_usd.toFixed(2)} exceeds --budget-usd $${budgetUsd.toFixed(2)}`, `--budget-usd ${Math.ceil(estimate.worst_usd)}`);
  }
  log(`PREFLIGHT estimate ${runner}: expected $${estimate.expected_usd.toFixed(2)}, worst case $${estimate.worst_usd.toFixed(2)}; lane ledger ${ledgerPath}: $${(status.totals.committed_usd).toFixed(2)} committed of $${cap}`);
  const started = startPaidRun(runner, { budgetUsd, ledgerPath, programCapUsd: cap, runId, estimateUsd: null, log });
  if (runFile && !runId) { mkdirSync(dirname(runFile), { recursive: true }); writeFileSync(runFile, JSON.stringify({ run_id: started.run.runId, ledger: ledgerPath }) + '\n'); }
  return started;
}

// ─── freeze ─────────────────────────────────────────────────────────

/** Embeddings for every haystack on a cold cache (text-embedding-3-large, $0.13/M, about 4 characters a token) plus two Voyage reranks of about 14,000 tokens. */
export function freezeEstimate(questions: Array<{ haystack_sessions: unknown[] }>) {
  const perQ = questions.map(q => (JSON.stringify(q.haystack_sessions).length / 4) * 0.13e-6 + 2 * 14_000 * 0.05e-6);
  const expected = perQ.reduce((s, x) => s + x, 0);
  return { questions: questions.length, expected_usd: expected, worst_usd: expected * 1.3, per_question_usd: expected / Math.max(1, questions.length) };
}

async function cmdFreeze(a: Args) {
  const smoke = a.flag('--smoke');
  const { manifest, sha: msha } = study();
  const g = await gbrain(a);
  const ds = loadDataset(resolve(a.need('--dataset')));
  const suite = suiteOf(manifest, ds.sha);
  if (!suite && !smoke) throw new Stop('dataset_not_in_manifest', `dataset sha256 ${ds.sha.slice(0, 12)} is neither LongMemEval-S nor the synthetic suite`);
  preflight(g, manifest, null, { datasetSha: null, keys: ['OPENAI_API_KEY', 'VOYAGE_API_KEY'], smoke, needsPrereg: false });
  let ids = a.list('--ids') ?? ds.questions.map(q => q.question_id);
  const shard = a.get('--shard');
  if (shard) { const [k, n] = shard.split('/').map(Number); if (!(n > 0 && k >= 0 && k < n)) throw new Error('--shard must be k/n with 0 <= k < n'); ids = ids.filter((_, i) => i % n === k); }
  ids = ids.slice(0, a.num('--limit', ids.length));
  const byId = new Map(ds.questions.map(q => [q.question_id, q]));
  const selected = ids.map(id => { const q = byId.get(id); if (!q) throw new Error(`unknown question ${id}`); return q; });
  const outDir = resolve(a.need('--out-dir'));
  const estimate = freezeEstimate(selected);
  const { run, guard } = laneRun(a, manifest, `external-ideas-wave-a-freeze${smoke ? '-smoke' : ''}`, estimate);
  const brain = await g.harness.createBenchmarkBrain();
  const timezone = await brain.getConfig('brain.timezone');
  await brain.disconnect();
  const t0 = performance.now();
  try {
    const inputs: FreezeInput[] = selected.map(q => ({ question: q as unknown as FreezeInput['question'], set: 'confirmatory' }));
    const res = await freeze({ g, manifest: manifest as never, manifestSha: msha, outDir, inputs, embedCachePath: resolve(a.get('--embed-cache') ?? join(REPO_ROOT, 'eval/reports/longmemeval/embed-cache/external-ideas-wave-a.sqlite')), datasetSha: ds.sha, smoke, log });
    const seconds = (performance.now() - t0) / 1000;
    const cost = receiptCost(run.close({ finish: true }));
    const identity = gbrainIdentity(g.dir);
    const codeSha = Object.fromEntries(Object.keys(manifest.pinned_code_sha256).map(f => [f, fileSha(join(g.dir, f))]));
    const path = join(outDir, 'run-manifest.json');
    const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    if (prior && (prior.gbrain.commit !== identity.commit || JSON.stringify(prior.pinned_code_sha256) !== JSON.stringify(codeSha) || prior.brain_timezone !== timezone)) throw new Error(`${path} was written under another gbrain commit, code hashes or brain.timezone`);
    const runs = [...(prior?.freeze_runs ?? []), { at: new Date().toISOString(), selected: selected.length, frozen: res.frozen, skipped: res.skipped, errors: res.errors, seconds: Number(seconds.toFixed(1)), seconds_per_frozen_question: res.frozen ? Number((seconds / res.frozen).toFixed(2)) : null, estimate, cost }];
    writeJson(path, {
      schema: 'gbrain-evals/external-ideas-wave-a-run-manifest/v1', study_manifest_sha256: msha, suite: suite ?? 'smoke', smoke, dataset_sha256: ds.sha,
      gbrain: { commit: identity.commit, tree: identity.tree, version: identity.version, evidence_code_sha256: identity.evidence_code_sha256 },
      pinned_code_sha256: codeSha, pinned_code_matches_manifest: Object.entries(manifest.pinned_code_sha256).every(([f, s]) => codeSha[f] === s),
      brain_timezone: timezone, brain_timezone_note: timezone ? 'brain.timezone is set on the benchmark brain' : 'brain.timezone unset: observation days are UTC calendar days',
      arms: Object.fromEntries(manifest.arms.map(x => [x.id, { unit: x.unit, budget_tokens: x.budget_tokens, config: x.config ?? null }])), evals_commit: evalsCommit(), freeze_runs: runs,
    });
    out({ frozen: res.frozen, skipped: res.skipped, errors: res.errors.length, seconds: Number(seconds.toFixed(1)), seconds_per_frozen_question: runs.at(-1).seconds_per_frozen_question, cost });
    if (res.errors.length) process.exitCode = 1;
  } finally { guard.uninstall(); }
}

// ─── affected ───────────────────────────────────────────────────────

function datasetFor(a: Args, header: FrozenHeader) {
  const ds = loadDataset(resolve(a.need('--dataset')));
  if (ds.sha !== header.dataset_sha256) throw new Refused([{ code: 'dataset_sha_mismatch', message: `--dataset hashes to ${ds.sha.slice(0, 12)}, the frozen evidence used ${header.dataset_sha256.slice(0, 12)}`, fix: `pass the dataset whose sha256 is ${header.dataset_sha256}` }]);
  return { sha: ds.sha, map: new Map(ds.questions.map(q => [q.question_id, q as QuestionText])) };
}

async function cmdAffected(a: Args) {
  const { manifest } = study();
  const dir = resolve(a.need('--frozen-dir'));
  const frozen = readFrozen(dir);
  const g = await gbrain(a);
  const ds = datasetFor(a, frozen.header);
  preflight(g, manifest, frozen.header, { datasetSha: ds.sha, keys: [], smoke: true, needsPrereg: false });
  const report = computeAffected([...frozen.questions.values()], frozen.store, rendererFrom(g), ds.map, frozen.sha256, frozen.header.gbrain.commit);
  writeJson(join(dir, AFFECTED_FILE), report);
  out({ questions: report.questions, affected: report.affected, by_type: report.by_type, relative_dates: report.relative_dates, out: join(dir, AFFECTED_FILE) });
}

function readAffected(dir: string, frozenSha: string): AffectedReport {
  const path = join(dir, AFFECTED_FILE);
  const fix = `bun eval/runner/external-ideas-wave-a.ts affected --frozen-dir ${dir} --dataset <json>`;
  if (!existsSync(path)) throw new Refused([{ code: 'affected_missing', message: `no ${AFFECTED_FILE} in ${dir}`, fix }]);
  const report = JSON.parse(readFileSync(path, 'utf8')) as AffectedReport;
  if (report.frozen_manifest_sha256 !== frozenSha) throw new Refused([{ code: 'affected_stale', message: `${AFFECTED_FILE} was computed for frozen manifest ${report.frozen_manifest_sha256.slice(0, 12)}, not ${frozenSha.slice(0, 12)}`, fix }]);
  return report;
}

// ─── answer ─────────────────────────────────────────────────────────

/** Expected and worst-case dollars for one answer cell at batch prices, from cl100k counts of its request text. */
export function cellEstimate(model: string, texts: Array<{ system: string; user: string }>, maxOutputTokens: number, count: (s: string) => number, pilot = 10) {
  const provider = MODEL_SETTINGS[model].provider;
  const price = chatPrice(`${provider}:${model}`);
  if (!price) throw new Error(`no price for ${model}`);
  const inTok = texts.map(t => (count(t.system) + count(t.user)) * TOKENIZER_RATIO[provider]);
  const factor = (k: number) => (k < pilot ? 1 : BATCH_FACTOR);
  const expected = inTok.reduce((s, x, k) => s + (x * price.input + (EXPECTED_OUTPUT_TOKENS[model] ?? 300) * price.output) / 1e6 * factor(k) + JUDGE_USD_PER_ROW, 0);
  const worst = inTok.reduce((s, x, k) => s + (x * price.input + maxOutputTokens * price.output) / 1e6 * factor(k) + JUDGE_USD_PER_ROW * 2, 0);
  return { requests: texts.length, mean_input_tokens: Math.round(inTok.reduce((s, x) => s + x, 0) / Math.max(1, texts.length)), expected_usd: expected, worst_usd: worst };
}

function judgeIdentity(g: GbrainModules) {
  return {
    primary: 'official_correct',
    official_correct: { model: 'gpt-4o-2024-08-06', prompt: JUDGE_PROTOCOL.name, prompt_sha256: JUDGE_PROTOCOL.sha256, temperature: 0, max_tokens: 10 },
    framed_correct: { model: 'openai:gpt-4o', prompt: 'gbrain judgeRow', prompt_version: (g.judge as unknown as { JUDGE_PROMPT_VERSION?: string }).JUDGE_PROMPT_VERSION ?? null, report_only: true },
  };
}

function makeJudge(g: GbrainModules, ds: Map<string, QuestionText>) {
  return async (qid: string, hypothesis: string): Promise<JudgeVerdicts> => {
    const d = ds.get(qid)!;
    const jq = { question_id: qid, question_type: d.question_type, question: d.question, answer: d.answer };
    const guarded = async <T>(p: Promise<T>, field: string): Promise<Record<string, unknown>> => {
      try { return (await p) as Record<string, unknown>; }
      catch (e) { if (e instanceof BudgetExceededError) throw e; return { [field]: String((e as Error)?.message ?? e).slice(0, 300) }; }
    };
    const [o, f] = await Promise.all([guarded(officialJudge(jq, hypothesis), 'off_judge_error'), guarded(gbrainJudge(g, jq, hypothesis), 'judge_error')]);
    return verdicts(o, f);
  };
}

async function cmdAnswer(a: Args) {
  const smoke = a.flag('--smoke');
  const { manifest, sha: msha } = study();
  const arm = a.need('--arm') as Arm;
  if (!ARMS.includes(arm)) throw new Error(`--arm must be ${ARMS.join(' or ')}`);
  const sample = Number(a.need('--sample'));
  if (!Number.isInteger(sample) || sample < 1 || sample > manifest.analysis.samples) throw new Error(`--sample must be 1..${manifest.analysis.samples}`);
  const model = modelKey(a.need('--model'));
  const set = (a.get('--set') ?? 'all') as 'all' | 'affected';
  if (set !== 'all' && set !== 'affected') throw new Error('--set must be all or affected');
  const settings = manifest.reader.settings[model];
  if (!settings) throw new Stop('model_not_in_manifest', `${model} has no reader settings in the study manifest`);
  if (MODEL_SETTINGS[model].effort !== settings.effort) throw new Error(`${model}: the batch lane's effort ${MODEL_SETTINGS[model].effort} differs from the manifest's ${settings.effort}`);
  const provider = MODEL_SETTINGS[model].provider;
  const frozenDir = resolve(a.need('--frozen-dir'));
  const frozen = readFrozen(frozenDir);
  const g = await gbrain(a);
  const ds = datasetFor(a, frozen.header);
  const attestation = preflight(g, manifest, frozen.header, { datasetSha: ds.sha, keys: [provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY', 'OPENAI_API_KEY'], smoke, needsPrereg: true });
  const affected = readAffected(frozenDir, frozen.sha256);
  const affectedById = new Map(affected.rows.map(r => [r.question_id, r]));
  const renderer = rendererFrom(g);
  const expected = new Map<string, string>(), meta = new Map<string, QuestionMeta>(), allBodies = new Map<string, Record<string, unknown>>(), texts = new Map<string, { system: string; user: string }>();
  for (const q of frozen.questions.values()) {
    const d = ds.map.get(q.question_id)!;
    const t = readerText(q, arm, frozen.store, renderer, d);
    if (affectedById.get(q.question_id)?.reader_request_sha256[arm] !== t.reader_request_sha256) throw new Refused([{ code: 'affected_stale', message: `${q.question_id}: the ${arm} request differs from ${AFFECTED_FILE}`, fix: `rerun affected --frozen-dir ${frozenDir}` }]);
    const body = readerBody(model, { system: t.system, user: t.user }, settings.max_output_tokens, settings.max_output_tokens);
    allBodies.set(q.question_id, body);
    texts.set(q.question_id, { system: t.system, user: t.user });
    expected.set(q.question_id, bodySha(body));
    meta.set(q.question_id, { question_type: affectedById.get(q.question_id)!.question_type, reader_request_sha256: t.reader_request_sha256, evidence_sha256: t.evidence_sha256, product_fingerprint: t.product_fingerprint });
  }
  const ids = [...frozen.questions.keys()].filter(id => set === 'all' || affectedById.get(id)!.affected).sort();
  if (!ids.length) { out({ note: 'no questions in this set', set }); return; }
  const armId = `${arm}-${set}-s${sample}-${model}`;
  const outDir = resolve(a.need('--out-dir'));
  const bodies = new Map(ids.map(id => [id, allBodies.get(id)!]));
  const armManifest = freezeManifest(join(outDir, 'manifests', `${armId}.json`), buildManifest({
    arm_id: armId, workstream: 'GBRA-162-wave-a', kind: 'reader', provider, model, max_output_tokens: settings.max_output_tokens, reasoning_effort: settings.effort,
    protocol: { name: 'gbrain-lme-reader-v4-notes-fullsessions', sha256: sha256(renderer.system) },
    source: `frozen ${arm} evidence (${frozen.sha256.slice(0, 12)}) at gbrain ${frozen.header.gbrain.commit.slice(0, 12)}, house notes reader, ${set} questions`,
    denominator: bodies.size, bodies, outputFloor: settings.max_output_tokens,
  }));
  const estimate = cellEstimate(model, ids.map(id => texts.get(id)!), settings.max_output_tokens, g.tokens.estimateTokens);
  const { run, guard } = laneRun(a, manifest, `external-ideas-wave-a-answer${smoke ? '-smoke' : ''}`, estimate, join(outDir, 'runs', `${armId}.json`));
  const lane = new BatchLane({ statePath: join(outDir, 'batch-state.sqlite'), transports: { openai: openAiTransport(), anthropic: anthropicTransport() }, run, parallel: true, log });
  const identity = {
    gbrain_commit: frozen.header.gbrain.commit, gbrain_tree: frozen.header.gbrain.tree, evals_commit: evalsCommit(), frozen_manifest_sha256: frozen.sha256, study_manifest_sha256: msha,
    dataset_sha256: ds.sha, smoke, preregistration: attestation, judges: judgeIdentity(g), reader: { model, provider, max_output_tokens: settings.max_output_tokens, effort: settings.effort, system_sha256: sha256(renderer.system), transport: 'batch' },
  };
  const rowsFile = rowsPath(outDir, { arm, sample, model });
  let step: StepResult;
  let done = false;
  let factor: ReturnType<BatchLane['factorFor']> | null = null;
  try {
    for (;;) {
      step = await answerStep({
        lane, manifest: armManifest, bodies, meta, expected, cell: { arm, sample, model }, set, rowsFile, identity, judge: makeJudge(g, ds.map),
        retry: a.flag('--retry'), judgeOnly: a.flag('--judge-only'), listPrice: a.flag('--list-price'), log,
        onPlan: p => log(`PREFLIGHT batch ${armId}: ${p.ids} requests${p.pilot ? ' (pilot at list price)' : ''}, ${p.input_tokens} counted input tokens, worst case $${p.reserve_usd.toFixed(2)}`),
      });
      log(`[answer] ${armId}: wrote ${step.written} rows (${step.rejudged} re-judged), open batches ${step.open}${step.submitted ? `, submitted ${step.submitted.requests} as ${step.submitted.batch_id}` : ''}`);
      done = step.done;
      if (done || !a.flag('--wait')) break;
      await new Promise(r => setTimeout(r, a.num('--poll-seconds', 30) * 1000));
    }
  } finally {
    factor = lane.factorFor(provider, model);
    guard.uninstall();
    lane.close();
  }
  const summary = run.close({ finish: done });
  const latest = latestRows(readRows(rowsFile));
  const failures: Record<string, number> = {};
  for (const id of ids) {
    const r = latest.get(id);
    const kind = !r ? 'not_answered' : r.reader_error ?? (r.official_correct === null ? 'official_judge_error' : r.framed_correct === null ? 'framed_judge_error' : null);
    if (kind) failures[kind] = (failures[kind] ?? 0) + 1;
  }
  const rows = ids.map(id => latest.get(id)).filter(Boolean) as AnswerRow[];
  const usage = (k: string) => rows.reduce((s, r) => s + Number((r.usage as Record<string, unknown> | null)?.[k] ?? 0), 0);
  const receipt = {
    cell: armId, done, questions: ids.length, rows: rows.length, failures, official_correct: rows.filter(r => r.official_correct === 1).length, framed_correct: rows.filter(r => r.framed_correct === 1).length,
    reader_usage: { input_tokens: usage('input_tokens') + usage('prompt_tokens'), output_tokens: usage('output_tokens') + usage('completion_tokens'), batch_usd: rows.reduce((s, r) => s + r.usd, 0), list_usd: rows.reduce((s, r) => s + r.list_usd, 0) },
    estimate, cost: receiptCost(summary), batch_factor: factor && { factor: factor.factor, confirmed: factor.confirmed },
  };
  writeJson(join(outDir, 'receipts', `${armId}.json`), receipt);
  out(receipt);
  if (done && Object.keys(failures).length) process.exitCode = 1;
}

// ─── analyze and verdict ────────────────────────────────────────────

async function cmdAnalyze(a: Args) {
  const { manifest } = study();
  const rowsDir = resolve(a.need('--rows-dir'));
  const frozenDir = resolve(a.need('--frozen-dir'));
  const frozen = readFrozen(frozenDir);
  const affected = readAffected(frozenDir, frozen.sha256);
  const dir = join(rowsDir, 'rows');
  const rows = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.ndjson')).sort().flatMap(f => readRows(join(dir, f))) : [];
  const models = [...new Set(rows.map(r => r.model))];
  const model = a.get('--model') ? modelKey(a.get('--model')!) : models.length === 1 ? models[0] : null;
  if (!model) throw new Error(`pass --model (rows hold ${models.join(', ') || 'no models'})`);
  const observed = [...new Set(rows.filter(r => r.model === model && r.arm === 'auto').map(r => r.sample))].sort();
  const samples = a.list('--samples')?.map(Number) ?? (frozen.header.smoke ? (observed.length ? observed : [1]) : Array.from({ length: manifest.analysis.samples }, (_, i) => i + 1));
  const suite = frozen.header.smoke ? 'smoke' : suiteOf(manifest, frozen.header.dataset_sha256) ?? 'smoke';
  const scope = (a.get('--scope') ?? 'all') as 'all' | 'affected';
  if (scope !== 'all' && scope !== 'affected') throw new Error('--scope is all or affected');
  const result = analyze({ rows, affected, model, samples, seed: manifest.analysis.seed, draws: manifest.analysis.sign_flip_draws, alpha: manifest.analysis.alpha, suite, scope });
  const prefix = a.get('--out') ?? join(rowsDir, `analysis-${suite}-${model}${scope === 'affected' ? '-affected' : ''}`);
  writeJson(`${prefix}.json`, result);
  writeFileSync(`${prefix}.md`, analysisMarkdown(result));
  const { per_question: _pq, ...summary } = result;
  out(summary);
  if (!result.complete) process.exitCode = 1;
}

async function cmdVerdict(a: Args) {
  const read = <T>(path: string) => JSON.parse(readFileSync(resolve(path), 'utf8')) as T;
  const lme = read<Analysis>(a.need('--longmemeval')), syn = read<Analysis>(a.need('--synthetic'));
  const secondaries = (a.list('--secondary') ?? []).map(p => read<Analysis>(p));
  const audit = a.get('--audit') ? read<AuditSummary>(a.get('--audit')!) : null;
  const row = (x: Analysis) => ({ suite: x.suite, scope: x.scope, model: x.model, verdict: x.verdict, complete: x.complete, questions: x.questions, affected: x.affected, net_gain: x.primary.net_gain, ci95_net_gain: x.primary.ci95_net_gain, lower_bound_one_sided_net_gain: x.primary.lower_bound_one_sided_net_gain, p_one_sided: x.primary.p_one_sided_greater, p_one_sided_less: x.primary.p_one_sided_less });
  const report = {
    schema: 'gbrain-evals/external-ideas-wave-a-verdict/v2', rule: 'preregistration plus the 2026-10-21 amendment (secondary models gate against harm)',
    longmemeval: row(lme), synthetic: row(syn), secondary: secondaries.map(row),
    ...flipVerdict({ longmemeval: lme, synthetic: syn, secondaries, audit }),
  };
  if (a.get('--out')) writeJson(resolve(a.get('--out')!), report);
  out(report);
  out(['| Suite | Model | Scope | Verdict | Questions | Affected | Net gain | 95% CI | One-sided p (gain) | One-sided p (loss) |', '|---|---|---|---|---|---|---|---|---|---|',
    ...[report.longmemeval, report.synthetic, ...report.secondary].map(r => `| ${r.suite} | ${r.model} | ${r.scope} | ${r.verdict} | ${r.questions} | ${r.affected} | ${r.net_gain.toFixed(1)} | ${r.ci95_net_gain ? r.ci95_net_gain.map(x => x.toFixed(1)).join(' to ') : 'n/a'} | ${r.p_one_sided.toFixed(4)} | ${r.p_one_sided_less.toFixed(4)} |`)].join('\n'));
  if (![lme, syn, ...secondaries].every(x => x.complete)) process.exitCode = 1;
}

// ─── audit ──────────────────────────────────────────────────────────

async function cmdAudit(a: Args) {
  const smoke = a.flag('--smoke');
  const { manifest } = study();
  const frozenDir = resolve(a.need('--frozen-dir'));
  const frozen = readFrozen(frozenDir);
  const g = await gbrain(a);
  const attestation = preflight(g, manifest, frozen.header, { datasetSha: null, keys: ['ANTHROPIC_API_KEY'], smoke, needsPrereg: true });
  const modelId = a.get('--model') ?? manifest.audit.model;
  if (!modelId.startsWith('anthropic:')) throw new Error('the audit judge is an Anthropic model (anthropic:<model>)');
  const model = modelId.slice('anthropic:'.length);
  const seed = a.num('--seed', manifest.audit.seed);
  const { items, unaligned_blocks } = auditCandidates([...frozen.questions.values()], frozen.store, manifest.audit.context_chars);
  const n = Math.min(a.num('--n', manifest.audit.n), items.length);
  const chosen = new Set(n ? seededSample(items.map(i => i.key), n, seed) : []);
  const sample = items.filter(i => chosen.has(i.key));
  const price = chatPrice(`anthropic:${model}`);
  if (!price) throw new Error(`no price for ${model}`);
  const estimate = { expected_usd: sample.length * (500 * price.input + 300 * price.output) / 1e6, worst_usd: sample.length * (600 * price.input + 2048 * price.output) / 1e6 };
  const { run, guard } = laneRun(a, manifest, `external-ideas-wave-a-audit${smoke ? '-smoke' : ''}`, estimate);
  const results: Array<typeof sample[number] & { verdict: string | null; raw: string; error?: string }> = [];
  try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, sample.length) }, async () => {
      while (next < sample.length) {
        const item = sample[next++];
        try {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: 2048, output_config: { effort: 'low' }, messages: [{ role: 'user', content: auditPrompt(item) }] }),
          });
          const body = await res.json() as { content?: Array<{ type: string; text?: string }>; error?: unknown };
          if (!res.ok) throw new Error(`http ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
          const raw = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
          results.push({ ...item, verdict: auditVerdict(raw), raw: raw.slice(0, 200) });
        } catch (e) {
          if (e instanceof BudgetExceededError) throw e;
          results.push({ ...item, verdict: null, raw: '', error: String((e as Error).message).slice(0, 300) });
        }
      }
    }));
  } finally { guard.uninstall(); }
  const count = (v: string | null) => results.filter(r => r.verdict === v).length;
  const rate = (k: number) => (results.length ? k / results.length : 0);
  const report = {
    schema: 'gbrain-evals/external-ideas-wave-a-audit/v1', frozen_manifest_sha256: frozen.sha256, gbrain_commit: frozen.header.gbrain.commit, smoke, preregistration: attestation,
    judge: { model: modelId, effort: 'low', prompt_sha256: sha256(auditPrompt({ key: '', question_id: '', slug: '', session_date: '{date}', bracket: '{bracket}', context: '{context}' })) },
    insertions_available: items.length, unaligned_blocks, n: results.length, seed,
    counts: { correct: count('correct'), wrong: count('wrong'), ambiguous: count('ambiguous'), unparsed_or_error: count(null) },
    rates: { correct: rate(count('correct')), wrong: rate(count('wrong')), ambiguous: rate(count('ambiguous')) },
    complete: count(null) === 0, cost: receiptCost(run.close({ finish: true })), items: results.sort((x, y) => (x.key < y.key ? -1 : 1)),
  };
  writeJson(a.get('--out') ?? join(frozenDir, 'audit.json'), report);
  const { items: _items, ...summary } = report;
  out(summary);
  if (!report.complete) process.exitCode = 1;
}

// ─── estimate ───────────────────────────────────────────────────────

async function cmdEstimate(a: Args) {
  const { manifest } = study();
  const ds = loadDataset(resolve(a.need('--dataset')));
  const N = a.num('--questions', ds.questions.length);
  const report: Record<string, unknown> = { dataset_sha256: ds.sha, questions: N, freeze: freezeEstimate(ds.questions.slice(0, N)) };
  if (a.get('--frozen-dir')) {
    const frozenDir = resolve(a.get('--frozen-dir')!);
    const frozen = readFrozen(frozenDir);
    const affected = readAffected(frozenDir, frozen.sha256);
    const g = await gbrain(a);
    const renderer = rendererFrom(g);
    const dsMap = new Map(ds.questions.map(q => [q.question_id, q as QuestionText]));
    const fraction = affected.affected / Math.max(1, affected.questions);
    const samples = a.num('--samples', manifest.analysis.samples);
    const models = (a.list('--models') ?? Object.keys(manifest.reader.settings)).map(modelKey);
    const perModel: Record<string, unknown> = {};
    for (const model of models) {
      const s = manifest.reader.settings[model];
      const cell = (arm: Arm, ids: string[]) => cellEstimate(model, ids.map(id => { const t = readerText(frozen.questions.get(id)!, arm, frozen.store, renderer, dsMap.get(id)!); return { system: t.system, user: t.user }; }), s.max_output_tokens, g.tokens.estimateTokens, 0);
      const all = [...frozen.questions.keys()];
      const aff = affected.rows.filter(r => r.affected).map(r => r.question_id);
      const base = cell('auto', all), dates = aff.length ? cell('auto_dates', aff) : null;
      const scale = (x: { expected_usd: number; worst_usd: number }, k: number, n: number) => ({ expected_usd: Number((x.expected_usd / Math.max(1, k) * n).toFixed(2)), worst_usd: Number((x.worst_usd / Math.max(1, k) * n).toFixed(2)) });
      const autoRun = scale(base, all.length, N);
      const datesRun = dates ? scale(dates, aff.length, Math.round(N * fraction)) : { expected_usd: 0, worst_usd: 0 };
      perModel[model] = {
        mean_input_tokens: base.mean_input_tokens, per_sample: { auto_all: autoRun, auto_dates_affected: datesRun, auto_dates_all: scale(dates ?? base, dates ? aff.length : all.length, N) },
        affected_run_total: { samples, expected_usd: Number(((autoRun.expected_usd + datesRun.expected_usd) * samples).toFixed(2)), worst_usd: Number(((autoRun.worst_usd + datesRun.worst_usd) * samples).toFixed(2)) },
      };
    }
    Object.assign(report, { affected_fraction: fraction, frozen_questions: affected.questions, models: perModel, basis: 'batch price (50% of list) after a 10-request pilot at list; expected output tokens from the W10 receipts; judges synchronous at list' });
  }
  out(report);
}

const COMMANDS: Record<string, (a: Args) => Promise<void>> = { freeze: cmdFreeze, affected: cmdAffected, answer: cmdAnswer, analyze: cmdAnalyze, verdict: cmdVerdict, audit: cmdAudit, estimate: cmdEstimate };

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[cmd];
  if (!fn) { process.stderr.write(`usage: bun eval/runner/external-ideas-wave-a.ts <${Object.keys(COMMANDS).join('|')}> ...\n`); process.exit(2); }
  fn(new Args(rest)).then(() => process.exit(process.exitCode ?? 0)).catch(e => {
    if (e instanceof Refused) { for (const p of e.problems) process.stderr.write(`PREFLIGHT ${p.code}: ${p.message}\n  fix: ${p.fix}\n`); process.exit(2); }
    if (e instanceof BudgetExceededError || (e instanceof Stop && e.reason === 'budget_exhausted')) { process.stderr.write(`STOP: reason=budget_exhausted detail=${JSON.stringify(e.message)}\n`); process.exit(4); }
    if (e instanceof Stop) { process.stderr.write(`STOP: reason=${e.reason} detail=${JSON.stringify(e.message)}${e.fix ? `\n  fix: ${e.fix}` : ''}\n`); process.exit(e.reason === 'budget_required' || e.reason === 'run_over_approval_limit' || e.reason === 'estimate_over_cap' ? 2 : 4); }
    process.stderr.write(`[external-ideas-wave-a] FATAL: ${e?.message ?? e}\n${e?.stack ?? ''}\n`);
    process.exit(1);
  });
}
