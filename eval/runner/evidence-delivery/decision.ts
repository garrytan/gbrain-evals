/**
 * Executable decision rule for the evidence-delivery study (plan amendment 1).
 *
 * Every threshold comes from the committed decision manifest
 * (docs/benchmarks/2026-09-30-evidence-delivery/decision-manifest.json); this
 * module only applies it. It is pure and keyless: it reads per-question
 * outcome rows and returns the preregistered outcome with every intermediate
 * number, so a reviewer can recompute each step.
 *
 * Stages:
 *   selectPilot          rank the six candidates on the 100 pilot questions
 *   decideConfirmatory   gap, closure, tokens, significance, per-type, judges
 *   decideE2             sealed no-regression check (pass / reject / inconclusive)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clusteredPairedDelta, exactMcNemar, holmAdjusted, type PairedItem } from '../stats/paired.ts';

export const DECISION_MANIFEST_PATH = join(import.meta.dir, '../../../docs/benchmarks/2026-09-30-evidence-delivery/decision-manifest.json');

export type Judge = 'primary' | 'confirmation';

export interface ArmSpec {
  id: string;
  role: 'baseline' | 'candidate' | 'reference' | 'comparator' | 'control' | 'agent';
  source: 'frozen' | 'product' | 'harness' | 'frozen+product';
  unit: 'chunk' | 'window' | 'section' | 'page' | 'auto';
  blocks: 'per_chunk' | 'per_page';
  budget_tokens?: number | null;
  return_window?: number;
  top_k?: number;
  sets: string[];
}

export interface DecisionManifest {
  schema: string;
  id: string;
  candidate_commits: { gbrain: string | null; gbrain_branch: string; gbrain_repository: string };
  data: { strata: string[]; pilot: { path: string; sha256: string }; longmemeval_s: { sha256: string }; cluster_map: { path: string } };
  reader: { model: string; system_sha256: string; max_tokens: number; prompt_version: string };
  arms: ArmSpec[];
  family: { candidates: string[]; holm_m: number; untested_p: number };
  pilot_selection: { advance: number };
  confirmatory: { success: { closure_fraction: number; max_ratio: number; alpha: number; sign_flip_draws: number; bootstrap_draws: number; seed: number; max_net_loss: number } };
  missing_and_errors: { max_error_rate: number };
  token_rule: { max_ratio: number; reference_guard_ratio: number };
  e2: { max_errors: number; min_delta: number; bootstrap_draws: number; seed: number };
  gpt4o: { reader_model: string; arms: string[] };
  budget: { campaign_cap_usd: number; program_cap_usd: number };
}

export function loadDecisionManifest(path = DECISION_MANIFEST_PATH): { manifest: DecisionManifest; sha256: string } {
  const bytes = readFileSync(path);
  return { manifest: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function validateDecisionManifest(m: DecisionManifest): string[] {
  const problems: string[] = [];
  const ids = new Set(m.arms.map(a => a.id));
  if (ids.size !== m.arms.length) problems.push('duplicate arm ids');
  for (const need of ['chunk', 'page', 'page_legacy', 'k10', 'agent_fetch']) if (!ids.has(need)) problems.push(`missing arm ${need}`);
  const candidates = m.arms.filter(a => a.role === 'candidate').map(a => a.id);
  if (JSON.stringify(candidates) !== JSON.stringify(m.family.candidates)) problems.push('family.candidates must list exactly the candidate arms, in arm order');
  if (m.family.holm_m !== m.family.candidates.length) problems.push('family.holm_m must equal the number of candidates');
  if (m.family.untested_p !== 1) problems.push('untested candidates must enter Holm at p = 1');
  if (m.arms.find(a => a.id === 'k10')?.role !== 'comparator') problems.push('k10 must be a comparator, never a candidate');
  if (m.arms.find(a => a.id === 'page')?.role !== 'reference') problems.push('page must be the reference');
  if (m.arms.find(a => a.id === 'chunk')?.role !== 'baseline') problems.push('chunk must be the baseline');
  const s = m.confirmatory.success;
  if (!(s.closure_fraction > 0 && s.closure_fraction <= 1)) problems.push('closure_fraction out of range');
  if (!(s.max_ratio > 0 && s.max_ratio < 1) || s.max_ratio !== m.token_rule.max_ratio) problems.push('token max_ratio inconsistent');
  if (!(s.alpha > 0 && s.alpha < 0.5)) problems.push('alpha out of range');
  if (!Number.isInteger(s.max_net_loss) || s.max_net_loss < 0) problems.push('max_net_loss must be a non-negative integer');
  if (!(m.missing_and_errors.max_error_rate >= 0 && m.missing_and_errors.max_error_rate < 0.2)) problems.push('max_error_rate out of range');
  if (m.pilot_selection.advance < 1 || m.pilot_selection.advance > m.family.candidates.length) problems.push('pilot_selection.advance out of range');
  if (m.candidate_commits.gbrain !== null && !/^[0-9a-f]{40}$/.test(m.candidate_commits.gbrain)) problems.push('candidate_commits.gbrain must be null or a 40-hex commit');
  if (m.data.strata.length !== 6) problems.push('six LongMemEval strata expected');
  if (!(m.e2.min_delta <= 0) || !Number.isInteger(m.e2.max_errors)) problems.push('e2 thresholds invalid');
  if (m.budget.campaign_cap_usd > m.budget.program_cap_usd) problems.push('campaign cap above program cap');
  return problems;
}

// ─── Outcome rows ────────────────────────────────────────────────────

export interface OutcomeRow {
  question_id: string;
  question_type: string;
  cluster: string;
  /** 1 correct, 0 incorrect, null judge error or no answer. */
  primary: 0 | 1 | null;
  confirmation: 0 | 1 | null;
  /** Provider-reported reader input tokens for the whole request (all turns); null when unavailable. */
  provider_input_tokens: number | null;
  reader_error?: string | null;
  /** Blocks whose text repeats or contains another block's text. */
  duplicate_bodies?: number;
}

