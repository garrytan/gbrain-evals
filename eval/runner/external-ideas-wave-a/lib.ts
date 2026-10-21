/**
 * Pure building blocks of the external-ideas wave A runner (GBRA-162): the
 * study manifest, reader request bodies, the affected set, answer rows and
 * their cell identity, the analysis, the bracket audit's insertion finder and
 * the keyless preflight. Nothing here makes a network call.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRequest, requestSha, sessionBlocks, type Renderer } from '../evidence-delivery/arms.ts';
import { REPO_ROOT, sha256 } from '../evidence-delivery/data.ts';
import type { BlobStore, FrozenHeader, FrozenQuestion } from '../evidence-delivery/store.ts';
import { MODEL_SETTINGS } from '../batch/manifest.ts';
import { clusteredPairedDelta } from '../stats/paired.ts';

export const STUDY_REL = 'docs/benchmarks/2026-10-21-external-ideas-wave-a';
export const STUDY_MANIFEST_REL = `${STUDY_REL}/study-manifest.json`;
export const PREREG_REL = 'docs/benchmarks/2026-10-21-external-ideas-wave-a-preregistration.md';
export const ARMS = ['auto', 'auto_dates'] as const;
export type Arm = typeof ARMS[number];
export const AFFECTED_FILE = 'affected.json';

export interface StudyManifest {
  schema: string;
  id: string;
  candidate_commits: { gbrain: string | null; gbrain_branch: string; gbrain_repository: string };
  /** sha256 of the date-resolution code at the pinned commit; the shipped files must hash-match. */
  pinned_code_sha256: Record<string, string>;
  data: { longmemeval_s: { file: string; sha256: string; questions: number }; synthetic: { path: string; sha256: string; questions: number } };
  retrieval: { mode: string };
  arms: Array<{ id: string; role: string; source: 'product'; unit: 'auto'; blocks: 'per_page'; budget_tokens: null; config?: Record<string, string>; sets: string[] }>;
  reader: { system: string; system_sha256: string; max_session_chars: number; settings: Record<string, { max_output_tokens: number; effort: string }> };
  judges: { primary: 'official_correct'; official_correct: string; framed_correct: string };
  analysis: { seed: number; sign_flip_draws: number; bootstrap_draws: number; alpha: number; samples: number };
  audit: { n: number; seed: number; model: string; context_chars: number };
  budget: { lane_cap_usd: number; single_run_approval_usd: number };
}

