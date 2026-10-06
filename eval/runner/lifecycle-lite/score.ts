/**
 * lifecycle-lite scoring: pure functions from retrieved items to per-probe
 * rows, per-case metrics and the report-only contract checks. No system
 * import, no I/O. Gold is the generator ledger
 * (eval/generators/lifecycle-lite-gen.ts), never system output.
 *
 * A value or claim is "in" an item when one of its lexical patterns occurs in
 * the item's text. An item is active at the probe's query time T when the
 * system dates it no later than T (or not at all) and has not marked it
 * superseded by T (`valid_to` unset or after T). A stale value the system
 * returns only in superseded items is history, not stale, the way a struck
 * fence row is history in N1.
 *
 * Checkpoints: `witness` (after ingest and the quiescence wait, before any
 * delete), `pre_delete` (the target's own probe, immediately before its
 * delete), `after_delete` (after every delete and a second quiescence wait)
 * and `after_restart` (after the system restarted with its state kept).
 *
 *   update correct   at the final checkpoint the final value is in an active
 *                    item and no earlier current value is.
 *   as-of correct    the value current at the earlier date is in an item
 *                    active then, and no later value is.
 *   forgotten        a delete target present at `witness` and at
 *                    `pre_delete` (signal) that is in no item at any later
 *                    checkpoint. A target the system never surfaced is
 *                    no-signal and is not scored as a forget.
 *   survivor kept    a retained canary, or a chain's final value, present at
 *                    `witness` and still present after the deletes; the
 *                    survivor floor makes a system that deletes everything
 *                    fail.
 *   restart          anything present after the deletes and missing after
 *                    the restart is lost; a target absent after the deletes
 *                    and back after the restart is reactivated.
 */
import { matchesAny, type LiteProbe, type ProbeKind } from '../../generators/lifecycle-lite-gen.ts';
import type { Outcome } from '../memory-qa/outcomes.ts';
import { HARNESS_FAILURES } from '../memory-qa/outcomes.ts';
import type { Item } from '../systems/types.ts';

export const CHECKPOINTS = ['witness', 'pre_delete', 'after_delete', 'after_restart'] as const;
export type Checkpoint = typeof CHECKPOINTS[number];

/** Draft parameters of the preregistration; open until it is frozen. */
export const LIFECYCLE_LITE_CHECKS = {
  /** Survivors witnessed before the deletes that must still be present at every later checkpoint. */
  survivor_floor: 0.9,
} as const;

export type DeleteStatus = 'deleted' | 'partial' | 'unsupported' | 'error';

/** A matched item, kept in the row for inspection (synthetic, fictional text). */
export interface MatchedItem { rank: number; type: string; active: boolean; valid_from: string | null; valid_to: string | null; sessions: string[]; matches: string[]; text: string }

export interface LiteRow {
  [key: string]: unknown;
  id: string;
  seed: number;
  probe: string;
  kind: ProbeKind;
  checkpoint: Checkpoint;
  outcome: Outcome;
  query_time: string;
  items: number;
  /** Update probes: the gold value is in an active item. */
  gold_served?: boolean;
  /** Update probes: the gold value is in any item, active or superseded. */
  gold_present?: boolean;
  /** Update probes: earlier (current) or later (as-of) values in an active item. */
  stale_active?: string[];
  /** Update probes: earlier or later values returned only in superseded or not-yet-valid items. */
  stale_marked?: string[];
  /** Active items carrying the gold value and a stale value together. */
  mixed_items?: number;
  /** Canary probes: the claim is in some item. */
  present?: boolean;
  present_active?: boolean;
  /** Update probes: correct; canary probes: present. Null for a failed retrieval. */
  pass: boolean | null;
  matched?: MatchedItem[];
  error?: string;
  error_kind?: string;
}

const ms = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(t) ? null : t;
};