export type ArmRows = Record<string, OutcomeRow[]>;

const score = (r: OutcomeRow, judge: Judge) => (r.reader_error ? 0 : (r[judge] ?? 0));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function percentile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}

export interface ArmSummary { arm: string; n: number; correct: number; errors: number; error_rate: number; mean_tokens: number; p95_tokens: number; missing_tokens: number; duplicate_rows: number }

export function summarizeArm(arm: string, rows: OutcomeRow[], judge: Judge = 'primary'): ArmSummary {
  const tokens = rows.map(r => r.provider_input_tokens).filter((t): t is number => typeof t === 'number');
  const errors = rows.filter(r => r.reader_error).length;
  return {
    arm, n: rows.length, correct: rows.reduce((s, r) => s + score(r, judge), 0), errors, error_rate: rows.length ? errors / rows.length : 0,
    mean_tokens: mean(tokens), p95_tokens: percentile(tokens, 0.95), missing_tokens: rows.length - tokens.length,
    duplicate_rows: rows.filter(r => (r.duplicate_bodies ?? 0) > 0).length,
  };
}

/** Rows restricted to `ids`, keyed by question; reports missing and duplicate ids instead of shrinking the denominator. */
function aligned(arms: ArmRows, armIds: string[], ids: string[]): { byArm: Map<string, Map<string, OutcomeRow>>; problems: string[] } {
  const problems: string[] = [];
  const byArm = new Map<string, Map<string, OutcomeRow>>();
  for (const arm of armIds) {
    const rows = arms[arm];
    if (!rows) { problems.push(`arm ${arm} has no rows`); continue; }
    const map = new Map<string, OutcomeRow>();
    for (const r of rows) {
      if (map.has(r.question_id)) problems.push(`${arm}: duplicate row ${r.question_id}`);
      map.set(r.question_id, r);
    }
    const missing = ids.filter(id => !map.has(id));
    if (missing.length) problems.push(`${arm}: ${missing.length} question(s) missing (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', ...' : ''})`);
    byArm.set(arm, map);
  }
  return { byArm, problems };
}

function pairs(a: Map<string, OutcomeRow>, b: Map<string, OutcomeRow>, ids: string[], judge: Judge): PairedItem[] {
  return ids.map(id => ({ id, cluster: a.get(id)!.cluster, a: score(a.get(id)!, judge), b: score(b.get(id)!, judge) }));
}

const tokensOn = (m: Map<string, OutcomeRow>, ids: string[]) => ids.map(id => m.get(id)!.provider_input_tokens).filter((t): t is number => typeof t === 'number');