export function loadStudyManifest(root = REPO_ROOT): { manifest: StudyManifest; sha256: string } {
  const bytes = readFileSync(join(root, STUDY_MANIFEST_REL));
  return { manifest: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}

/** Manifest problems; an empty list means the two-arm design holds. */
export function validateStudyManifest(m: StudyManifest): string[] {
  const p: string[] = [];
  const ids = m.arms.map(a => a.id);
  if (JSON.stringify(ids) !== JSON.stringify(ARMS)) p.push(`arms must be exactly ${ARMS.join(', ')}`);
  for (const a of m.arms) if (a.source !== 'product' || a.unit !== 'auto' || a.budget_tokens !== null) p.push(`${a.id} must be a product arm, unit auto, budget null`);
  if (m.arms[0]?.config) p.push('auto carries no config');
  if (JSON.stringify(m.arms[1]?.config) !== JSON.stringify({ 'search.evidence_resolve_dates': 'true' })) p.push('auto_dates sets exactly search.evidence_resolve_dates=true');
  if (m.judges.primary !== 'official_correct') p.push('the primary judge is official_correct');
  if (m.candidate_commits.gbrain !== null && !/^[0-9a-f]{40}$/.test(m.candidate_commits.gbrain)) p.push('candidate_commits.gbrain must be null or a 40-hex commit');
  return p;
}

// ─── Reader requests ────────────────────────────────────────────────

/** Gateway id (anthropic:claude-sonnet-5-5) to the batch lane's model key (claude-sonnet-5-5). */
export function modelKey(model: string): string {
  const key = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
  if (!MODEL_SETTINGS[key]) throw new Error(`no batch reader settings for ${model}; known: ${Object.keys(MODEL_SETTINGS).join(', ')}`);
  return key;
}

export interface QuestionText { question: string; question_date: string; question_type: string; answer: string | number }

/** The house notes reader's system and user text for one arm, built only from frozen evidence. */
export function readerText(q: FrozenQuestion, arm: Arm, store: Pick<BlobStore, 'get'>, renderer: Renderer, d: QuestionText) {
  const frozenArm = q.arms[arm];
  if (!frozenArm) throw new Error(`${q.question_id} has no frozen evidence for ${arm}`);
  const built = buildRequest(renderer, { question: d.question, question_date: d.question_date }, sessionBlocks(q, frozenArm.blocks, store, renderer), 'reader', 0);
  return {
    system: built.request.system, user: built.request.messages[0].content, truncated: built.truncated,
    reader_request_sha256: requestSha(built.request), evidence_sha256: frozenArm.evidence_sha256, product_fingerprint: frozenArm.product_fingerprint ?? null,
    insertions: Number((frozenArm.delivery as { relative_dates?: { insertions?: number } } | undefined)?.relative_dates?.insertions ?? 0),
  };
}

// ─── Affected set ───────────────────────────────────────────────────

export interface AffectedRow { question_id: string; question_type: string; affected: boolean; insertions: number; reader_request_sha256: Record<Arm, string>; evidence_sha256: Record<Arm, string> }
export interface AffectedReport {
  schema: 'gbrain-evals/external-ideas-wave-a-affected/v1';
  frozen_manifest_sha256: string;
  gbrain_commit: string;
  reader_system_sha256: string;
  questions: number;
  affected: number;
  by_type: Record<string, { questions: number; affected: number }>;
  /** From the frozen auto_dates deliveries: brackets inserted, and the fallbacks that left a delivery unannotated. */
  relative_dates: { insertions_total: number; questions_with_insertions: number; fallbacks: Record<string, number> };
  rows: AffectedRow[];
}

export const reportType = (id: string, type: string) => (id.endsWith('_abs') ? 'abstention' : type);

/** A question is affected when its two arms' reader requests differ; an unaffected one reuses auto's verdict. */
export function computeAffected(questions: FrozenQuestion[], store: Pick<BlobStore, 'get'>, renderer: Renderer, dataset: Map<string, QuestionText>, frozenSha: string, gbrainCommit: string): AffectedReport {
  const rows: AffectedRow[] = [];
  for (const q of [...questions].sort((a, b) => (a.question_id < b.question_id ? -1 : 1))) {
    const d = dataset.get(q.question_id);
    if (!d) throw new Error(`${q.question_id} is frozen but not in the dataset`);
    const a = readerText(q, 'auto', store, renderer, d), b = readerText(q, 'auto_dates', store, renderer, d);
    rows.push({
      question_id: q.question_id, question_type: reportType(q.question_id, d.question_type), affected: a.reader_request_sha256 !== b.reader_request_sha256, insertions: b.insertions,
      reader_request_sha256: { auto: a.reader_request_sha256, auto_dates: b.reader_request_sha256 }, evidence_sha256: { auto: a.evidence_sha256, auto_dates: b.evidence_sha256 },
    });
  }
  const byType: AffectedReport['by_type'] = {};
  for (const r of rows) { const t = (byType[r.question_type] ??= { questions: 0, affected: 0 }); t.questions++; if (r.affected) t.affected++; }
  const fallbacks: Record<string, number> = { relative_dates_over_budget: 0, relative_dates_unavailable: 0 };
  for (const q of questions) for (const f of ((q.arms.auto_dates?.delivery as { fallbacks?: string[] } | undefined)?.fallbacks ?? [])) if (f.startsWith('relative_dates')) fallbacks[f] = (fallbacks[f] ?? 0) + 1;
  return {
    schema: 'gbrain-evals/external-ideas-wave-a-affected/v1', frozen_manifest_sha256: frozenSha, gbrain_commit: gbrainCommit, reader_system_sha256: sha256(renderer.system),
    questions: rows.length, affected: rows.filter(r => r.affected).length, by_type: byType,
    relative_dates: { insertions_total: rows.reduce((s, r) => s + r.insertions, 0), questions_with_insertions: rows.filter(r => r.insertions > 0).length, fallbacks }, rows,
  };
}

// ─── Answer rows ────────────────────────────────────────────────────

export interface Cell { arm: Arm; sample: number; model: string }
export const cellName = (c: Cell) => `${c.arm}__s${c.sample}__${c.model}`;
export const rowsPath = (dir: string, c: Cell) => join(dir, 'rows', `${cellName(c)}.ndjson`);

export interface JudgeVerdicts {
  official_correct: 0 | 1 | null;
  official: Record<string, unknown>;
  framed_correct: 0 | 1 | null;
  framed: Record<string, unknown>;
}

export interface AnswerRow extends JudgeVerdicts {
  schema: 'gbrain-evals/external-ideas-wave-a-row/v1';
  question_id: string;
  question_type: string;
  arm: Arm;
  sample: number;
  model: string;
  set: 'all' | 'affected';
  /** sha256 of the exact batch request body sent; with arm, sample and model it is the cell identity. */
  request_sha256: string;
  reader_request_sha256: string;
  evidence_sha256: string;
  product_fingerprint: string | null;
  batch: { arm_id: string; intent_id: string | null; status: string | null; finish: string | null; response_model: string | null; service_tier: string | null };
  usage: Record<string, unknown> | null;
  usd: number;
  list_usd: number;
  hypothesis: string;
  reader_error: string | null;
  primary_judge: 'official_correct';
  identity: Record<string, unknown>;
  ts: string;
}

export function readRows(path: string): AnswerRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as AnswerRow);
}

