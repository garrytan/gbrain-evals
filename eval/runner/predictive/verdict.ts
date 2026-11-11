#!/usr/bin/env bun
/**
 * The predictive-validity verdict for one measure: does its synthetic scorecard
 * rank gbrain configurations the way the real brain did?
 *
 *   bun eval/runner/predictive/verdict.ts --measure <G1..G6> --synthetic <scorecard.json> \
 *     [--manifest eval/data/validity-references/manifest.json] [--out verdict.json] [--control] [--secondary]
 *
 * For each layer of the measure (mapping.ts), it loads the reference with
 * validity.ts's loadReference and applies its preregistered verdict(): a
 * reference contrast qualifies when its 95% interval excludes zero, at least 3
 * must qualify, and PREDICTIVE needs every qualifying contrast's sign matched
 * and no significant synthetic contrast pointing the other way. It prints each
 * layer's verdict, the qualifying count, sign agreement per contrast and
 * Kendall's tau over the arms (reported, never gating): tau-b from per-arm
 * success@5 where both sides carry scores, so tied arms count as ties, and
 * tau over the orderings otherwise.
 *
 * A layer frozen with qualify 'family' (G2's b4 layer, amendment of
 * 2026-11-11) qualifies reference contrasts on the reference's simultaneous
 * band instead of their own intervals, leaves its sign-forced contrasts out of
 * the minimum, and counts a contrast the reference skipped (an arm invalid) as
 * not qualifying. A layer with a primary contrast also reads it with
 * validity.ts's primaryOutcome, from the primary alone: HELD, NOT_HELD or
 * INCONCLUSIVE (also when the reference skipped it), with the ratio of the
 * synthetic estimate to the reference's and its Fieller interval.
 *
 * One scorecard need not carry every layer. A layer is in the scorecard when it
 * holds all of the layer's mapped contrasts (and, for a live-recall scorecard,
 * is of the layer's protocol, since batch 3 repeats some batch 2 ids over its
 * own questions); a layer with none of them reads NOT_IN_SCORECARD and is left
 * out of the overall line, and a layer with only some of them refuses.
 *
 * A pending reference reads NO_REFERENCE_YET and names it, whether or not the
 * scorecard carries the layer. A missing, corrupt or off-digest reference
 * refuses with VALIDITY_REFERENCE_INVALID. A layer partly in the scorecard, or a
 * scorecard carrying no layer of a measure that has an available reference,
 * refuses with SYNTHETIC_SCORECARD_INVALID; both refusals exit 3 and write
 * nothing. The measure's overall line reads NOT_PREDICTIVE if any layer does,
 * else PREDICTIVE if any layer does, else NO_REFERENCE_YET.
 *
 * The synthetic scorecard is a live-recall scorecard (live-recall-scorecard/v1,
 * from run.ts run --synthetic, whose success@5 comparisons are its contrasts) or
 * any file of the form { contrasts: [{ id, estimate, lo, hi }], orderings?, control?, transports? }.
 * A control scorecard is one whose run.transports is hash (the keyless fixture
 * transports), or an in-process run that records no transports, or a contrasts
 * file marked control. The command refuses it (SYNTHETIC_SCORECARD_INVALID)
 * unless --control is passed, and then labels it as one: its verdict proves the
 * plumbing, never the measure, and is never the verdict we report. A voyage
 * scorecard (run --synthetic --paid) is not a control.
 *
 * A layer that names its counted scorecard in mapping.ts (G2's two layers and
 * the retrieval layers of G1 and G4, preregistration corrections of
 * 2026-11-10) reads only that one: a non-control scorecard carrying the layer
 * must record the named gbrain commit, knobs and question file, or the command
 * refuses with SYNTHETIC_SCORECARD_INVALID and writes nothing. verdict.json
 * records the scorecard's path (relative to the repository root when it is
 * inside it), sha256 and identity, and counted: true
 * only for a non-control scorecard that passed the check on at least one such
 * layer. --secondary reads any other scorecard as a secondary result: the output
 * and verdict.json say so, and it is never the verdict we report.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fiellerRatio } from '../stats/paired.ts';
import { MANIFEST } from './export-references.ts';
import { MAPPING, isMeasure, MEASURES, type Measure } from './mapping.ts';
import { DEFAULT_MIN_QUALIFYING, ValidityReferenceError, kendallTau, kendallTauB, loadReference, primaryOutcome, verdict, type Contrast, type PrimaryOutcome, type Verdict } from './validity.ts';

export const VERDICT_SCHEMA = 'predictive-verdict/v1';
const REPO_ROOT = resolve(import.meta.dir, '../../..');

export class SyntheticScorecardError extends Error {
  readonly code = 'SYNTHETIC_SCORECARD_INVALID';
  constructor(detail: string) {
    super(detail + ' (SYNTHETIC_SCORECARD_INVALID)');
  }
}

export interface SyntheticCard { schema: string; protocol?: string; transports?: string; control: boolean; contrasts: Contrast[]; orderings: Record<string, string[]>; scores: Record<string, Record<string, number>> }

const finite = (...xs: unknown[]) => xs.every(x => typeof x === 'number' && Number.isFinite(x));

/** The synthetic contrasts and arm orderings a scorecard carries. */
export function readSynthetic(value: any): SyntheticCard {
  if (value?.schema === 'live-recall-scorecard/v1') {
    if (typeof value.run?.synthetic?.digest !== 'string') throw new SyntheticScorecardError('a live-recall scorecard is a synthetic side only when its run records a synthetic digest (run.synthetic.digest); this one is a real run');
    const contrasts: Contrast[] = (Array.isArray(value.comparisons) ? value.comparisons : [])
      .filter((c: any) => c?.metric === 'success_at_5' && finite(c.delta) && Array.isArray(c.ci95) && finite(c.ci95[0], c.ci95[1]))
      .map((c: any) => ({ id: c.id, estimate: c.delta, lo: c.ci95[0], hi: c.ci95[1] }));
    const orderings: Record<string, string[]> = {};
    const scores: Record<string, Record<string, number>> = {};
    for (const form of ['exact', 'paraphrase']) {
      const scored = Object.entries(value.arms ?? {})
        .filter(([arm]) => arm !== 'configured_window')
        .map(([arm, row]: [string, any]) => [arm, row?.overall?.[form]?.success_at?.k5?.rate] as const)
        .filter((pair): pair is readonly [string, number] => finite(pair[1]));
      orderings['arms_' + form] = [...scored].sort((a, b) => b[1] - a[1]).map(([arm]) => arm);
      scores['arms_' + form] = Object.fromEntries(scored);
    }
    const transports = typeof value.run?.transports === 'string' ? value.run.transports : undefined;
    const control = transports === undefined ? value.run?.control === true : transports === 'hash';
    return { schema: value.schema, ...(typeof value.protocol === 'string' ? { protocol: value.protocol } : {}), ...(transports ? { transports } : {}), control, contrasts, orderings, scores };
  }
  if (Array.isArray(value?.contrasts)) {
    const contrasts = value.contrasts.map((c: any, i: number) => {
      if (typeof c?.id !== 'string' || !finite(c.estimate, c.lo, c.hi) || c.lo > c.hi) throw new SyntheticScorecardError('contrast ' + i + ' is not { id, estimate, lo, hi }');
      return { id: c.id, estimate: c.estimate, lo: c.lo, hi: c.hi };
    });
    const transports = typeof value.transports === 'string' ? value.transports : undefined;
    return { schema: typeof value.schema === 'string' ? value.schema : 'contrasts', ...(transports ? { transports } : {}), control: value.control === true || transports === 'hash', contrasts, orderings: value.orderings ?? {}, scores: value.scores ?? {} };
  }
  throw new SyntheticScorecardError('not a live-recall scorecard or a { contrasts } file');
}

