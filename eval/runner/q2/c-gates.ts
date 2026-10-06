/**
 * Q2 C-gates decision kit (preregistration "C-gates, typing units").
 *
 *   select   I1/W1: each unit (baseline plus that unit) against the baseline. Its oriented primary metric must be
 *            superior after Holm correction across the units, and every safety condition must hold (an
 *            intersection-union test, no further correction). Selected units are ordered by their I1 standardized
 *            effect (oriented effect / bootstrap standard error), ties by unit id: that order defines P1 ⊂ … ⊂ Pk.
 *   confirm  I2/W2, one opening, every package run in it: fixed-sequence testing (stats/fixed-sequence.ts, never
 *            Holm). Pj is tested only if Pj-1 passed (P0 is the baseline). Pj passes when the added unit's primary is
 *            superior against Pj-1, every earlier unit's primary is noninferior at 0.01 against Pj-1, and every safety
 *            condition holds against the baseline. The longest passing prefix ships.
 *
 * Statistics: cluster bootstrap (10,000 draws, recorded seed) of paired rows; superior means the two-sided 95% lower
 * bound of the oriented difference is above 0, noninferior at m means it is above -m. Holm is applied to one-sided
 * bootstrap p-values at alpha = 0.025 per family (the preregistration's family-wise 0.05 with each test one-sided at
 * 0.025), recorded in the receipt.
 *
 * Each arm is given as `te=<temporal-edges receipt>[+<receipt>...],w=<line-grammar-typing receipt on W>,world=<line-grammar-typing
 * receipt on world-v1>`; the three phrasing files of I1 (or I2), one seed each, are joined with `+`. A temporal-edges receipt must come from a `--c-gate` run (general single-value pass, E5
 * probe and Q2 ledger on every arm).
 *
 *   bun eval/runner/q2/c-gates.ts select --baseline te=..,w=..,world=.. --unit U1:te=..,w=..,world=.. [...] --output <dir> [--joint-u34]
 *   bun eval/runner/q2/c-gates.ts confirm --selection <select receipt> --baseline te=..,w=..,world=.. --package P1:te=..,w=..,world=.. [...] --output <dir>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clusteredPairedDelta, holmAdjusted, superiorityP, type PairedItem } from '../stats/paired.ts';
import { fixedSequence } from '../stats/fixed-sequence.ts';
import { resolveGbrainUnderTest } from '../gbrain-under-test.ts';
import { p5Receipt } from '../p5-brain.ts';
import { flagValue } from '../p5-agent.ts';
import { writeReceipt, type GateOutcome } from '../receipt.ts';
import { campaignGuard } from './campaign.ts';
import { newWrong } from './transitions.ts';

export const SEED = 20261006;
export const DRAWS = 10_000;
export const HOLM_ALPHA_ONE_SIDED = 0.025;
export const NI_MARGIN = 0.01;
export const SPURIOUS_MAX_POINTS = 0.5;
export const INVARIANT_EXPECTED = 240;

type Row = Record<string, unknown>;
export interface ArmData { label: string; te: Row[]; w: Row[]; wSummary: Record<string, unknown>; world: Row[]; sources: Record<string, string> }
export interface MetricSel { metric: string; direction: 'higher' | 'lower'; filter?: (r: Row) => boolean; label: string }

export const UNIT_PRIMARY: Record<string, MetricSel> = {
  U1: { metric: 'trap_ok', direction: 'higher', filter: r => String(r.probe_id).includes(':trap-advises:'), label: 'advisor-trap accuracy' },
  U2: { metric: 'live_recall', direction: 'higher', label: 'live-edge recall' },
  U3: { metric: 'trap_ok', direction: 'higher', filter: r => String(r.probe_id).includes(':trap-invest:'), label: 'investment-trap accuracy' },
  U4: { metric: 'e5_false_starts', direction: 'lower', label: 'false employment starts per E5 probe person, by identity' },
  U34: { metric: 'e5_false_starts', direction: 'lower', label: 'false employment starts per E5 probe person, by identity (joint U3+U4)' },
  U5: { metric: 'ti_end_recall', direction: 'higher', label: 'recall of correct end transitions, by identity' },
  U6: { metric: 'ti_start_recall', direction: 'higher', label: 'recall of correct start transitions, by identity' },
};
const TRAP_FAMILIES = ['advises', 'invest', 'alumni'] as const;
const trapFilter = (f: string) => (r: Row) => String(r.probe_id).includes(`:trap-${f}:`);
export const TEMPORAL_NI: MetricSel[] = [
  ...['now_precision', 'now_recall', 'asof_exact', 'during_f1', 'live_recall', 'correction_ok'].map(m => ({ metric: m, direction: 'higher' as const, label: m })),
  ...TRAP_FAMILIES.map(f => ({ metric: 'trap_ok', direction: 'higher' as const, filter: trapFilter(f), label: `trap_ok (${f})` })),
];

export interface Comparison { label: string; n_pairs: number; n_clusters: number; delta: number; oriented_delta: number; ci95: [number, number] | null; oriented_lower: number | null; se_bootstrap: number | null; p_superior: number | null; excluded_errors: number }

/** Paired cluster-bootstrap comparison of one metric between two arms' rows, oriented so larger is better. */
export function compareMetric(cand: readonly Row[], comp: readonly Row[], sel: MetricSel, idField = 'probe_id'): Comparison {
  const pick = (rows: readonly Row[]) => new Map(rows.filter(r => (!sel.filter || sel.filter(r)) && (typeof r[sel.metric] === 'number' || r.error !== undefined)).map(r => [String(r[idField]), r]));
  const a = pick(comp), b = pick(cand);
  const onlyOne = [...a.keys()].filter(k => !b.has(k)).length + [...b.keys()].filter(k => !a.has(k)).length;
  if (onlyOne) throw new Error(`${sel.label}: ${onlyOne} row(s) appear in only one arm; the arms did not run the same seeds and material`);
  const pairs: PairedItem[] = [];
  let excluded = 0;
  for (const [id, ra] of a) {
    const rb = b.get(id)!;
    if (typeof ra[sel.metric] !== 'number' || typeof rb[sel.metric] !== 'number') { excluded++; continue; }
    pairs.push({ id, cluster: String(ra.cluster ?? id), a: ra[sel.metric] as number, b: rb[sel.metric] as number });
  }
  if (!pairs.length) throw new Error(`${sel.label}: no paired rows`);
  const s = clusteredPairedDelta(pairs, { seed: SEED, draws: DRAWS });
  const sign = sel.direction === 'higher' ? 1 : -1;
  const lower = s.ci95 ? (sign > 0 ? s.ci95[0] : -s.ci95[1]) : null;
  const se = s.bootstrap.length > 1 ? Math.sqrt(s.bootstrap.reduce((acc, x) => acc + (x - s.delta) ** 2, 0) / (s.bootstrap.length - 1)) : null;
  return { label: sel.label, n_pairs: s.n_pairs, n_clusters: s.n_clusters, delta: s.delta, oriented_delta: sign * s.delta, ci95: s.ci95, oriented_lower: lower, se_bootstrap: se, p_superior: superiorityP(s, 0, sel.direction), excluded_errors: excluded };
}