/** The latest row per question (rows are append-only; a later row supersedes an earlier one for the same cell). */
export function latestRows(rows: AnswerRow[]): Map<string, AnswerRow> {
  const out = new Map<string, AnswerRow>();
  for (const r of rows) out.set(r.question_id, r);
  return out;
}

/**
 * Refuse rows that belong to another cell: a different arm, sample or model,
 * or a request body other than the one this frozen evidence builds for the
 * question. Resume never mixes cells.
 */
export function checkRowIdentity(rows: AnswerRow[], cell: Cell, expected: Map<string, string>): void {
  for (const r of rows) {
    if (r.arm !== cell.arm || r.sample !== cell.sample || r.model !== cell.model) throw new Error(`row_identity_mismatch: ${r.question_id} is ${r.arm}/s${r.sample}/${r.model}, this cell is ${cell.arm}/s${cell.sample}/${cell.model}`);
    const want = expected.get(r.question_id);
    if (!want) throw new Error(`row_identity_mismatch: ${r.question_id} is not a question of this frozen manifest`);
    if (r.request_sha256 !== want) throw new Error(`row_identity_mismatch: ${r.question_id} was answered for request ${r.request_sha256.slice(0, 12)}, the frozen evidence builds ${want.slice(0, 12)}; use a new --out-dir`);
  }
}

/** Judge verdicts from the two judges' raw returns (calls.ts officialJudge and gbrainJudge). */
export function verdicts(official: Record<string, unknown> | null, framed: Record<string, unknown> | null): JudgeVerdicts {
  const o = official ?? { off_judge_error: 'not_run' };
  const f = framed ?? { judge_error: 'not_run' };
  return {
    official_correct: typeof o.off_judge_correct === 'boolean' ? (o.off_judge_correct ? 1 : 0) : null, official: o,
    framed_correct: typeof f.judge_correct === 'boolean' ? (f.judge_correct ? 1 : 0) : null, framed: f,
  };
}

/** A row whose reader succeeded but whose judges did not both return a verdict. */
export const needsJudging = (r: AnswerRow) => !r.reader_error && (r.official_correct === null || r.framed_correct === null);

// ─── Analysis ───────────────────────────────────────────────────────

export interface AnalyzeInput {
  rows: AnswerRow[];
  affected: AffectedReport;
  model: string;
  samples: number[];
  seed: number;
  draws: number;
  alpha: number;
  suite: 'longmemeval' | 'synthetic' | 'smoke';
  /** 'affected' scores only the affected questions (the secondary models run nothing else). Defaults to 'all'. */
  scope?: 'all' | 'affected';
}

export interface Failures { complete: boolean; counts: Record<string, number>; examples: Array<{ question_id: string; cell: string; kind: string }> }

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * Per question, an arm's score is the mean of its samples' official verdicts
 * (0, 0.5 or 1). An unaffected question's auto_dates score is auto's (the two
 * requests are byte-identical). Every missing cell, reader failure (batch
 * error, expiry, cancel, missing result, output-limit stop, empty answer) and
 * judge failure is counted, scores 0, and makes the analysis incomplete.
 */