/** Active at `queryTime`: dated no later than it (or undated) and not superseded by it. */
export function activeAt(item: Pick<Item, 'valid_from' | 'valid_to'>, queryTime: string): boolean {
  const t = ms(queryTime)!;
  const from = ms(item.valid_from), to = ms(item.valid_to);
  return (from === null || from <= t) && (to === null || to > t);
}

/** Score one successful retrieval for one probe at one checkpoint. */
export function scoreProbe(probe: LiteProbe, checkpoint: Checkpoint, items: readonly Item[], sessionsOf: (sourceIds: string[]) => string[] = () => []): LiteRow {
  const base = { id: `${probe.id}@${checkpoint}`, seed: probe.seed, probe: probe.id, kind: probe.kind, checkpoint, outcome: 'scored' as Outcome, query_time: probe.query_time, items: items.length };
  const matched: MatchedItem[] = [];
  const keep = (item: Item, matches: string[]) => { if (matches.length) matched.push({ rank: item.rank, type: item.type, active: activeAt(item, probe.query_time), valid_from: item.valid_from, valid_to: item.valid_to, sessions: sessionsOf(item.source_ids), matches, text: item.text }); };
  if (probe.kind === 'update_current' || probe.kind === 'update_asof') {
    const others = probe.kind === 'update_current' ? probe.stale : probe.future;
    const active = new Set<string>(), marked = new Set<string>();
    let goldServed = false, goldPresent = false, mixed = 0;
    for (const item of items) {
      const isActive = activeAt(item, probe.query_time);
      const hasGold = matchesAny(item.text, [probe.gold_pattern]);
      const hits = others.filter(o => matchesAny(item.text, [o.pattern])).map(o => o.label);
      keep(item, [...(hasGold ? [probe.gold] : []), ...hits]);
      if (hasGold) { goldPresent = true; if (isActive) goldServed = true; }
      for (const h of hits) (isActive ? active : marked).add(h);
      if (isActive && hasGold && hits.length) mixed++;
    }
    const staleActive = [...active].sort();
    return { ...base, gold_served: goldServed, gold_present: goldPresent, stale_active: staleActive, stale_marked: [...marked].filter(l => !active.has(l)).sort(), mixed_items: mixed, pass: goldServed && staleActive.length === 0, matched };
  }
  let present = false, presentActive = false;
  for (const item of items) {
    if (!matchesAny(item.text, probe.patterns)) continue;
    keep(item, ['claim']);
    present = true;
    if (activeAt(item, probe.query_time)) presentActive = true;
  }
  return { ...base, present, present_active: presentActive, pass: present, matched };
}

export interface DeleteRecord { seed: number; canary: string; probe: string; status: DeleteStatus; error?: string; error_kind?: string; receipt?: Record<string, unknown>; service_ms?: number }

export interface ForgetCase {
  seed: number; probe: string; delete_status: DeleteStatus | 'not_run';
  /** Present at witness and immediately before its delete. */
  signal: boolean;
  /** Present at witness, gone before its own delete (another delete took it). */
  lost_before_delete: boolean;
  residue: Partial<Record<Checkpoint, boolean>>;
  reactivated: boolean;
  forgotten: boolean | null;
}

export interface LiteMetrics {
  final_checkpoint: Checkpoint;
  update: { probes: number; gold_served: number; stale_active: number; correct: number; correct_rate: number | null; stale_marked_only: number; mixed_item_probes: number };
  asof: { probes: number; gold_served: number; future_active: number; correct: number; correct_rate: number | null };
  forget: { targets: number; deletes: Record<DeleteStatus, number>; signal: number; no_signal: number; lost_before_delete: number; forgotten: number; residue_after_delete: number; residue_after_restart: number; reactivated: number; forget_rate: number | null; unsupported: boolean };
  survivors: { witnessed: number; canaries_witnessed: number; values_witnessed: number; kept_after_delete: number; kept_after_restart: number | null; retention: number | null };
  restart: { ran: boolean; lost: number; reactivated: number };
  rows: { total: number; harness_failures: number; product_failures: number; ingest_degraded: number };
}

