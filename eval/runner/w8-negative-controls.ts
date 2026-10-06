/**
 * Keyless $0 summary of the W8 live negative controls (lane B part).
 *
 *   bun eval/runner/w8-negative-controls.ts summarize <results dir>
 *
 * Reads the committed receipts and applies the preregistered rule per
 * category: pass when the degraded statistic is at most 0.5 times the real
 * one; inconclusive below the real arm's signal floor or on a failed injection
 * check. Partial faults are reported as the measured drop.
 *
 * Expected layout: cat14-{real,none,swap30}/ (runner report dirs with
 * receipt.json and per-probe dumps), cat29-{real,hash}.receipt.json,
 * cat35-{real,unrelated,half}/receipt.json plus the detailed receipt
 * (*-cat35*.json), cat20-real.receipt.json and cat20-degraded.receipt.json.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarize as summarizeCat20 } from './cat20-judges.ts';

export const RATIO = 0.5;

export interface Control { category: string; statistic: string; real: number | null; degraded: number | null; ratio: number | null; floor: string; floor_met: boolean; injection_ok: boolean; injection_note: string; verdict: 'pass' | 'fail' | 'inconclusive' | 'not run' }

export function decide(c: Omit<Control, 'ratio' | 'verdict'>): Control {
  if (c.real === null || c.degraded === null) return { ...c, ratio: null, verdict: 'not run' };
  const ratio = c.real === 0 ? null : c.degraded / c.real;
  const verdict = !c.floor_met || !c.injection_ok || ratio === null ? 'inconclusive' : ratio <= RATIO ? 'pass' : 'fail';
  return { ...c, ratio, verdict };
}

const read = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

function cat14(dir: string) {
  const arm = (m: string) => read(join(dir, `cat14-${m}`, 'receipt.json'));
  const dumps = (m: string) => existsSync(join(dir, `cat14-${m}`)) ? readdirSync(join(dir, `cat14-${m}`)).filter(f => /^cat14-.*\.json$/.test(f)).map(f => read(join(dir, `cat14-${m}`, f))) : [];
  const win = (r: { data: { summary: { win_rate_calibrated: number; win_eligible_n: number } } } | null) => r ? r.data.summary.win_rate_calibrated : null;
  const real = arm('real'), none = arm('none'), swap = arm('swap30');
  const wins = real ? Math.round(real.data.summary.win_rate_calibrated * real.data.summary.win_eligible_n) : 0;
  const noneDumps = dumps('none');
  const control = decide({ category: 'Cat 14 calibration', statistic: 'calibrated win rate over win-eligible probes', real: win(real), degraded: win(none),
    floor: 'at least 2 calibrated wins in the real arm', floor_met: wins >= 2,
    injection_ok: noneDumps.length > 0 && noneDumps.every((d: { calibration_block_present: boolean }) => d.calibration_block_present === false),
    injection_note: `no calibration block in any calibrated prompt of the none arm (${noneDumps.filter((d: { calibration_block_present: boolean }) => !d.calibration_block_present).length}/${noneDumps.length})` });
  const axes = (r: typeof real) => r ? Object.fromEntries(Object.entries(r.data.summary.per_axis as Record<string, { rate: number }>).map(([k, v]) => [k, v.rate])) : null;
  return { control, partial: { fault: '30% of profile facts swapped', real: win(real), partial: win(swap), drop: win(real) !== null && win(swap) !== null ? win(real)! - win(swap)! : null, axes_real: axes(real), axes_partial: axes(swap) } };
}

function cat29(dir: string) {
  const real = read(join(dir, 'cat29-real.receipt.json')), hash = read(join(dir, 'cat29-hash.receipt.json'));
  return decide({ category: 'Cat 29 think vs search', statistic: 'mean think score from the blind pairwise judge (0 to 5)',
    real: real?.data.think_mean_score_0to5 ?? null, degraded: hash?.data.think_mean_score_0to5 ?? null,
    floor: 'real think mean above 0', floor_met: (real?.data.think_mean_score_0to5 ?? 0) > 0,
    injection_ok: hash?.resolved_config.embed_transport === 'stubbed-hash', injection_note: `degraded receipt embed_transport: ${hash?.resolved_config.embed_transport ?? 'missing'}` });
}

function cat35Detailed(sub: string) {
  if (!existsSync(sub)) return null;
  const f = readdirSync(sub).find(x => /-cat35.*\.json$/.test(x) && x !== 'receipt.json');
  return f ? read(join(sub, f)) : null;
}

function cat35(dir: string) {
  const ws0 = (m: string) => read(join(dir, `cat35-${m}`, 'receipt.json'));
  const cov = (m: string) => { const r = ws0(m); const v = r?.data?.coverage_by_lane?.dream; return typeof v === 'number' ? v : v?.macro ?? null; };
  const detail = (m: string) => cat35Detailed(join(dir, `cat35-${m}`));
  const inputs = (m: string) => detail(m)?.config_snapshot?.control_inputs ?? null;
  const unrelatedInputs = inputs('unrelated');
  const halfInputs = inputs('half');
  const control = decide({ category: 'Cat 35 distillation (dream lane, 8 transcripts)', statistic: 'dream-lane coverage', real: cov('real'), degraded: cov('unrelated'),
    floor: 'real coverage above 0.10', floor_met: (cov('real') ?? 0) > 0.10,
    injection_ok: !!unrelatedInputs && Object.keys(unrelatedInputs).length === 8 && Object.values(unrelatedInputs as Record<string, { donor?: string }>).every(v => !!v.donor),
    injection_note: `unrelated arm lists ${unrelatedInputs ? Object.keys(unrelatedInputs).length : 0} donor inputs with hashes` });
  return { control, partial: { fault: 'each transcript cut to its first half', real: cov('real'), partial: cov('half'), drop: cov('real') !== null && cov('half') !== null ? cov('real')! - cov('half')! : null,
    half_inputs_ok: !!halfInputs && Object.values(halfInputs as Record<string, { chars: number; of_chars: number }>).every(v => v.chars <= v.of_chars / 2 + 1) } };
}

function cat20(dir: string) {
  const real = read(join(dir, 'cat20-real.receipt.json')), deg = read(join(dir, 'cat20-degraded.receipt.json'));
  const stat = (r: { data: { per_question: never[] } } | null) => (r ? summarizeCat20(r.data.per_question).median_of_judge_means_on_all : null);
  return decide({ category: 'Cat 20 brainstorm', statistic: "median of the four judges' mean score on all generated ideas", real: stat(real), degraded: stat(deg),
    floor: 'real median above 1.0', floor_met: (stat(real) ?? 0) > 1.0,
    injection_ok: !!deg && deg.resolved_config.corpus_shuffle_seed === 20261006 && !!deg.resolved_config.corpus_sha256,
    injection_note: `degraded corpus: ${deg?.resolved_config.corpus ?? 'missing'}` });
}

export function summarize(dir: string) {
  const c14 = cat14(dir), c35 = cat35(dir);
  return { rule: `degraded <= ${RATIO} x real`, controls: [c14.control, cat20(dir), cat29(dir), c35.control], partial_faults: [c14.partial, c35.partial] };
}

if (import.meta.main) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== 'summarize' || !dir) { console.error('usage: bun eval/runner/w8-negative-controls.ts summarize <results dir>'); process.exit(2); }
  console.log(JSON.stringify(summarize(dir), null, 2));
}