export function analyze(input: AnalyzeInput) {
  const { affected, model, samples } = input;
  const scope = input.scope ?? 'all';
  const failures: Failures = { complete: true, counts: {}, examples: [] };
  const fail = (question_id: string, cell: string, kind: string) => {
    failures.complete = false;
    failures.counts[kind] = (failures.counts[kind] ?? 0) + 1;
    if (failures.examples.length < 20) failures.examples.push({ question_id, cell, kind });
  };
  const cells = new Map<string, Map<string, AnswerRow>>();
  for (const arm of ARMS) for (const s of samples) {
    const c = { arm, sample: s, model };
    cells.set(cellName(c), latestRows(input.rows.filter(r => r.arm === arm && r.sample === s && r.model === model)));
  }
  const verdict = (arm: Arm, s: number, row: AffectedRow, judge: 'official_correct' | 'framed_correct', record: boolean): number => {
    const name = cellName({ arm, sample: s, model });
    const r = cells.get(name)!.get(row.question_id);
    if (!r) { if (record) fail(row.question_id, name, 'missing_cell'); return 0; }
    if (r.reader_error) { if (record) fail(row.question_id, name, r.reader_error); return 0; }
    if (r.official_correct === null && record) fail(row.question_id, name, 'official_judge_error');
    if (r.framed_correct === null && record) fail(row.question_id, name, 'framed_judge_error');
    return r[judge] ?? 0;
  };
  const score = (arm: Arm, row: AffectedRow, judge: 'official_correct' | 'framed_correct', record: boolean) => mean(samples.map(s => verdict(arm, s, row, judge, record)));
  const perQuestion = affected.rows.filter(row => scope === 'all' || row.affected).map(row => {
    const auto = score('auto', row, 'official_correct', true);
    const dates = row.affected ? score('auto_dates', row, 'official_correct', true) : auto;
    const fauto = score('auto', row, 'framed_correct', false);
    const fdates = row.affected ? score('auto_dates', row, 'framed_correct', false) : fauto;
    return { question_id: row.question_id, question_type: row.question_type, affected: row.affected, auto, auto_dates: dates, framed_auto: fauto, framed_auto_dates: fdates };
  });
  const paired = (a: (p: typeof perQuestion[number]) => number, b: (p: typeof perQuestion[number]) => number, subset = perQuestion) => {
    const stats = clusteredPairedDelta(subset.map(p => ({ id: p.question_id, cluster: p.question_id, a: a(p), b: b(p) })), { seed: input.seed, draws: input.draws });
    const n = stats.n_pairs;
    return {
      questions: n, auto: stats.mean_a * n, auto_dates: stats.mean_b * n, net_gain: stats.delta * n, delta_points: stats.delta * 100,
      ci95_net_gain: stats.ci95 ? [stats.ci95[0] * n, stats.ci95[1] * n] : null,
      lower_bound_one_sided_net_gain: stats.bootstrap.length ? stats.bootstrap[Math.floor(stats.bootstrap.length * input.alpha)] * n : null,
      p_one_sided_greater: stats.p_greater, p_one_sided_less: stats.p_less, p_two_sided: stats.p_two_sided, p_method: stats.p_method,
      wins: subset.filter(p => b(p) > a(p)).length, losses: subset.filter(p => b(p) < a(p)).length,
    };
  };
  const primary = paired(p => p.auto, p => p.auto_dates);
  const affectedOnly = perQuestion.filter(p => p.affected);
  const byType: Record<string, { questions: number; affected: number; auto: number; auto_dates: number; net_gain: number }> = {};
  for (const p of perQuestion) {
    const t = (byType[p.question_type] ??= { questions: 0, affected: 0, auto: 0, auto_dates: 0, net_gain: 0 });
    t.questions++; if (p.affected) t.affected++;
    t.auto += p.auto; t.auto_dates += p.auto_dates; t.net_gain += p.auto_dates - p.auto;
  }
  const judged = input.rows.filter(r => r.model === model && !r.reader_error && r.official_correct !== null && r.framed_correct !== null);
  const latestJudged = [...new Map(judged.map(r => [`${r.arm}/${r.sample}/${r.question_id}`, r])).values()];
  const agreement = { rows: latestJudged.length, agree: latestJudged.filter(r => r.official_correct === r.framed_correct).length, official_yes_framed_no: latestJudged.filter(r => r.official_correct === 1 && r.framed_correct === 0).length, official_no_framed_yes: latestJudged.filter(r => r.official_correct === 0 && r.framed_correct === 1).length };
  let noise: { questions: number; discordant: number; rate: number; affected_questions: number; affected_discordant: number } | { note: string };
  if (samples.length >= 2) {
    const [s1, s2] = samples;
    const both = affected.rows.filter(row => scope === 'all' || row.affected).filter(row => [s1, s2].every(s => { const r = cells.get(cellName({ arm: 'auto', sample: s, model }))!.get(row.question_id); return r && !r.reader_error && r.official_correct !== null; }));
    const v = (row: AffectedRow, s: number) => cells.get(cellName({ arm: 'auto', sample: s, model }))!.get(row.question_id)!.official_correct;
    const disc = both.filter(row => v(row, s1) !== v(row, s2));
    noise = { questions: both.length, discordant: disc.length, rate: both.length ? disc.length / both.length : 0, affected_questions: both.filter(r => r.affected).length, affected_discordant: disc.filter(r => r.affected).length };
  } else noise = { note: 'one sample per question: the reader-noise floor needs auto samples 1 and 2' };
  return {
    schema: 'gbrain-evals/external-ideas-wave-a-analysis/v1' as const,
    suite: input.suite, verdict: decide(failures.complete, primary, input.alpha), alpha: input.alpha,
    complete: failures.complete, failures,
    model, samples, scope, primary_judge: 'official_correct (gpt-4o-2024-08-06, LongMemEval evaluate_qa.py prompt)',
    frozen_manifest_sha256: affected.frozen_manifest_sha256, gbrain_commit: affected.gbrain_commit,
    questions: perQuestion.length, affected: affectedOnly.length,
    primary, affected_only: affectedOnly.length ? paired(p => p.auto, p => p.auto_dates, affectedOnly) : null,
    framed_judge: paired(p => p.framed_auto, p => p.framed_auto_dates),
    by_type: byType, judge_agreement: agreement, reader_noise: noise,
    method: { score: 'mean of the samples\' official verdicts per question; unaffected questions copy auto\'s score for auto_dates', test: `one-sided paired sign-flip over questions, ${input.draws} draws, seed ${input.seed}; 95% bootstrap interval resampling questions` },
    per_question: perQuestion,
  };
}