export const superior = (c: Comparison) => c.excluded_errors === 0 && c.oriented_lower !== null && c.oriented_lower > 0;
export const noninferior = (c: Comparison, m = NI_MARGIN) => c.excluded_errors === 0 && c.oriented_lower !== null && c.oriented_lower > -m;

export interface SafetyCheck { id: string; pass: boolean; detail: string; comparison?: Comparison }

const sum = (rows: readonly Row[], metric: string, f?: (r: Row) => boolean) => rows.filter(r => (!f || f(r)) && typeof r[metric] === 'number').reduce((a, r) => a + (r[metric] as number), 0);
const ids = (rows: readonly Row[], fields: string[]) => rows.flatMap(r => fields.flatMap(f => (Array.isArray(r[f]) ? r[f] as string[] : [])));

/** Every safety condition of the preregistration, candidate against comparator. All must hold. */
export function safetyChecks(cand: ArmData, comp: ArmData, o: { invariantExpected?: number } = {}): SafetyCheck[] {
  const out: SafetyCheck[] = [];
  for (const sel of TEMPORAL_NI) {
    try { const c = compareMetric(cand.te, comp.te, sel); out.push({ id: `ni:${sel.label}`, pass: noninferior(c), detail: `oriented lower ${c.oriented_lower?.toFixed(4)} vs > -${NI_MARGIN}${c.excluded_errors ? `; ${c.excluded_errors} errored pair(s)` : ''}`, comparison: c }); }
    catch (e) { out.push({ id: `ni:${sel.label}`, pass: false, detail: (e as Error).message }); }
  }
  for (const f of TRAP_FAMILIES) {
    const a = sum(cand.te, 'trap_ok', trapFilter(f)), b = sum(comp.te, 'trap_ok', trapFilter(f));
    out.push({ id: `trap_count:${f}`, pass: a >= b, detail: `${a} vs comparator ${b}` });
  }
  const inv = cand.te.filter(r => r.kind === 'invariant');
  const invOk = inv.filter(r => r.invariant === 1).length;
  const expected = o.invariantExpected ?? INVARIANT_EXPECTED;
  out.push({ id: 'write_order_invariance', pass: invOk === expected && inv.length === expected, detail: `${invOk}/${inv.length} (needs ${expected}/${expected})` });
  const fresh = newWrong(ids(cand.te, ['ti_wrong_ids', 'e5_false_start_ids']), ids(comp.te, ['ti_wrong_ids', 'e5_false_start_ids']));
  out.push({ id: 'new_wrong_transitions', pass: fresh.length === 0, detail: `${fresh.length} new wrong transition(s) by identity (incl. single-value closures)` });
  const ma = sum(cand.te, 'ti_missing'), mb = sum(comp.te, 'ti_missing');
  out.push({ id: 'missing_correct_transitions', pass: ma <= mb, detail: `${ma} vs comparator ${mb}` });
  const goldTypes = [...new Set(comp.w.filter(r => r.kind === 'edge').map(r => String(r.gold_type)))].sort();
  for (const t of goldTypes) {
    const sel: MetricSel = { metric: 'correctly_typed', direction: 'higher', filter: r => r.kind === 'edge' && r.gold_type === t, label: `W typed recall (${t})` };
    try { const c = compareMetric(cand.w, comp.w, sel, 'id'); out.push({ id: `w_typed_recall:${t}`, pass: noninferior(c), detail: `oriented lower ${c.oriented_lower?.toFixed(4)} vs > -${NI_MARGIN}`, comparison: c }); }
    catch (e) { out.push({ id: `w_typed_recall:${t}`, pass: false, detail: (e as Error).message }); }
  }
  const sa = cand.wSummary.spurious_specific_points as number | null, sb = comp.wSummary.spurious_specific_points as number | null;
  out.push({ id: 'w_spurious_specific_types', pass: typeof sa === 'number' && typeof sb === 'number' && sa - sb <= SPURIOUS_MAX_POINTS, detail: `${sa?.toFixed(2)} vs comparator ${sb?.toFixed(2)} points (at most +${SPURIOUS_MAX_POINTS})` });
  try { const c = compareMetric(cand.world, comp.world, { metric: 'anyTypeMatch', direction: 'higher', filter: r => r.kind === 'edge', label: 'world-v1 anyTypeMatch' }, 'id'); out.push({ id: 'world_v1_any_type_match', pass: noninferior(c), detail: `oriented lower ${c.oriented_lower?.toFixed(4)} vs > -${NI_MARGIN}`, comparison: c }); }
  catch (e) { out.push({ id: 'world_v1_any_type_match', pass: false, detail: (e as Error).message }); }
  return out;
}