// ─── Pilot selection ─────────────────────────────────────────────────

export interface PilotCandidate { id: string; correct: number; mean_tokens: number; token_ratio: number; eligible: boolean; reason?: string; rank?: number }
export interface PilotSelection { status: 'ok' | 'blocked'; problems: string[]; page_mean_tokens: number; candidates: PilotCandidate[]; advanced: string[]; reference_guard?: { page: number; page_legacy: number; ratio: number; ok: boolean } }

export function selectPilot(m: DecisionManifest, arms: ArmRows, pilotIds: string[]): PilotSelection {
  const armIds = ['chunk', 'page', ...m.family.candidates];
  const { byArm, problems } = aligned(arms, armIds, pilotIds);
  const maxErr = m.missing_and_errors.max_error_rate;
  for (const arm of armIds) {
    const rows = byArm.get(arm);
    if (!rows) continue;
    const errs = pilotIds.filter(id => rows.get(id)?.reader_error).length;
    if (errs / pilotIds.length > maxErr) problems.push(`${arm}: ${errs} reader errors on the pilot, over the ${maxErr} limit`);
  }
  const pageRows = byArm.get('page');
  if (problems.length || !pageRows) return { status: 'blocked', problems, page_mean_tokens: NaN, candidates: [], advanced: [] };
  const pageMean = mean(tokensOn(pageRows, pilotIds));
  const candidates: PilotCandidate[] = m.family.candidates.map(id => {
    const rows = byArm.get(id)!;
    const meanTokens = mean(tokensOn(rows, pilotIds));
    const ratio = meanTokens / pageMean;
    const correct = pilotIds.reduce((s, q) => s + score(rows.get(q)!, 'primary'), 0);
    const eligible = Number.isFinite(ratio) && ratio <= m.token_rule.max_ratio;
    return { id, correct, mean_tokens: meanTokens, token_ratio: ratio, eligible, ...(eligible ? {} : { reason: `token ratio ${ratio.toFixed(3)} over ${m.token_rule.max_ratio}` }) };
  });
  const order = new Map(m.family.candidates.map((id, i) => [id, i]));
  const ranked = candidates.filter(c => c.eligible).sort((x, y) => y.correct - x.correct || x.mean_tokens - y.mean_tokens || order.get(x.id)! - order.get(y.id)!);
  ranked.forEach((c, i) => { c.rank = i + 1; });
  let reference_guard: PilotSelection['reference_guard'];
  const legacy = arms.page_legacy;
  if (legacy?.length) {
    const legacyMap = new Map(legacy.map(r => [r.question_id, r]));
    const common = pilotIds.filter(id => legacyMap.has(id));
    const lm = mean(tokensOn(legacyMap, common));
    const pm = mean(tokensOn(pageRows, common));
    reference_guard = { page: pm, page_legacy: lm, ratio: pm / lm, ok: pm / lm <= m.token_rule.reference_guard_ratio };
  }
  return { status: 'ok', problems: [], page_mean_tokens: pageMean, candidates, advanced: ranked.slice(0, m.pilot_selection.advance).map(c => c.id), ...(reference_guard ? { reference_guard } : {}) };
}

// ─── Confirmatory decision ───────────────────────────────────────────

export type Outcome = 'success' | 'page_only' | 'no_demonstrated_benefit' | 'inconclusive';

export interface TypeTally { type: string; n: number; wins: number; losses: number; net_loss: number; ok: boolean }

export interface CandidateDecision {
  id: string;
  correct: number;
  delta_vs_chunk: number;
  hurdle: number;
  closure_ratio: number | null;
  closure_met: boolean;
  token_ratio: number;
  token_p95: number;
  token_met: boolean;
  mcnemar: { wins: number; losses: number; p: number; p_holm: number };
  sign_flip: { p: number; p_holm: number; ci95: [number, number] | null };
  significance_met: boolean;
  per_type: TypeTally[];
  per_type_met: boolean;
  confirmation: { delta_vs_chunk: number; gap: number; agrees: boolean };
  contrast: { mean: number; ci95: [number, number] | null };
  primary_success: boolean;
  success: boolean;
  reasons: string[];
}