export type Analysis = ReturnType<typeof analyze>;
export type Verdict = 'pass' | 'inconclusive' | 'regression' | 'incomplete';

/**
 * pass: a positive net gain whose one-sided sign-flip p is at most alpha and
 * whose one-sided bootstrap lower bound is above zero. regression: a negative
 * net gain significant the other way. Anything else, including a positive
 * point estimate whose test or bound fails, is inconclusive. An incomplete run
 * has no verdict.
 */
export function decide(complete: boolean, p: { net_gain: number; p_one_sided_greater: number; p_one_sided_less: number; lower_bound_one_sided_net_gain: number | null }, alpha: number): Verdict {
  if (!complete) return 'incomplete';
  if (p.net_gain > 0 && p.p_one_sided_greater <= alpha && (p.lower_bound_one_sided_net_gain ?? 0) > 0) return 'pass';
  if (p.net_gain < 0 && p.p_one_sided_less <= alpha) return 'regression';
  return 'inconclusive';
}

export const DECISION_MODEL = 'claude-sonnet-5-5';
export const SECONDARY_MODELS = ['gpt-6.1-sol', 'claude-opus-5-5'] as const;
export const AUDIT_MAX_WRONG_RATE = 0.05;

export interface AuditSummary { complete: boolean; n: number; rates: { wrong: number } }

/**
 * The default-flip rule: the preregistered rule plus the 2026-10-21 amendment. Sonnet 5.5 passes on both suites;
 * neither secondary model shows a regression on LongMemEval-S affected questions; the bracket audit is complete with
 * at most 5% wrong. Secondaries that were not run (because Sonnet did not pass) are named, and the flip is not ready.
 */