const excludesZero = (c: { lo: number; hi: number }) => c.lo > 0 || c.hi < 0;

export interface LayerResult {
  id: string;
  reference: string;
  status: 'available' | 'pending' | 'not_in_scorecard';
  verdict: Verdict | 'NOT_IN_SCORECARD';
  in_scorecard: boolean;
  min_qualifying: number;
  /** interval: a reference contrast qualifies on its own 95% interval; family: on the reference's simultaneous band. */
  qualify: 'interval' | 'family';
  qualifying_count: number;
  /** Qualifying contrasts that count toward the minimum (the layer's not_counted left out). */
  qualifying_counted: number;
  mapped_count: number;
  missing_reference?: string;
  /** Mapped contrasts the reference skipped (an arm invalid or absent); they can't qualify. */
  skipped: string[];
  contrasts: Array<{
    reference_id: string; synthetic_id: string;
    reference: { estimate: number; lo: number; hi: number; family_lo?: number; family_hi?: number; qualifies: boolean };
    synthetic: { estimate: number; lo: number; hi: number; excludes_zero: boolean };
    sign_agrees: boolean; counted: 'agree' | 'disagree' | 'not_qualifying';
  }>;
  kendall_tau: Record<string, number | null>;
  /** tau_b: from per-arm scores on both sides; ordering: over the two arm orderings, where a tie counts one way. */
  kendall_tau_method: Record<string, 'tau_b' | 'ordering'>;
  primary?: {
    id: string; outcome: PrimaryOutcome; reason?: 'reference_skipped';
    reference: { estimate: number; lo: number; hi: number } | null;
    synthetic: { estimate: number; lo: number; hi: number };
    /** Synthetic estimate over the reference's, with a Fieller 95% interval (null bounds when unbounded). */
    ratio: { estimate: number | null; lo: number | null; hi: number | null } | null;
  };
  note: string;
}