export interface ConfirmatoryDecision {
  outcome: Outcome;
  winner: string | null;
  problems: string[];
  n: number;
  chunk: ArmSummary;
  page: ArmSummary;
  gap: { value: number; mcnemar_p: number; established: boolean; confirmation_value: number };
  candidates: CandidateDecision[];
  reasons: string[];
}

function tallyTypes(strata: string[], chunk: Map<string, OutcomeRow>, cand: Map<string, OutcomeRow>, ids: string[], maxNetLoss: number): TypeTally[] {
  return strata.map(type => {
    const qs = ids.filter(id => chunk.get(id)!.question_type === type);
    let wins = 0, losses = 0;
    for (const id of qs) {
      const a = score(chunk.get(id)!, 'primary'), b = score(cand.get(id)!, 'primary');
      if (b > a) wins++;
      if (a > b) losses++;
    }
    return { type, n: qs.length, wins, losses, net_loss: losses - wins, ok: losses - wins <= maxNetLoss };
  });
}

export function decideConfirmatory(m: DecisionManifest, arms: ArmRows, confirmatoryIds: string[], advanced: string[]): ConfirmatoryDecision {
  const s = m.confirmatory.success;
  const unknown = advanced.filter(id => !m.family.candidates.includes(id));
  const armIds = ['chunk', 'page', ...advanced];
  const { byArm, problems } = aligned(arms, armIds, confirmatoryIds);
  if (unknown.length) problems.push(`not family candidates: ${unknown.join(', ')}`);
  for (const arm of armIds) {
    const rows = byArm.get(arm);
    if (!rows) continue;
    const errs = confirmatoryIds.filter(id => rows.get(id)?.reader_error).length;
    if (errs / confirmatoryIds.length > m.missing_and_errors.max_error_rate) problems.push(`${arm}: ${errs} reader errors, over the ${m.missing_and_errors.max_error_rate} limit`);
  }
  const typeMismatch = confirmatoryIds.filter(id => armIds.some(a => byArm.get(a)?.get(id) && byArm.get(a)!.get(id)!.question_type !== byArm.get('chunk')?.get(id)?.question_type));
  if (typeMismatch.length) problems.push(`question_type differs across arms for ${typeMismatch.length} question(s)`);
  const pageRowsForGuard = byArm.get('page');
  if (pageRowsForGuard && confirmatoryIds.some(id => (pageRowsForGuard.get(id)?.duplicate_bodies ?? 0) > 0)) problems.push('page reference has duplicate delivered bodies');
  const empty = { arm: '', n: 0, correct: 0, errors: 0, error_rate: 0, mean_tokens: NaN, p95_tokens: NaN, missing_tokens: 0, duplicate_rows: 0 };
  if (problems.length) {
    return { outcome: 'inconclusive', winner: null, problems, n: confirmatoryIds.length, chunk: empty, page: empty,
      gap: { value: NaN, mcnemar_p: NaN, established: false, confirmation_value: NaN }, candidates: [], reasons: ['blocked: ' + problems.join('; ')] };
  }
  const ids = confirmatoryIds;
  const chunk = byArm.get('chunk')!, page = byArm.get('page')!;
  const count = (rows: Map<string, OutcomeRow>, judge: Judge) => ids.reduce((acc, id) => acc + score(rows.get(id)!, judge), 0);
  const chunkSummary = summarizeArm('chunk', ids.map(id => chunk.get(id)!));
  const pageSummary = summarizeArm('page', ids.map(id => page.get(id)!));
  const gapValue = count(page, 'primary') - count(chunk, 'primary');
  const gapTest = exactMcNemar(pairs(chunk, page, ids, 'primary'));
  const gapConfirm = count(page, 'confirmation') - count(chunk, 'confirmation');
  const established = gapValue > 0 && gapTest.p_two_sided < s.alpha;
  const pageMean = mean(tokensOn(page, ids));

  const raw = advanced.map(id => {
    const cand = byArm.get(id)!;
    const p = pairs(chunk, cand, ids, 'primary');
    const mc = exactMcNemar(p);
    const sf = clusteredPairedDelta(p, { seed: s.seed, draws: s.sign_flip_draws });
    return { id, cand, p, mc, sf };
  });
  const familyP = (pick: (r: typeof raw[number]) => number) => {
    const ps = m.family.candidates.map(id => { const r = raw.find(x => x.id === id); return r ? pick(r) : m.family.untested_p; });
    const adj = holmAdjusted(ps);
    return new Map(m.family.candidates.map((id, i) => [id, adj[i]]));
  };
  const holmMc = familyP(r => r.mc.p_two_sided);
  const holmSf = familyP(r => r.sf.p_two_sided);

  const candidates: CandidateDecision[] = raw.map(({ id, cand, mc, sf }) => {
    const correct = count(cand, 'primary');
    const delta = correct - count(chunk, 'primary');
    const hurdle = count(chunk, 'primary') + s.closure_fraction * gapValue;
    const closureMet = established && correct >= hurdle;
    const tokens = tokensOn(cand, ids);
    const tokenRatio = mean(tokens) / pageMean;
    const tokenMet = Number.isFinite(tokenRatio) && tokenRatio <= s.max_ratio;
    const sigMet = delta > 0 && holmMc.get(id)! < s.alpha && holmSf.get(id)! < s.alpha;
    const perType = tallyTypes(m.data.strata, chunk, cand, ids, s.max_net_loss);
    const perTypeMet = perType.every(t => t.ok);
    const confDelta = count(cand, 'confirmation') - count(chunk, 'confirmation');
    const agrees = confDelta > 0 && gapConfirm > 0;
    const contrastPairs = ids.map(q => ({ id: q, cluster: chunk.get(q)!.cluster, a: 0,
      b: score(cand.get(q)!, 'primary') - score(chunk.get(q)!, 'primary') - s.closure_fraction * (score(page.get(q)!, 'primary') - score(chunk.get(q)!, 'primary')) }));
    const contrast = clusteredPairedDelta(contrastPairs, { seed: s.seed, draws: s.bootstrap_draws });
    const reasons: string[] = [];
    if (!established) reasons.push('gap not established');
    else if (!closureMet) reasons.push(`closure: ${correct} correct is below the hurdle ${hurdle.toFixed(1)}`);
    if (!tokenMet) reasons.push(`tokens: ratio ${tokenRatio.toFixed(3)} over ${s.max_ratio}`);
    if (!sigMet) reasons.push(`significance: delta ${delta}, Holm McNemar ${holmMc.get(id)!.toPrecision(3)}, Holm sign-flip ${holmSf.get(id)!.toPrecision(3)}`);
    for (const t of perType) if (!t.ok) reasons.push(`per-type: ${t.type} net loss ${t.net_loss} over ${s.max_net_loss}`);
    const primarySuccess = closureMet && tokenMet && sigMet && perTypeMet;
    if (primarySuccess && !agrees) reasons.push(`confirmation judge reverses: candidate - chunk ${confDelta}, page - chunk ${gapConfirm}`);
    return {
      id, correct, delta_vs_chunk: delta, hurdle, closure_ratio: gapValue > 0 ? delta / gapValue : null, closure_met: closureMet,
      token_ratio: tokenRatio, token_p95: percentile(tokens, 0.95), token_met: tokenMet,
      mcnemar: { wins: mc.wins, losses: mc.losses, p: mc.p_two_sided, p_holm: holmMc.get(id)! },
      sign_flip: { p: sf.p_two_sided, p_holm: holmSf.get(id)!, ci95: sf.ci95 },
      significance_met: sigMet, per_type: perType, per_type_met: perTypeMet,
      confirmation: { delta_vs_chunk: confDelta, gap: gapConfirm, agrees },
      contrast: { mean: contrast.delta, ci95: contrast.ci95 },
      primary_success: primarySuccess, success: primarySuccess && agrees, reasons,
    };
  });

  const order = new Map(m.family.candidates.map((id, i) => [id, i]));
  const winners = candidates.filter(c => c.success).sort((x, y) => y.correct - x.correct || x.token_ratio - y.token_ratio || order.get(x.id)! - order.get(y.id)!);
  const reversed = candidates.some(c => c.primary_success && !c.success);
  let outcome: Outcome;
  const reasons: string[] = [];
  if (!established) { outcome = 'no_demonstrated_benefit'; reasons.push(`gap ${gapValue} (McNemar p ${gapTest.p_two_sided.toPrecision(3)}) is not an established page - chunk gap`); }
  else if (winners.length) { outcome = 'success'; reasons.push(`${winners[0].id} meets every success condition`); }
  else if (reversed) { outcome = 'inconclusive'; reasons.push('a primary success is reversed by the confirmation judge'); }
  else { outcome = 'page_only'; reasons.push('the gap is established but no candidate meets every success condition'); }
  return {
    outcome, winner: outcome === 'success' ? winners[0].id : null, problems: [], n: ids.length, chunk: chunkSummary, page: pageSummary,
    gap: { value: gapValue, mcnemar_p: gapTest.p_two_sided, established, confirmation_value: gapConfirm }, candidates, reasons,
  };
}