export interface UnitSelection { unit: string; primary: Comparison; p_holm: number; holm_pass: boolean; safety: SafetyCheck[]; safety_pass: boolean; selected: boolean; standardized_effect: number | null }

export function selectUnits(baseline: ArmData, units: Record<string, ArmData>, o: { invariantExpected?: number } = {}): { units: UnitSelection[]; order: string[] } {
  const ids = Object.keys(units).sort();
  for (const u of ids) if (!UNIT_PRIMARY[u]) throw new Error(`unknown unit ${u}; units are ${Object.keys(UNIT_PRIMARY).join(', ')}`);
  const prim = ids.map(u => compareMetric(units[u].te, baseline.te, UNIT_PRIMARY[u]));
  const adj = holmAdjusted(prim.map(c => (c.excluded_errors ? 1 : c.p_superior ?? 1)));
  const out = ids.map((u, i) => {
    const safety = safetyChecks(units[u], baseline, o);
    const holmPass = adj[i] <= HOLM_ALPHA_ONE_SIDED && superior(prim[i]);
    const safetyPass = safety.every(s => s.pass);
    return { unit: u, primary: prim[i], p_holm: adj[i], holm_pass: holmPass, safety, safety_pass: safetyPass, selected: holmPass && safetyPass, standardized_effect: prim[i].se_bootstrap ? prim[i].oriented_delta / prim[i].se_bootstrap : null };
  });
  const order = out.filter(u => u.selected).sort((a, b) => ((b.standardized_effect ?? -Infinity) - (a.standardized_effect ?? -Infinity)) || a.unit.localeCompare(b.unit)).map(u => u.unit);
  return { units: out, order };
}

export interface PackageStep { package: string; units: string[]; added: Comparison; earlier: Array<{ unit: string; comparison: Comparison; pass: boolean }>; safety: SafetyCheck[] }