export type CheckStatus = 'pass' | 'fail' | 'no_signal' | 'unsupported' | 'not_run' | 'incomplete';
export interface LiteChecks { update: CheckStatus; asof: CheckStatus; forget: CheckStatus; survivors: CheckStatus; restart: CheckStatus; overall: 'pass' | 'fail' | 'incomplete'; failed: string[] }

const rate = (n: number, d: number) => (d ? n / d : null);
const key = (probe: string, cp: Checkpoint) => `${probe}@${cp}`;

/** Per-case and aggregate metrics over every seed's rows (one row per probe and checkpoint) and delete records. */
export function liteMetrics(probes: readonly LiteProbe[], rows: readonly LiteRow[], deletes: readonly DeleteRecord[], restartRan: boolean): { metrics: LiteMetrics; forget_cases: ForgetCase[] } {
  const byId = new Map(rows.map(r => [r.id, r]));
  const at = (p: string, cp: Checkpoint) => byId.get(key(p, cp));
  const harness = (r: LiteRow | undefined) => !!r && HARNESS_FAILURES.has(r.outcome);
  const finalCp: Checkpoint = restartRan ? 'after_restart' : 'after_delete';
  const post: Checkpoint[] = restartRan ? ['after_delete', 'after_restart'] : ['after_delete'];

  const upd = probes.filter(p => p.kind === 'update_current');
  const updRows = upd.map(p => at(p.id, finalCp)).filter((r): r is LiteRow => !!r && !harness(r));
  const asof = probes.filter(p => p.kind === 'update_asof');
  const asofRows = asof.map(p => at(p.id, finalCp)).filter((r): r is LiteRow => !!r && !harness(r));

  const deleteOf = new Map(deletes.map(d => [d.probe, d]));
  const forget_cases: ForgetCase[] = probes.filter(p => p.kind === 'forget_target').map(p => {
    const w = at(p.id, 'witness'), pre = at(p.id, 'pre_delete');
    const signal = !!w?.present && !!pre?.present;
    const residue: ForgetCase['residue'] = {};
    for (const cp of post) { const r = at(p.id, cp); if (r && r.pass !== null && !harness(r)) residue[cp] = !!r.present; }
    const status = deleteOf.get(p.id)?.status ?? 'not_run';
    const reactivated = restartRan && residue.after_delete === false && residue.after_restart === true;
    const complete = post.every(cp => cp in residue);
    return {
      seed: p.seed, probe: p.id, delete_status: status, signal, lost_before_delete: !!w?.present && pre?.pass === false, residue, reactivated,
      forgotten: !signal || status === 'unsupported' || !complete ? null : post.every(cp => residue[cp] === false),
    };
  });

  const survivorProbes = probes.filter(p => p.kind === 'survivor' || p.kind === 'update_current');
  const presentIn = (p: LiteProbe, r: LiteRow | undefined) => !!r && r.pass !== null && (p.kind === 'update_current' ? !!r.gold_present : !!r.present);
  const witnessed = survivorProbes.filter(p => presentIn(p, at(p.id, 'witness')));
  const keptAt = (cp: Checkpoint) => witnessed.filter(p => presentIn(p, at(p.id, cp))).length;
  const keptAfterDelete = keptAt('after_delete');
  const keptAfterRestart = restartRan ? keptAt('after_restart') : null;
  const retention = witnessed.length ? Math.min(keptAfterDelete, keptAfterRestart ?? keptAfterDelete) / witnessed.length : null;
  const lost = restartRan ? witnessed.filter(p => presentIn(p, at(p.id, 'after_delete')) && !presentIn(p, at(p.id, 'after_restart'))).length : 0;

  const deleteCounts: Record<DeleteStatus, number> = { deleted: 0, partial: 0, unsupported: 0, error: 0 };
  for (const d of deletes) deleteCounts[d.status]++;
  const signalCases = forget_cases.filter(c => c.signal && c.delete_status !== 'unsupported');
  const forgotten = forget_cases.filter(c => c.forgotten === true).length;
  const metrics: LiteMetrics = {
    final_checkpoint: finalCp,
    update: {
      probes: updRows.length, gold_served: updRows.filter(r => r.gold_served).length, stale_active: updRows.filter(r => r.stale_active?.length).length,
      correct: updRows.filter(r => r.pass).length, correct_rate: rate(updRows.filter(r => r.pass).length, updRows.length),
      stale_marked_only: updRows.filter(r => !r.stale_active?.length && r.stale_marked?.length).length, mixed_item_probes: updRows.filter(r => (r.mixed_items ?? 0) > 0).length,
    },
    asof: { probes: asofRows.length, gold_served: asofRows.filter(r => r.gold_served).length, future_active: asofRows.filter(r => r.stale_active?.length).length, correct: asofRows.filter(r => r.pass).length, correct_rate: rate(asofRows.filter(r => r.pass).length, asofRows.length) },
    forget: {
      targets: forget_cases.length, deletes: deleteCounts, signal: signalCases.length, no_signal: forget_cases.filter(c => !c.signal).length,
      lost_before_delete: forget_cases.filter(c => c.lost_before_delete).length, forgotten,
      residue_after_delete: signalCases.filter(c => c.residue.after_delete).length, residue_after_restart: signalCases.filter(c => c.residue.after_restart).length,
      reactivated: signalCases.filter(c => c.reactivated).length, forget_rate: rate(forgotten, signalCases.length),
      unsupported: deletes.length > 0 && deleteCounts.unsupported === deletes.length,
    },
    survivors: {
      witnessed: witnessed.length, canaries_witnessed: witnessed.filter(p => p.kind === 'survivor').length, values_witnessed: witnessed.filter(p => p.kind === 'update_current').length,
      kept_after_delete: keptAfterDelete, kept_after_restart: keptAfterRestart, retention,
    },
    restart: { ran: restartRan, lost, reactivated: signalCases.filter(c => c.reactivated).length },
    rows: { total: rows.length, harness_failures: rows.filter(r => HARNESS_FAILURES.has(r.outcome)).length, product_failures: rows.filter(r => r.outcome === 'retrieval_error' || r.outcome === 'unsupported').length, ingest_degraded: rows.filter(r => r.outcome === 'ingest_degraded').length },
  };
  return { metrics, forget_cases };
}