export function flipVerdict(input: { longmemeval: Analysis; synthetic: Analysis; secondaries: Analysis[]; audit: AuditSummary | null }) {
  const { longmemeval: lme, synthetic: syn } = input;
  const problems: string[] = [];
  if (lme.suite !== 'longmemeval' || syn.suite !== 'synthetic') throw new Error(`expected a longmemeval and a synthetic analysis, got ${lme.suite} and ${syn.suite}`);
  for (const x of [lme, syn]) {
    if (x.model !== DECISION_MODEL) throw new Error(`the decision model is ${DECISION_MODEL}; the ${x.suite} analysis is ${x.model}`);
    if (x.scope !== 'all') throw new Error(`the decision analyses score all questions; the ${x.suite} analysis is scoped to ${x.scope}`);
    if (x.verdict !== 'pass') problems.push(`${x.suite}: ${DECISION_MODEL} verdict ${x.verdict}`);
  }
  const decisionPass = problems.length === 0;
  const secondaries = SECONDARY_MODELS.map(model => {
    const found = input.secondaries.filter(x => x.model === model);
    if (found.length > 1) throw new Error(`two secondary analyses for ${model}`);
    const x = found[0];
    if (!x) { problems.push(`${model}: not run${decisionPass ? '' : ` (skipped: ${DECISION_MODEL} did not pass both suites)`}`); return { model, run: false as const }; }
    if (x.suite !== 'longmemeval' || x.scope !== 'affected') throw new Error(`the ${model} secondary must be a LongMemEval analysis scoped to affected questions, got ${x.suite}/${x.scope}`);
    if (!x.complete) problems.push(`${model}: incomplete`);
    else if (x.verdict === 'regression') problems.push(`${model}: regression on affected questions (one-sided loss p ${x.primary.p_one_sided_less.toFixed(4)})`);
    return { model, run: true as const, verdict: x.verdict, complete: x.complete, questions: x.questions, net_gain: x.primary.net_gain, ci95_net_gain: x.primary.ci95_net_gain, p_one_sided_greater: x.primary.p_one_sided_greater, p_one_sided_less: x.primary.p_one_sided_less };
  });
  if (!input.audit) problems.push('bracket audit: not run');
  else if (!input.audit.complete) problems.push('bracket audit: incomplete');
  else if (input.audit.rates.wrong > AUDIT_MAX_WRONG_RATE) problems.push(`bracket audit: ${(input.audit.rates.wrong * 100).toFixed(1)}% wrong, over ${AUDIT_MAX_WRONG_RATE * 100}%`);
  return {
    decision_model_passes_both: decisionPass,
    secondaries,
    audit: input.audit ? { complete: input.audit.complete, n: input.audit.n, wrong_rate: input.audit.rates.wrong } : null,
    default_flip_ready: problems.length === 0,
    blocking: problems,
    outside_this_runner: 'GBRA-108 also requires the existing gbrain-evals retrieval categories to show no regression with the flag on',
  };
}

const f2 = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

