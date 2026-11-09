#!/usr/bin/env bun
/**
 * The predictive-validity verdict for one measure: does its synthetic scorecard
 * rank gbrain configurations the way the real brain did?
 *
 *   bun eval/runner/predictive/verdict.ts --measure <G1..G6> --synthetic <scorecard.json> \
 *     [--manifest eval/data/validity-references/manifest.json] [--out verdict.json] [--control]
 *
 * For each layer of the measure (mapping.ts), it loads the reference with
 * validity.ts's loadReference and applies its preregistered verdict(): a
 * reference contrast qualifies when its 95% interval excludes zero, at least 3
 * must qualify, and PREDICTIVE needs every qualifying contrast's sign matched
 * and no significant synthetic contrast pointing the other way. It prints each
 * layer's verdict, the qualifying count, sign agreement per contrast and
 * Kendall's tau over the reference's arm orderings (reported, never gating).
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
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MANIFEST } from './export-references.ts';
import { MAPPING, isMeasure, MEASURES, type Measure } from './mapping.ts';
import { DEFAULT_MIN_QUALIFYING, ValidityReferenceError, kendallTau, loadReference, verdict, type Contrast, type Verdict } from './validity.ts';

export const VERDICT_SCHEMA = 'predictive-verdict/v1';

export class SyntheticScorecardError extends Error {
  readonly code = 'SYNTHETIC_SCORECARD_INVALID';
  constructor(detail: string) {
    super(detail + ' (SYNTHETIC_SCORECARD_INVALID)');
  }
}

export interface SyntheticCard { schema: string; protocol?: string; transports?: string; control: boolean; contrasts: Contrast[]; orderings: Record<string, string[]> }

const finite = (...xs: unknown[]) => xs.every(x => typeof x === 'number' && Number.isFinite(x));

/** The synthetic contrasts and arm orderings a scorecard carries. */
export function readSynthetic(value: any): SyntheticCard {
  if (value?.schema === 'live-recall-scorecard/v1') {
    const contrasts: Contrast[] = (Array.isArray(value.comparisons) ? value.comparisons : [])
      .filter((c: any) => c?.metric === 'success_at_5' && finite(c.delta) && Array.isArray(c.ci95) && finite(c.ci95[0], c.ci95[1]))
      .map((c: any) => ({ id: c.id, estimate: c.delta, lo: c.ci95[0], hi: c.ci95[1] }));
    const orderings: Record<string, string[]> = {};
    for (const form of ['exact', 'paraphrase']) {
      orderings['arms_' + form] = Object.entries(value.arms ?? {})
        .filter(([arm]) => arm !== 'configured_window')
        .map(([arm, row]: [string, any]) => [arm, row?.overall?.[form]?.success_at?.k5?.rate] as const)
        .filter((pair): pair is readonly [string, number] => finite(pair[1]))
        .sort((a, b) => b[1] - a[1])
        .map(([arm]) => arm);
    }
    const transports = typeof value.run?.transports === 'string' ? value.run.transports : undefined;
    const control = transports === undefined ? value.run?.control === true : transports === 'hash';
    return { schema: value.schema, ...(typeof value.protocol === 'string' ? { protocol: value.protocol } : {}), ...(transports ? { transports } : {}), control, contrasts, orderings };
  }
  if (Array.isArray(value?.contrasts)) {
    const contrasts = value.contrasts.map((c: any, i: number) => {
      if (typeof c?.id !== 'string' || !finite(c.estimate, c.lo, c.hi) || c.lo > c.hi) throw new SyntheticScorecardError('contrast ' + i + ' is not { id, estimate, lo, hi }');
      return { id: c.id, estimate: c.estimate, lo: c.lo, hi: c.hi };
    });
    const transports = typeof value.transports === 'string' ? value.transports : undefined;
    return { schema: typeof value.schema === 'string' ? value.schema : 'contrasts', ...(transports ? { transports } : {}), control: value.control === true || transports === 'hash', contrasts, orderings: value.orderings ?? {} };
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
  qualifying_count: number;
  mapped_count: number;
  missing_reference?: string;
  contrasts: Array<{
    reference_id: string; synthetic_id: string;
    reference: { estimate: number; lo: number; hi: number; qualifies: boolean };
    synthetic: { estimate: number; lo: number; hi: number; excludes_zero: boolean };
    sign_agrees: boolean; counted: 'agree' | 'disagree' | 'not_qualifying';
  }>;
  kendall_tau: Record<string, number | null>;
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
    const base = { id: layer.id, reference: layer.reference, min_qualifying: DEFAULT_MIN_QUALIFYING, mapped_count: layer.pairs.length, note: layer.note, in_scorecard };
    if (!ref) {
      layers.push({ ...base, status: 'pending', verdict: 'NO_REFERENCE_YET', qualifying_count: 0, missing_reference: layer.reference, contrasts: [], kendall_tau: {} });
      continue;
    }
    const refById = new Map(ref.contrasts.map(c => [c.id, c]));
    const unknown = layer.pairs.filter(p => !refById.has(p.reference)).map(p => p.reference);
    if (unknown.length) throw new ValidityReferenceError(manifestPath, 'reference ' + layer.reference + ' has no contrast ' + unknown.join(', ') + ' named by the ' + measure + ' mapping');
    if (!in_scorecard) {
      layers.push({ ...base, status: 'not_in_scorecard', verdict: 'NOT_IN_SCORECARD', qualifying_count: 0, contrasts: [], kendall_tau: {} });
      continue;
    }
    const mapped = layer.pairs.map(p => ({ ...synById.get(p.synthetic)!, id: p.reference }));
    const result = verdict({ mapped: layer.pairs.map(p => p.reference), reference: ref, synthetic: mapped });
    const kendall_tau = Object.fromEntries((layer.ordering_keys ?? []).map(key => [key, ref.orderings?.[key] && synthetic.orderings[key] ? kendallTau(synthetic.orderings[key]!, ref.orderings[key]!) : null]));
    layers.push({
      ...base, status: 'available', verdict: result.verdict, qualifying_count: result.qualifying.length, kendall_tau,
      contrasts: layer.pairs.map(p => {
        const r = refById.get(p.reference)!, s = synById.get(p.synthetic)!;
        return {
          reference_id: p.reference, synthetic_id: p.synthetic,
          reference: { estimate: r.estimate, lo: r.lo, hi: r.hi, qualifies: excludesZero(r) },
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

const num = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(3);
const iv = (c: { estimate: number; lo: number; hi: number }) => num(c.estimate) + ' [' + num(c.lo) + ', ' + num(c.hi) + ']';

export function renderVerdict(r: ReturnType<typeof evaluateMeasure>): string[] {
  const lines = [r.measure + ' ' + r.title + ': ' + r.verdict + (r.synthetic.control ? ' (control scorecard, hash embeddings: this checks the plumbing and says nothing about the measure)' : '')];
  for (const l of r.layers) {
    if (l.status === 'pending') { lines.push('  layer ' + l.id + ' vs ' + l.reference + ': NO_REFERENCE_YET (reference ' + l.reference + ' is pending)' + (l.in_scorecard ? '; ' + l.mapped_count + ' mapped contrasts in this scorecard' : '; not in this scorecard')); continue; }
    if (l.status === 'not_in_scorecard') { lines.push('  layer ' + l.id + ' vs ' + l.reference + ': not in this scorecard'); continue; }
    const taus = Object.entries(l.kendall_tau).map(([k, t]) => k + ' ' + (t === null ? 'n/a' : t.toFixed(3)));
    lines.push('  layer ' + l.id + ' vs ' + l.reference + ': ' + l.verdict + ', ' + l.qualifying_count + ' of ' + l.mapped_count + ' reference contrasts qualify (minimum ' + l.min_qualifying + ')' + (taus.length ? '; Kendall tau ' + taus.join(', ') : ''));
    for (const c of l.contrasts) lines.push('    ' + c.counted.padEnd(14) + ' ' + c.reference_id + ': reference ' + iv(c.reference) + (c.reference.qualifies ? ' qualifies' : '') + '; synthetic ' + iv(c.synthetic) + '; sign ' + (c.sign_agrees ? 'agrees' : 'differs'));
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
    console.error('usage: verdict.ts --measure ' + MEASURES.join('|') + ' --synthetic <scorecard.json> [--manifest <manifest.json>] [--out <verdict.json>] [--control]');
    return 2;
  }
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(syntheticPath, 'utf8')); } catch { throw new SyntheticScorecardError(syntheticPath + ' is not readable JSON'); }
    const synthetic = readSynthetic(parsed);
    if (synthetic.control && !argv.includes('--control')) throw new SyntheticScorecardError(syntheticPath + ' is a control scorecard (' + (synthetic.transports ?? 'no transports recorded') + '); its verdict checks the plumbing and is never the one reported. Pass --control to read it as a control, or score the synthetic brain with run --synthetic --paid');
    const result = evaluateMeasure(measure, synthetic, flag(argv, '--manifest') ?? MANIFEST);
    for (const line of renderVerdict(result)) console.log(line);
    if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
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