/** Fixed-sequence confirmation over nested packages P1..Pk (packages[j] holds order[0..j]). */
export function confirmPackages(order: readonly string[], baseline: ArmData, packages: readonly ArmData[], o: { invariantExpected?: number } = {}) {
  if (packages.length !== order.length) throw new Error(`the selection ordered ${order.length} unit(s) (${order.join(', ')}), so the confirmation needs ${order.length} package receipt set(s), not ${packages.length}`);
  return fixedSequence<PackageStep>(packages.map((pkg, j) => ({
    id: `P${j + 1}`,
    evaluate: () => {
      const prev = j === 0 ? baseline : packages[j - 1];
      const added = compareMetric(pkg.te, prev.te, UNIT_PRIMARY[order[j]]);
      const earlier = order.slice(0, j).map(u => { const c = compareMetric(pkg.te, prev.te, UNIT_PRIMARY[u]); return { unit: u, comparison: c, pass: noninferior(c) }; });
      const safety = safetyChecks(pkg, baseline, o);
      return { pass: superior(added) && earlier.every(e => e.pass) && safety.every(s => s.pass), detail: { package: `P${j + 1}`, units: order.slice(0, j + 1), added, earlier, safety } };
    },
  })));
}

/** Parse `te=<file>,w=<file>,world=<file>` into an arm. */
export function loadArm(label: string, spec: string): ArmData {
  const parts = Object.fromEntries(spec.split(',').map(kv => kv.split('=') as [string, string]));
  for (const k of ['te', 'w', 'world']) if (!parts[k]) throw new Error(`arm ${label} needs te=<temporal-edges receipt>,w=<typing receipt on W>,world=<typing receipt on world-v1>; ${k} is missing`);
  const read = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as { run_status: string; category: string; resolved_config?: Record<string, unknown>; data: { rows: Row[]; summary: Record<string, unknown> } };
  const tes = parts.te.split('+').map(read), w = read(parts.w), world = read(parts.world);
  for (const [k, r] of [...tes.map(t => ['te', t] as const), ['w', w], ['world', world]] as const) if (r.run_status !== 'completed') throw new Error(`arm ${label}: the ${k} receipt did not complete (run_status ${r.run_status}); rerun it before deciding`);
  if (tes.some(t => t.resolved_config?.c_gate !== true)) throw new Error(`arm ${label}: a temporal-edges receipt is not a --c-gate run (general single-value pass, E5 probe and Q2 ledger on every arm); rerun with --c-gate`);
  const te = tes.flatMap(t => t.data.rows);
  const ids = new Set(te.map(r => String(r.probe_id)));
  if (ids.size !== te.length) throw new Error(`arm ${label}: the temporal-edges receipts share probe ids; each phrasing file runs its own seed`);
  return { label, te, w: w.data.rows, wSummary: w.data.summary, world: world.data.rows, sources: parts };
}

