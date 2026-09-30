/**
 * Executable decision rule for the auto v2 follow-up (decision manifest v2,
 * docs/benchmarks/2026-09-30-evidence-auto-v2/decision-manifest.json).
 *
 *   decideSanity  LongMemEval-S (development data): auto >= page - 2% of 500,
 *                 reported beside the decision, never a gate on the seal
 *   decideE2V2    sealed set: auto beats chunk (exact McNemar and a
 *                 persona-clustered sign-flip test), confirmation judge agrees
 * Pure and keyless; every threshold comes from the manifest.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clusteredPairedDelta, exactMcNemar, type PairedItem } from '../stats/paired.ts';
import type { ArmSpec, OutcomeRow } from './decision.ts';

export const DECISION_MANIFEST_V2_PATH = join(import.meta.dir, '../../../docs/benchmarks/2026-09-30-evidence-auto-v2/decision-manifest.json');
export const DECISION_MANIFEST_V2_REL = 'docs/benchmarks/2026-09-30-evidence-auto-v2/decision-manifest.json';

export interface DecisionManifestV2 {
  schema: 'gbrain-evals/evidence-delivery-decision/v2';
  id: string;
  candidate_commits: { gbrain: string | null; gbrain_branch: string; gbrain_repository: string };
  data: { longmemeval_s: { sha256: string; questions: number }; cluster_map: { path: string }; strata: string[]; sealed: { questions_sha256: string; labels_sha256: string; questions: number; personas: number; question_kinds: string[] } };
  retrieval: { mode: string; reranker: { timeout_ms: number } };
  reader: { model: string; system_sha256: string; max_tokens: number };
  arms: Array<ArmSpec & { expected_budget_tokens?: number }>;
  sanity: { max_shortfall_fraction: number };
  e2: { arms: string[]; decision_id: string; alpha: number; max_errors: number; sign_flip_draws: number; bootstrap_draws: number; seed: number };
  budget: { campaign_cap_usd: number; program_cap_usd: number; campaign_runner: string };
}

export function loadDecisionManifestV2(path = DECISION_MANIFEST_V2_PATH): { manifest: DecisionManifestV2; sha256: string } {
  const bytes = readFileSync(path);
  return { manifest: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function validateDecisionManifestV2(m: DecisionManifestV2): string[] {
  const problems: string[] = [];
  if (m.schema !== 'gbrain-evals/evidence-delivery-decision/v2') problems.push('schema must be v2');
  const ids = m.arms.map(a => a.id);
  if (JSON.stringify(ids) !== JSON.stringify(['chunk', 'auto', 'page'])) problems.push('arms must be chunk, auto, page');
  const auto = m.arms.find(a => a.id === 'auto');
  if (auto?.unit !== 'auto' || auto.budget_tokens !== null || auto.expected_budget_tokens !== 16000) problems.push('auto must use the product default budget (no budget passed, 16000 expected)');
  if (m.arms.find(a => a.id === 'page')?.sets.includes('sealed')) problems.push('page is a LongMemEval reference only');
  if (JSON.stringify(m.e2.arms) !== JSON.stringify(['chunk', 'auto'])) problems.push('E2 compares chunk and auto');
  if (m.e2.decision_id !== `${m.id}:e2:auto`) problems.push('decision_id must be <id>:e2:auto');
  if (!(m.e2.alpha > 0 && m.e2.alpha < 0.5)) problems.push('alpha out of range');
  if (!(m.sanity.max_shortfall_fraction > 0 && m.sanity.max_shortfall_fraction < 0.2)) problems.push('sanity shortfall out of range');
  if (m.candidate_commits.gbrain !== null && !/^[0-9a-f]{40}$/.test(m.candidate_commits.gbrain)) problems.push('candidate_commits.gbrain must be null or a 40-hex commit');
  if (m.budget.campaign_cap_usd > m.budget.program_cap_usd) problems.push('campaign cap above program cap');
  if (m.data.sealed.questions !== 150 || m.data.sealed.personas !== 30) problems.push('sealed set is 150 questions over 30 personas');
  return problems;
}

const score = (r: OutcomeRow, judge: 'primary' | 'confirmation') => (r.reader_error ? 0 : (r[judge] ?? 0));

function align(a: OutcomeRow[], b: OutcomeRow[]) {
  const ma = new Map(a.map(r => [r.question_id, r])), mb = new Map(b.map(r => [r.question_id, r]));
  const ids = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const missing = ids.filter(id => !ma.has(id) || !mb.has(id));
  return { ma, mb, ids, missing };
}

const pairs = (ma: Map<string, OutcomeRow>, mb: Map<string, OutcomeRow>, ids: string[], judge: 'primary' | 'confirmation'): PairedItem[] =>
  ids.map(id => ({ id, cluster: ma.get(id)!.cluster, a: score(ma.get(id)!, judge), b: score(mb.get(id)!, judge) }));

export interface SanityResult {
  n: number;
  chunk: number;
  auto: number;
  page: number;
  threshold: number;
  pass: boolean;
  auto_vs_page: { wins: number; losses: number; p: number };
  auto_vs_chunk: { wins: number; losses: number; p: number };
  confirmation: { chunk: number; auto: number; page: number };
  problems: string[];
}

export function decideSanity(m: DecisionManifestV2, chunk: OutcomeRow[], auto: OutcomeRow[], page: OutcomeRow[]): SanityResult {
  const problems: string[] = [];
  const n = m.data.longmemeval_s.questions;
  for (const [arm, rows] of [['chunk', chunk], ['auto', auto], ['page', page]] as const) if (new Set(rows.map(r => r.question_id)).size !== n) problems.push(`${arm}: ${new Set(rows.map(r => r.question_id)).size} of ${n} questions`);
  const count = (rows: OutcomeRow[], j: 'primary' | 'confirmation') => rows.reduce((s, r) => s + score(r, j), 0);
  const ap = align(page, auto), ac = align(chunk, auto);
  const vsPage = exactMcNemar(pairs(ap.ma, ap.mb, ap.ids.filter(id => ap.ma.has(id) && ap.mb.has(id)), 'primary'));
  const vsChunk = exactMcNemar(pairs(ac.ma, ac.mb, ac.ids.filter(id => ac.ma.has(id) && ac.mb.has(id)), 'primary'));
  const threshold = count(page, 'primary') - m.sanity.max_shortfall_fraction * n;
  return {
    n, chunk: count(chunk, 'primary'), auto: count(auto, 'primary'), page: count(page, 'primary'), threshold,
    pass: problems.length === 0 && count(auto, 'primary') >= threshold,
    auto_vs_page: { wins: vsPage.wins, losses: vsPage.losses, p: vsPage.p_two_sided },
    auto_vs_chunk: { wins: vsChunk.wins, losses: vsChunk.losses, p: vsChunk.p_two_sided },
    confirmation: { chunk: count(chunk, 'confirmation'), auto: count(auto, 'confirmation'), page: count(page, 'confirmation') },
    problems,
  };
}

export interface E2V2Decision {
  outcome: 'pass' | 'fail' | 'inconclusive';
  n: number;
  n_clusters: number;
  chunk_correct: number;
  auto_correct: number;
  delta: number;
  mcnemar: { wins: number; losses: number; p: number };
  sign_flip: { p: number; ci95: [number, number] | null };
  confirmation: { chunk_correct: number; auto_correct: number; delta: number };
  errors: { chunk: number; auto: number };
  problems: string[];
  reasons: string[];
}

export function decideE2V2(m: DecisionManifestV2, chunk: OutcomeRow[], auto: OutcomeRow[]): E2V2Decision {
  const { ma, mb, ids, missing } = align(chunk, auto);
  const problems: string[] = [];
  if (missing.length) problems.push(`${missing.length} question(s) missing from an arm`);
  if (ids.length !== m.data.sealed.questions) problems.push(`${ids.length} questions, expected ${m.data.sealed.questions}`);
  const errors = { chunk: chunk.filter(r => r.reader_error).length, auto: auto.filter(r => r.reader_error).length };
  if (errors.chunk > m.e2.max_errors) problems.push(`chunk has ${errors.chunk} reader errors, over ${m.e2.max_errors}`);
  if (errors.auto > m.e2.max_errors) problems.push(`auto has ${errors.auto} reader errors, over ${m.e2.max_errors}`);
  const blank = { n: ids.length, n_clusters: 0, chunk_correct: NaN, auto_correct: NaN, delta: NaN, mcnemar: { wins: 0, losses: 0, p: NaN }, sign_flip: { p: NaN, ci95: null }, confirmation: { chunk_correct: NaN, auto_correct: NaN, delta: NaN }, errors };
  if (problems.length) return { outcome: 'inconclusive', ...blank, problems, reasons: ['blocked: ' + problems.join('; ')] };
  const p = pairs(ma, mb, ids, 'primary');
  const pc = pairs(ma, mb, ids, 'confirmation');
  const mc = exactMcNemar(p);
  const sf = clusteredPairedDelta(p, { seed: m.e2.seed, draws: m.e2.sign_flip_draws });
  const sum = (xs: PairedItem[], k: 'a' | 'b') => xs.reduce((s, x) => s + x[k], 0);
  const delta = sum(p, 'b') - sum(p, 'a');
  const confDelta = sum(pc, 'b') - sum(pc, 'a');
  const primaryPass = delta > 0 && mc.p_two_sided < m.e2.alpha && sf.p_two_sided < m.e2.alpha;
  const reasons: string[] = [];
  let outcome: E2V2Decision['outcome'];
  if (!primaryPass) { outcome = 'fail'; reasons.push(`primary: auto - chunk ${delta}, McNemar p ${mc.p_two_sided.toPrecision(3)}, persona sign-flip p ${sf.p_two_sided.toPrecision(3)}`); }
  else if (confDelta <= 0) { outcome = 'inconclusive'; reasons.push(`confirmation judge reverses: auto - chunk ${confDelta}`); }
  else { outcome = 'pass'; reasons.push(`auto - chunk ${delta} (+${mc.wins}/-${mc.losses}), McNemar p ${mc.p_two_sided.toPrecision(3)}, persona sign-flip p ${sf.p_two_sided.toPrecision(3)}, confirmation ${confDelta}`); }
  return {
    outcome, n: ids.length, n_clusters: sf.n_clusters, chunk_correct: sum(p, 'a'), auto_correct: sum(p, 'b'), delta,
    mcnemar: { wins: mc.wins, losses: mc.losses, p: mc.p_two_sided }, sign_flip: { p: sf.p_two_sided, ci95: sf.ci95 },
    confirmation: { chunk_correct: sum(pc, 'a'), auto_correct: sum(pc, 'b'), delta: confDelta }, errors, problems: [], reasons,
  };
}