export function evaluateMeasure(measure: Measure, synthetic: SyntheticCard, manifestPath = MANIFEST) {
  const layers: LayerResult[] = [];
  const synById = new Map(synthetic.contrasts.map(c => [c.id, c]));
  for (const layer of MAPPING[measure].layers) {
    const ref = loadReference(manifestPath, layer.reference);
    const otherProtocol = layer.protocol !== undefined && synthetic.protocol !== undefined && synthetic.protocol !== layer.protocol;
    const missing = layer.pairs.filter(p => !synById.has(p.synthetic)).map(p => p.synthetic);
    if (!otherProtocol && missing.length && missing.length < layer.pairs.length) throw new SyntheticScorecardError('the synthetic scorecard has only part of ' + measure + ' layer ' + layer.id + ': no ' + measure + ' contrast ' + missing.join(', ') + ' (for ' + layer.reference + ')');
    const in_scorecard = !otherProtocol && missing.length === 0;
    const qualify: LayerResult['qualify'] = layer.qualify ?? 'interval';
    const base = { id: layer.id, reference: layer.reference, min_qualifying: DEFAULT_MIN_QUALIFYING, qualify, mapped_count: layer.pairs.length, note: layer.note, in_scorecard };
    const empty = { qualifying_count: 0, qualifying_counted: 0, skipped: [] as string[], contrasts: [], kendall_tau: {}, kendall_tau_method: {} };
    if (!ref) {
      layers.push({ ...base, ...empty, status: 'pending', verdict: 'NO_REFERENCE_YET', missing_reference: layer.reference });
      continue;
    }
    const refById = new Map(ref.contrasts.map(c => [c.id, c]));
    const skipped = layer.pairs.filter(p => !refById.has(p.reference) && ref.skipped?.includes(p.reference)).map(p => p.reference);
    const unknown = layer.pairs.filter(p => !refById.has(p.reference) && !skipped.includes(p.reference)).map(p => p.reference);
    if (unknown.length) throw new ValidityReferenceError(manifestPath, 'reference ' + layer.reference + ' has no contrast ' + unknown.join(', ') + ' named by the ' + measure + ' mapping');
    if (!in_scorecard) {
      layers.push({ ...base, ...empty, status: 'not_in_scorecard', verdict: 'NOT_IN_SCORECARD' });
      continue;
    }
    const pairs = layer.pairs.filter(p => refById.has(p.reference));
    const mapped = pairs.map(p => ({ ...synById.get(p.synthetic)!, id: p.reference }));
    let result: ReturnType<typeof verdict>;
    try {
      result = verdict({ mapped: pairs.map(p => p.reference), reference: ref, synthetic: mapped, qualify, ...(layer.not_counted ? { notCounted: [...layer.not_counted] } : {}) });
    } catch (error) {
      throw new ValidityReferenceError(manifestPath, (error as Error).message + ' (' + measure + ' layer ' + layer.id + ')');
    }
    const tauB = (key: string) => (ref.scores?.[key] && synthetic.scores[key] ? kendallTauB(synthetic.scores[key]!, ref.scores[key]!) : undefined);
    const keys = layer.ordering_keys ?? [];
    const kendall_tau = Object.fromEntries(keys.map(key => [key, tauB(key) !== undefined ? tauB(key)! : ref.orderings?.[key] && synthetic.orderings[key] ? kendallTau(synthetic.orderings[key]!, ref.orderings[key]!) : null]));
    const kendall_tau_method = Object.fromEntries(keys.map(key => [key, tauB(key) !== undefined ? 'tau_b' as const : 'ordering' as const]));
    const primaryPair = layer.primary ? layer.pairs.find(p => p.reference === layer.primary) : undefined;
    if (layer.primary && !primaryPair) throw new SyntheticScorecardError(measure + ' layer ' + layer.id + ' names primary ' + layer.primary + ', which it does not map');
    const primary = primaryPair ? (() => {
      const r = refById.get(primaryPair.reference), s = synById.get(primaryPair.synthetic)!;
      const syn = { estimate: s.estimate, lo: s.lo, hi: s.hi };
      if (!r) return { id: primaryPair.reference, outcome: 'INCONCLUSIVE' as const, reason: 'reference_skipped' as const, reference: null, synthetic: syn, ratio: null };
      return { id: primaryPair.reference, outcome: primaryOutcome(r, s), reference: { estimate: r.estimate, lo: r.lo, hi: r.hi }, synthetic: syn, ratio: fiellerRatio(s, r) };
    })() : undefined;
    layers.push({
      ...base, status: 'available', verdict: result.verdict, qualifying_count: result.qualifying.length,
      qualifying_counted: result.qualifying.filter(id => !layer.not_counted?.includes(id)).length, skipped, kendall_tau, kendall_tau_method, ...(primary ? { primary } : {}),
      contrasts: pairs.map(p => {
        const r = refById.get(p.reference)!, s = synById.get(p.synthetic)!;
        return {
          reference_id: p.reference, synthetic_id: p.synthetic,
          reference: { estimate: r.estimate, lo: r.lo, hi: r.hi, ...(r.family_lo !== undefined ? { family_lo: r.family_lo, family_hi: r.family_hi } : {}), qualifies: result.qualifying.includes(p.reference) },
          synthetic: { estimate: s.estimate, lo: s.lo, hi: s.hi, excludes_zero: excludesZero(s) },
          sign_agrees: s.estimate !== 0 && Math.sign(s.estimate) === Math.sign(r.estimate),
          counted: result.disagree.includes(p.reference) ? 'disagree' as const : result.agree.includes(p.reference) ? 'agree' as const : 'not_qualifying' as const,
        };
      }),
    });
  }
  if (layers.every(l => !l.in_scorecard) && layers.some(l => l.status !== 'pending')) throw new SyntheticScorecardError('the synthetic scorecard' + (synthetic.protocol ? ' (protocol ' + synthetic.protocol + ')' : '') + ' carries no ' + measure + ' layer: no ' + layers.map(l => l.id).join(' or ') + ' contrasts');
  const overall: Verdict = layers.some(l => l.verdict === 'NOT_PREDICTIVE') ? 'NOT_PREDICTIVE' : layers.some(l => l.verdict === 'PREDICTIVE') ? 'PREDICTIVE' : 'NO_REFERENCE_YET';
  return { schema: VERDICT_SCHEMA, measure, title: MAPPING[measure].title, verdict: overall, synthetic: { schema: synthetic.schema, control: synthetic.control, ...(synthetic.transports ? { transports: synthetic.transports } : {}) }, layers };
}