const unitGate = (u: UnitSelection): GateOutcome => ({
  gate: `C.select.${u.unit}`, outcome: u.selected ? 'pass' : 'fail',
  threshold: `primary (${UNIT_PRIMARY[u.unit].label}) superior vs baseline after Holm (one-sided alpha ${HOLM_ALPHA_ONE_SIDED}); every safety condition holds`,
  observed: u.primary.oriented_delta, denominators: { planned: u.primary.n_pairs + u.primary.excluded_errors, attempted: u.primary.n_pairs + u.primary.excluded_errors, scored: u.primary.n_pairs, errors: u.primary.excluded_errors },
  ...(u.selected ? {} : { failed_threshold: [!u.holm_pass ? `primary not superior after Holm (p_holm ${u.p_holm.toFixed(4)}, oriented lower ${u.primary.oriented_lower?.toFixed(4)})` : '', ...u.safety.filter(s => !s.pass).map(s => `${s.id}: ${s.detail}`)].filter(Boolean).join('; ') }),
});

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const campaign = campaignGuard(rest);
  const output = campaign?.output ?? flagValue(rest, '--output');
  if (!output) throw new Error('pass --output <dir> (or the campaign flags)');
  const all = (name: string) => rest.flatMap((a, i) => (a === name ? [rest[i + 1]] : []));
  const baselineSpec = flagValue(rest, '--baseline');
  if (!baselineSpec) throw new Error('pass --baseline te=..,w=..,world=..');
  const baseline = loadArm('baseline', baselineSpec);
  const gut = resolveGbrainUnderTest(null);
  const startedAt = new Date().toISOString();
  if (cmd === 'select') {
    const units = Object.fromEntries(all('--unit').map(s => { const at = s.indexOf(':'); return [s.slice(0, at), loadArm(s.slice(0, at), s.slice(at + 1))]; }));
    if (units.U34 && (units.U3 || units.U4)) throw new Error('U34 replaces U3 and U4 (joint unit); pass either U34 or U3 and U4');
    const r = selectUnits(baseline, units);
    const receipt = p5Receipt({ category: 'q2-c-gates-select', gut, startedAt, rows: [], harnessError: null, gates: r.units.map(unitGate),
      summary: { order: r.order, packages: r.order.map((_, j) => ({ package: `P${j + 1}`, units: r.order.slice(0, j + 1) })), units: r.units },
      basis: 'decision only: receipts in, no model call',
      resolvedConfig: { seed: SEED, draws: DRAWS, holm: { alpha_one_sided: HOLM_ALPHA_ONE_SIDED, family: Object.keys(units).sort() }, ni_margin: NI_MARGIN, spurious_max_points: SPURIOUS_MAX_POINTS, invariant_expected: INVARIANT_EXPECTED,
        arms: { baseline: baseline.sources, ...Object.fromEntries(Object.entries(units).map(([k, v]) => [k, v.sources])) } } });
    // Selection is a decision, not a pass/fail run: a unit that is not selected is an outcome, so the verdict reports the selection.
    writeReceipt(join(output, 'receipt.json'), receipt);
    campaign?.finish(join(output, 'receipt.json'), 0);
    console.log(JSON.stringify({ selected_order: r.order, units: r.units.map(u => ({ unit: u.unit, selected: u.selected, p_holm: u.p_holm, standardized_effect: u.standardized_effect, failed_safety: u.safety.filter(s => !s.pass).map(s => s.id) })) }, null, 2));
    return;
  }
  if (cmd === 'confirm') {
    const selPath = flagValue(rest, '--selection');
    if (!selPath) throw new Error('confirm needs --selection <the select receipt>, which fixes the package order');
    const order = (JSON.parse(readFileSync(selPath, 'utf8')) as { data: { summary: { order: string[] } } }).data.summary.order;
    const pkgs = all('--package').map(s => { const at = s.indexOf(':'); return { id: s.slice(0, at), arm: loadArm(s.slice(0, at), s.slice(at + 1)) }; });
    pkgs.forEach((p, j) => { if (p.id !== `P${j + 1}`) throw new Error(`packages must be passed in order P1..Pk; position ${j + 1} is ${p.id}`); });
    const r = confirmPackages(order, baseline, pkgs.map(p => p.arm));
    const gates: GateOutcome[] = r.results.map(x => ({ gate: `C.confirm.${x.id}`, outcome: x.status === 'pass' ? 'pass' : x.status === 'fail' ? 'fail' : 'not_run',
      threshold: 'added unit superior vs Pj-1; earlier units noninferior at 0.01 vs Pj-1; every safety condition vs baseline (fixed sequence)', observed: x.detail?.added.oriented_delta ?? null,
      denominators: { planned: 1, attempted: x.status === 'not_tested' ? 0 : 1, scored: x.status === 'not_tested' ? 0 : 1, errors: 0 },
      ...(x.status === 'fail' ? { failed_threshold: [!superior(x.detail!.added) ? `added unit not superior (oriented lower ${x.detail!.added.oriented_lower?.toFixed(4)})` : '', ...x.detail!.earlier.filter(e => !e.pass).map(e => `${e.unit} not noninferior`), ...x.detail!.safety.filter(s => !s.pass).map(s => `${s.id}: ${s.detail}`)].filter(Boolean).join('; ') } : {}),
      ...(x.reason ? { reason: x.reason } : {}) }));
    const ships = order.slice(0, r.longest_passing_prefix.length);
    const receipt = p5Receipt({ category: 'q2-c-gates-confirm', gut, startedAt, rows: [], harnessError: null, gates, summary: { order, longest_passing_prefix: r.longest_passing_prefix, units_that_ship: ships, units_reverted: order.slice(ships.length), stopped_at: r.stopped_at, steps: r.results },
      basis: 'decision only: receipts in, no model call', resolvedConfig: { seed: SEED, draws: DRAWS, procedure: 'fixed sequence (stats/fixed-sequence.ts), no Holm', selection_receipt: selPath, ni_margin: NI_MARGIN } });
    writeReceipt(join(output, 'receipt.json'), receipt);
    campaign?.finish(join(output, 'receipt.json'), 0);
    console.log(JSON.stringify({ units_that_ship: ships, steps: r.results.map(x => ({ id: x.id, status: x.status })) }, null, 2));
    return;
  }
  throw new Error('usage: c-gates.ts select|confirm ... (see the file header)');
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(3); });