/**
 * The report-only contract checks. Any harness failure makes the run
 * incomplete; product failures count as misses. A system that cannot
 * delete is reported `unsupported` for forget and never passes overall.
 */
export function liteChecks(m: LiteMetrics): LiteChecks {
  const incomplete = m.rows.harness_failures > 0;
  const status = (pass: boolean): CheckStatus => (incomplete ? 'incomplete' : pass ? 'pass' : 'fail');
  const update = m.update.probes === 0 ? (incomplete ? 'incomplete' : 'no_signal') : status(m.update.correct === m.update.probes);
  const asof = m.asof.probes === 0 ? (incomplete ? 'incomplete' : 'no_signal') : status(m.asof.correct === m.asof.probes);
  const forget: CheckStatus = m.forget.unsupported ? 'unsupported' : m.forget.signal === 0 ? (incomplete ? 'incomplete' : 'no_signal') : status(m.forget.forgotten === m.forget.signal);
  const survivors: CheckStatus = m.survivors.witnessed === 0 ? (incomplete ? 'incomplete' : 'no_signal') : status((m.survivors.retention ?? 0) >= LIFECYCLE_LITE_CHECKS.survivor_floor);
  const restart: CheckStatus = !m.restart.ran ? 'not_run' : status(m.restart.lost === 0 && m.restart.reactivated === 0);
  const all = { update, asof, forget, survivors, restart };
  const failed = Object.entries(all).filter(([k, v]) => v !== 'pass' && !(k === 'restart' && v === 'not_run')).map(([k, v]) => `${k}:${v}`);
  return { ...all, overall: incomplete ? 'incomplete' : failed.length ? 'fail' : 'pass', failed };
}