/** The identity a synthetic live-recall scorecard records: gbrain commit and version, knobs, question file and directory digest. */
export function scorecardIdentity(card: any) {
  const run = card?.run ?? {}, syn = run.synthetic ?? {};
  return {
    gbrain_loaded_version: run.gbrain_loaded_version ?? null,
    gbrain_loaded_commit: run.gbrain_loaded_commit ?? null,
    knobs: { unembedded_chunk_share: syn.unembedded_chunk_share ?? null, synopsis_vectors_off: syn.synopsis_vectors_off ?? null, keyword_candidate_bound: syn.keyword_candidate_bound ?? null, shell_page_share: syn.shell_page_share ?? null },
    questions_sha256: syn.questions_sha256 ?? null,
    digest: syn.digest ?? null,
  };
}

/**
 * A layer with a named counted scorecard (mapping.ts) reads only that scorecard: a non-control scorecard carrying the
 * layer must have loaded the named gbrain commit, with the named knobs and question file, or the command refuses.
 */
export function checkCountedScorecard(measure: Measure, card: unknown, result: ReturnType<typeof evaluateMeasure>): number {
  const id = scorecardIdentity(card);
  let checked = 0;
  for (const layer of MAPPING[measure].layers) {
    const spec = layer.counted;
    if (!spec || !result.layers.find(l => l.id === layer.id)?.in_scorecard) continue;
    const wrong = [
      id.gbrain_loaded_commit !== spec.gbrain_commit ? 'gbrain_loaded_commit ' + id.gbrain_loaded_commit + ', expected ' + spec.gbrain_commit : '',
      JSON.stringify(id.knobs) !== JSON.stringify(spec.knobs) ? 'knobs ' + JSON.stringify(id.knobs) + ', expected ' + JSON.stringify(spec.knobs) : '',
      id.questions_sha256 !== spec.questions_sha256 ? 'questions_sha256 ' + id.questions_sha256 + ', expected ' + spec.questions_sha256 : '',
      id.digest !== spec.digest ? 'digest ' + id.digest + ', expected ' + spec.digest : '',
    ].filter(Boolean);
    if (wrong.length) throw new SyntheticScorecardError(measure + ' layer ' + layer.id + ' reads only the counted scorecard the preregistration names (corrections of 2026-11-10); this one differs: ' + wrong.join('; ') + '. Pass --secondary to read it as a secondary result that never gates');
    checked++;
  }
  return checked;
}