export function analysisMarkdown(a: Analysis): string {
  const p = a.primary;
  const lines = [
    `# External ideas wave A: relative-date brackets (${a.model})`, '',
    `Suite: ${a.suite}${a.scope === 'affected' ? ' (affected questions only)' : ''}. Verdict: **${a.verdict}** (alpha ${a.alpha}). Status: **${a.complete ? 'complete' : 'INCOMPLETE'}**. gbrain ` + '`' + a.gbrain_commit.slice(0, 9) + '`' + `, ${a.questions} questions, ${a.affected} affected (their two requests differ), samples ${a.samples.join(', ')}. Primary judge: ${a.primary_judge}.`, '',
    ...(a.complete ? [] : [`Failures: ${Object.entries(a.failures.counts).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '']),
    '| Measure | auto | auto_dates | Net gain | 95% CI | One-sided p | Wins | Losses |',
    '|---|---|---|---|---|---|---|---|',
    `| All questions, official judge | ${f2(p.auto)} | ${f2(p.auto_dates)} | ${f2(p.net_gain)} | ${p.ci95_net_gain ? `${f2(p.ci95_net_gain[0])} to ${f2(p.ci95_net_gain[1])}` : 'n/a'} | ${p.p_one_sided_greater.toFixed(4)} | ${p.wins} | ${p.losses} |`,
    ...(a.affected_only ? [`| Affected only, official judge | ${f2(a.affected_only.auto)} | ${f2(a.affected_only.auto_dates)} | ${f2(a.affected_only.net_gain)} | ${a.affected_only.ci95_net_gain ? `${f2(a.affected_only.ci95_net_gain[0])} to ${f2(a.affected_only.ci95_net_gain[1])}` : 'n/a'} | ${a.affected_only.p_one_sided_greater.toFixed(4)} | ${a.affected_only.wins} | ${a.affected_only.losses} |`] : []),
    `| All questions, framed judge (report-only) | ${f2(a.framed_judge.auto)} | ${f2(a.framed_judge.auto_dates)} | ${f2(a.framed_judge.net_gain)} | | | ${a.framed_judge.wins} | ${a.framed_judge.losses} |`,
    '', '| Type | Questions | Affected | auto | auto_dates | Net gain |', '|---|---|---|---|---|---|',
    ...Object.entries(a.by_type).sort(([x], [y]) => (x < y ? -1 : 1)).map(([t, v]) => `| ${t} | ${v.questions} | ${v.affected} | ${f2(v.auto)} | ${f2(v.auto_dates)} | ${f2(v.net_gain)} |`),
    '', `Judge agreement: ${a.judge_agreement.agree} of ${a.judge_agreement.rows} rows (official yes / framed no ${a.judge_agreement.official_yes_framed_no}, official no / framed yes ${a.judge_agreement.official_no_framed_yes}).`,
    'rate' in a.reader_noise ? `Reader-noise floor (auto sample 1 vs 2): ${a.reader_noise.discordant} of ${a.reader_noise.questions} questions discordant (${(a.reader_noise.rate * 100).toFixed(1)}%); ${a.reader_noise.affected_discordant} of ${a.reader_noise.affected_questions} affected.` : `Reader-noise floor: ${a.reader_noise.note}.`,
    '',
  ];
  return lines.join('\n');
}

// ─── Bracket audit ──────────────────────────────────────────────────

/** A bracket gbrain inserts: " [≈2023-05-07]", " [2023-05]", " [2023]", " [2023-05-01/2023-05-07]". */
const BRACKET = / \[≈?\d{4}(?:-\d{2}(?:-\d{2})?)?(?:\/\d{4}-\d{2}-\d{2})?\]/y;

export interface Insertion { at: number; bracket: string }

/**
 * The brackets that turn `before` into `after`, as offsets in `after` (where
 * each bracket starts). Null when `after` is not `before` plus brackets.
 */
export function bracketInsertions(before: string, after: string): Insertion[] | null {
  const out: Insertion[] = [];
  let i = 0, j = 0;
  while (j < after.length) {
    BRACKET.lastIndex = j;
    const m = BRACKET.exec(after);
    if (m && before.slice(i, i + m[0].length) !== m[0]) { out.push({ at: j, bracket: m[0].trim() }); j += m[0].length; continue; }
    if (i < before.length && before[i] === after[j]) { i++; j++; continue; }
    return null;
  }
  return i === before.length ? out : null;
}

export interface AuditItem { key: string; question_id: string; slug: string; session_date: string | null; bracket: string; context: string }

/** Every insertion in the frozen manifest, with the session date and `contextChars` characters of delivered text around it (two thirds before the bracket's end, one third after). */
export function auditCandidates(questions: FrozenQuestion[], store: Pick<BlobStore, 'get'>, contextChars: number): { items: AuditItem[]; unaligned_blocks: number } {
  const items: AuditItem[] = [];
  let unaligned = 0;
  for (const q of [...questions].sort((a, b) => (a.question_id < b.question_id ? -1 : 1))) {
    const a = q.arms.auto?.blocks ?? [], b = q.arms.auto_dates?.blocks ?? [];
    const dates = new Map(q.pages.map(p => [p.slug, p.date]));
    b.forEach((block, k) => {
      const base = a[k];
      if (base && base.text === block.text) return;
      if (!base || base.slug !== block.slug) { unaligned++; return; }
      const after = store.get(block.text);
      const ins = bracketInsertions(store.get(base.text), after);
      if (!ins) { unaligned++; return; }
      const tail = Math.floor(contextChars / 3);
      for (const x of ins) {
        const end = x.at + 1 + x.bracket.length;
        items.push({ key: `${q.question_id}#${k}#${x.at}`, question_id: q.question_id, slug: block.slug, session_date: dates.get(block.slug) ?? null, bracket: x.bracket, context: after.slice(Math.max(0, end - (contextChars - tail)), end + tail) });
      }
    });
  }
  return { items, unaligned_blocks: unaligned };
}

export function auditPrompt(item: AuditItem): string {
  return [
    'A memory system added a bracketed calendar date right after a relative time phrase in a user\'s message, resolved against the day the conversation took place.',
    '', `Conversation date: ${item.session_date ?? 'unknown'}`, '', 'Excerpt (the bracket is part of the excerpt):', '"""', item.context, '"""', '',
    `Bracket under review: ${item.bracket}`, '',
    'Is the bracketed date a correct calendar reading of the relative phrase immediately before it, given the conversation date? "≈" marks an approximate date, which is correct when it is a reasonable reading of an approximate phrase. A date range is correct when the phrase names that span.',
    'Answer with exactly one word: correct, wrong, or ambiguous (ambiguous when the phrase has more than one reasonable reading or is not about a time in the past or future at all).',
  ].join('\n');
}