/** The gpt-4o second arm: the confirmatory winner, else the better advanced candidate. */
export function gpt4oSecondArm(m: DecisionManifest, decision: ConfirmatoryDecision): { arm: string | null; label: 'winner' | 'best_advanced' | 'none' } {
  if (decision.winner) return { arm: decision.winner, label: 'winner' };
  const order = new Map(m.family.candidates.map((id, i) => [id, i]));
  const best = [...decision.candidates].sort((x, y) => y.correct - x.correct || x.token_ratio - y.token_ratio || order.get(x.id)! - order.get(y.id)!)[0];
  return best ? { arm: best.id, label: 'best_advanced' } : { arm: null, label: 'none' };
}

// ─── E2 sealed confirmation ──────────────────────────────────────────

export interface E2Decision {
  outcome: 'pass' | 'reject' | 'inconclusive';
  n: number;
  n_clusters: number;
  primary: { delta: number; ci95: [number, number] | null };
  confirmation: { delta: number };
  errors: { chunk: number; winner: number };
  problems: string[];
  reasons: string[];
}

export function decideE2(m: DecisionManifest, chunkRows: OutcomeRow[], winnerRows: OutcomeRow[]): E2Decision {
  const ids = [...new Set([...chunkRows, ...winnerRows].map(r => r.question_id))].sort();
  const { byArm, problems } = aligned({ chunk: chunkRows, winner: winnerRows }, ['chunk', 'winner'], ids);
  const errors = { chunk: chunkRows.filter(r => r.reader_error).length, winner: winnerRows.filter(r => r.reader_error).length };
  if (errors.chunk > m.e2.max_errors) problems.push(`chunk has ${errors.chunk} reader errors, over ${m.e2.max_errors}`);
  if (errors.winner > m.e2.max_errors) problems.push(`winner has ${errors.winner} reader errors, over ${m.e2.max_errors}`);
  const base = { n: ids.length, errors };
  if (problems.length) return { outcome: 'inconclusive', ...base, n_clusters: 0, primary: { delta: NaN, ci95: null }, confirmation: { delta: NaN }, problems, reasons: ['blocked'] };
  const chunk = byArm.get('chunk')!, winner = byArm.get('winner')!;
  const p = pairs(chunk, winner, ids, 'primary');
  const stats = clusteredPairedDelta(p, { seed: m.e2.seed, draws: m.e2.bootstrap_draws });
  const delta = p.reduce((acc, x) => acc + x.b - x.a, 0);
  const confDelta = pairs(chunk, winner, ids, 'confirmation').reduce((acc, x) => acc + x.b - x.a, 0);
  const upper = stats.ci95 ? stats.ci95[1] : delta / ids.length;
  const primaryPass = delta >= m.e2.min_delta && upper >= 0;
  const reasons: string[] = [];
  let outcome: E2Decision['outcome'];
  if (!primaryPass) { outcome = 'reject'; reasons.push(`primary winner - chunk ${delta}, interval upper bound ${upper.toFixed(4)}`); }
  else if (confDelta < m.e2.min_delta) { outcome = 'inconclusive'; reasons.push(`confirmation judge winner - chunk ${confDelta} is below ${m.e2.min_delta}`); }
  else { outcome = 'pass'; reasons.push(`primary winner - chunk ${delta} >= ${m.e2.min_delta}, upper bound ${upper.toFixed(4)} >= 0, confirmation ${confDelta}`); }
  return { outcome, ...base, n_clusters: stats.n_clusters, primary: { delta, ci95: stats.ci95 }, confirmation: { delta: confDelta }, problems: [], reasons };
}