const num = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(3);
const iv = (c: { estimate: number; lo: number; hi: number }) => num(c.estimate) + ' [' + num(c.lo) + ', ' + num(c.hi) + ']';

export function renderVerdict(r: ReturnType<typeof evaluateMeasure>, secondary = false): string[] {
  const lines = [r.measure + ' ' + r.title + ': ' + r.verdict + (r.synthetic.control ? ' (control scorecard, hash embeddings: this checks the plumbing and says nothing about the measure)' : '') + (secondary ? ' (secondary scorecard: reported beside the counted one, never the verdict)' : '')];
  for (const l of r.layers) {
    if (l.status === 'pending') { lines.push('  layer ' + l.id + ' vs ' + l.reference + ': NO_REFERENCE_YET (reference ' + l.reference + ' is pending)' + (l.in_scorecard ? '; ' + l.mapped_count + ' mapped contrasts in this scorecard' : '; not in this scorecard')); continue; }
    if (l.status === 'not_in_scorecard') { lines.push('  layer ' + l.id + ' vs ' + l.reference + ': not in this scorecard'); continue; }
    const taus = Object.entries(l.kendall_tau).map(([k, t]) => k + ' ' + (t === null ? 'n/a' : t.toFixed(3)) + (l.kendall_tau_method[k] === 'ordering' ? ' (orderings)' : ''));
    lines.push('  layer ' + l.id + ' vs ' + l.reference + ': ' + l.verdict + ', ' + l.qualifying_count + ' of ' + l.mapped_count + ' reference contrasts qualify' + (l.qualify === 'family' ? ' on the family band' : '') + (l.qualifying_counted !== l.qualifying_count ? ' (' + l.qualifying_counted + ' toward the minimum)' : '') + ' (minimum ' + l.min_qualifying + ')' + (l.skipped.length ? '; skipped by the reference: ' + l.skipped.join(', ') : '') + (taus.length ? '; Kendall tau-b ' + taus.join(', ') : ''));
    const p = l.primary;
    if (p) lines.push('    primary ' + p.id + ': ' + p.outcome + (p.reference ? '; reference ' + iv(p.reference) : '; the reference skipped it') + ', synthetic ' + iv(p.synthetic) + (p.ratio?.estimate != null ? '; ratio synthetic/reference ' + p.ratio.estimate.toFixed(3) + (p.ratio.lo !== null ? ' [' + p.ratio.lo.toFixed(3) + ', ' + p.ratio.hi!.toFixed(3) + ']' : ' (interval unbounded)') : ''));
    for (const c of l.contrasts) lines.push('    ' + c.counted.padEnd(14) + ' ' + c.reference_id + ': reference ' + iv(c.reference) + (c.reference.family_lo !== undefined ? ' family [' + num(c.reference.family_lo) + ', ' + num(c.reference.family_hi!) + ']' : '') + (c.reference.qualifies ? ' qualifies' : '') + '; synthetic ' + iv(c.synthetic) + '; sign ' + (c.sign_agrees ? 'agrees' : 'differs'));
  }
  return lines;
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function main(argv: string[]): number {
  const measure = flag(argv, '--measure'), syntheticPath = flag(argv, '--synthetic'), out = flag(argv, '--out');
  if (!isMeasure(measure) || !syntheticPath) {
    console.error('usage: verdict.ts --measure ' + MEASURES.join('|') + ' --synthetic <scorecard.json> [--manifest <manifest.json>] [--out <verdict.json>] [--control] [--secondary]');
    return 2;
  }
  try {
    let parsed: unknown, raw = Buffer.alloc(0);
    try { raw = readFileSync(syntheticPath); parsed = JSON.parse(raw.toString('utf8')); } catch { throw new SyntheticScorecardError(syntheticPath + ' is not readable JSON'); }
    const synthetic = readSynthetic(parsed);
    if (synthetic.control && !argv.includes('--control')) throw new SyntheticScorecardError(syntheticPath + ' is a control scorecard (' + (synthetic.transports ?? 'no transports recorded') + '); its verdict checks the plumbing and is never the one reported. Pass --control to read it as a control, or score the synthetic brain with run --synthetic --paid');
    const result = evaluateMeasure(measure, synthetic, flag(argv, '--manifest') ?? MANIFEST);
    const secondary = argv.includes('--secondary');
    const counted = !synthetic.control && !secondary && checkCountedScorecard(measure, parsed, result) > 0;
    for (const line of renderVerdict(result, secondary)) console.log(line);
    const inRepo = relative(REPO_ROOT, resolve(syntheticPath));
    if (out) writeFileSync(out, JSON.stringify({ ...result, counted, ...(secondary ? { secondary: true } : {}), scorecard: { path: inRepo.startsWith('..') || isAbsolute(inRepo) ? resolve(syntheticPath) : inRepo, sha256: createHash('sha256').update(raw).digest('hex'), ...scorecardIdentity(parsed) } }, null, 2) + '\n');
    return 0;
  } catch (error) {
    if (error instanceof ValidityReferenceError || error instanceof SyntheticScorecardError) {
      console.error('verdict: REFUSED ' + error.message);
      return 3;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