export function auditVerdict(text: string): 'correct' | 'wrong' | 'ambiguous' | null {
  const m = /\b(correct|wrong|ambiguous)\b/i.exec(text.trim());
  return m ? (m[1].toLowerCase() as 'correct' | 'wrong' | 'ambiguous') : null;
}

// ─── Preflight ──────────────────────────────────────────────────────

export interface PreflightProblem { code: string; message: string; fix: string }

export interface PreflightFacts {
  /** The frozen header; null before a freeze. */
  header: FrozenHeader | null;
  gbrainHead: string;
  gbrainStatus: string;
  datasetSha: string | null;
  env: Record<string, string | undefined>;
  keys: string[];
  smoke: boolean;
  manifest: StudyManifest;
  readerSystemSha: string | null;
  /** sha256 of each pinned code file in GBRAIN_DIR now (null: absent). */
  codeSha: Record<string, string | null>;
  /** Whether this command needs the committed, pushed preregistration. */
  needsPrereg: boolean;
  attest: () => unknown;
}

/** Keyless checks before any paid call. Each problem has a stable code and the exact fix; key values are never read beyond presence. */
export function preflightProblems(f: PreflightFacts): PreflightProblem[] {
  const out: PreflightProblem[] = [];
  const pin = f.manifest.candidate_commits.gbrain;
  const add = (code: string, message: string, fix: string) => out.push({ code, message, fix });
  if (f.header && f.header.gbrain.commit !== f.gbrainHead) add('gbrain_commit_mismatch', `the frozen evidence was made at gbrain ${f.header.gbrain.commit.slice(0, 12)}, GBRAIN_DIR is at ${f.gbrainHead.slice(0, 12)}`, `git -C "$GBRAIN_DIR" checkout ${f.header.gbrain.commit}`);
  if (f.gbrainStatus.trim()) add('gbrain_tree_dirty', `GBRAIN_DIR has uncommitted or untracked files (${f.gbrainStatus.trim().split('\n').length} paths)`, 'git -C "$GBRAIN_DIR" status --short   # commit or remove them, then rerun');
  if (f.header && f.datasetSha !== null && f.datasetSha !== f.header.dataset_sha256) add('dataset_sha_mismatch', `--dataset hashes to ${f.datasetSha.slice(0, 12)}, the frozen evidence used ${f.header.dataset_sha256.slice(0, 12)}`, `pass the dataset whose sha256 is ${f.header.dataset_sha256}`);
  for (const k of f.keys) if (!f.env[k]) add('missing_api_key', `${k} is not set`, `export ${k}=...   # then rerun`);
  if (f.readerSystemSha !== null && f.readerSystemSha !== f.manifest.reader.system_sha256) add('reader_prompt_changed', `GBRAIN_DIR's READER_NOTES_SYSTEM_TEXT hashes to ${f.readerSystemSha.slice(0, 12)}, the study manifest pins ${f.manifest.reader.system_sha256.slice(0, 12)}`, `git -C "$GBRAIN_DIR" checkout ${pin ?? '<pinned commit>'}`);
  for (const [file, want] of Object.entries(f.manifest.pinned_code_sha256)) if (f.codeSha[file] !== want) add('pinned_code_mismatch', `${file} in GBRAIN_DIR hashes to ${f.codeSha[file]?.slice(0, 12) ?? 'nothing'}, the study manifest pins ${want.slice(0, 12)}`, `git -C "$GBRAIN_DIR" checkout ${pin ?? '<pinned commit>'}`);
  if (!f.smoke) {
    if (f.header?.smoke) add('smoke_freeze', 'the frozen evidence is a --smoke freeze', 'freeze without --smoke into a new --out-dir');
    const at = f.header?.gbrain.commit ?? f.gbrainHead;
    if (pin !== at) add('gbrain_pin_mismatch', `the study manifest pins gbrain ${pin ?? 'nothing'}, the evidence is at ${at.slice(0, 12)}`, `git -C "$GBRAIN_DIR" checkout ${pin ?? '<pin candidate_commits.gbrain in ' + STUDY_MANIFEST_REL + ' first>'}`);
    if (f.needsPrereg) {
      try { f.attest(); }
      catch (e) { add('prereg_not_attested', (e as Error).message, `git add ${PREREG_REL} && git commit -m "docs: preregister external ideas wave A" && git push`); }
    }
  }
  return out;
}

