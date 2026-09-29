/**
 * Score lifecycle observations against the evaluator's ledger.
 *
 * Pure functions: no I/O, no gbrain imports. Every number is a count with a
 * named denominator, so a report can say "3 of 21 files" rather than a rate
 * whose base is unclear.
 */
import {
  IDENTITIES, MOVED, NEAR_NAME_SOURCE, NEAR_NAME_WRONG_TARGETS, allCanaries, edgeKey, naiveSlug, timelineKey,
  type Expected, type FactSpec,
} from './scenario.ts';
import type { Snapshot } from './observe.ts';

export interface BijectionScore {
  expected_files: number;
  lost: string[];
  stale: string[];
  duplicate: string[];
  merged: string[];
  orphan: string[];
  /** Pages the observer should not see at all (for a remote caller, private pages). */
  hidden_visible: string[];
  db_only_pages: string[];
  path_drift: string[];
  violations: number;
}

const canaryOwner = new Map<string, string>();
for (const identity of IDENTITIES) for (const c of allCanaries(identity)) canaryOwner.set(c, identity.id);
const ledgerSlugs = new Set<string>();
for (const identity of IDENTITIES) for (const v of Object.values(identity.versions)) if (v) ledgerSlugs.add(naiveSlug(v.path));

function identitiesOnPage(canaries: string[]): string[] {
  return [...new Set(canaries.map(c => canaryOwner.get(c)).filter((x): x is string => !!x))];
}

export function scoreBijection(snap: Snapshot, exp: Expected, hiddenIds: string[] = [], ignoreIds: string[] = []): BijectionScore {
  const s: BijectionScore = {
    expected_files: exp.files.size, lost: [], stale: [], duplicate: [], merged: [], orphan: [], hidden_visible: [],
    db_only_pages: [], path_drift: [], violations: 0,
  };
  for (const [id, v] of exp.files) {
    const withCurrent = snap.pages.filter(p => p.canaries.includes(v.canary));
    const old = allCanaries(IDENTITIES.find(i => i.id === id)!).filter(c => c !== v.canary);
    const withOld = snap.pages.filter(p => !p.canaries.includes(v.canary) && p.canaries.some(c => old.includes(c)));
    if (withCurrent.length === 0) (withOld.length ? s.stale : s.lost).push(id);
    if (withCurrent.length > 1) s.duplicate.push(`${id} x${withCurrent.length}: ${withCurrent.map(p => p.slug).join(', ')}`);
    for (const p of withCurrent) if (p.source_path && p.source_path !== v.path) s.path_drift.push(`${id}: ${p.slug} records ${p.source_path}, file is ${v.path}`);
  }
  for (const p of snap.pages) {
    const ids = identitiesOnPage(p.canaries);
    if (ids.length > 1) { s.merged.push(`${p.slug}: ${ids.join('+')}`); continue; }
    if (ids.length === 1) {
      if (ignoreIds.includes(ids[0])) continue;
      if (hiddenIds.includes(ids[0])) s.hidden_visible.push(`${p.slug} (${ids[0]})`);
      else if (!exp.files.has(ids[0])) s.orphan.push(`${p.slug} (${ids[0]}, file no longer exists)`);
      continue;
    }
    if (ledgerSlugs.has(p.slug)) s.orphan.push(`${p.slug} (no current text)`);
    else s.db_only_pages.push(p.slug);
  }
  s.violations = s.lost.length + s.stale.length + s.duplicate.length + s.merged.length + s.orphan.length;
  return s;
}

export interface PrScore {
  expected: number;
  observed: number;
  true_positive: number;
  precision: number | null;
  recall: number | null;
  missing: string[];
  extra: string[];
}

function pr(expected: Set<string>, observed: Set<string>): PrScore {
  const tp = [...observed].filter(x => expected.has(x));
  return {
    expected: expected.size,
    observed: observed.size,
    true_positive: tp.length,
    precision: observed.size ? tp.length / observed.size : null,
    recall: expected.size ? tp.length / expected.size : null,
    missing: [...expected].filter(x => !observed.has(x)).sort(),
    extra: [...observed].filter(x => !expected.has(x)).sort(),
  };
}

/** Map each observed slug to the identity whose canary its text holds (unique only). */
export function slugIdentities(snap: Snapshot): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of snap.pages) {
    const ids = identitiesOnPage(p.canaries);
    if (ids.length === 1) m.set(p.slug, ids[0]);
  }
  return m;
}

export function scoreEdges(snap: Snapshot, exp: Expected): PrScore & { wrong_entity: string[] } {
  const ids = slugIdentities(snap);
  const observed = new Set<string>();
  for (const p of snap.pages) {
    const from = ids.get(p.slug) ?? `page:${p.slug}`;
    for (const to of p.links) observed.add(edgeKey(from, ids.get(to) ?? `page:${to}`));
  }
  const score = pr(exp.edges, observed);
  const wrong = [...observed].filter(e => NEAR_NAME_WRONG_TARGETS.some(t => e === edgeKey(NEAR_NAME_SOURCE, t)));
  return { ...score, wrong_entity: wrong };
}

export function scoreTimeline(snap: Snapshot, exp: Expected): PrScore {
  const ids = slugIdentities(snap);
  const observed = new Set<string>();
  for (const p of snap.pages) {
    const id = ids.get(p.slug) ?? `page:${p.slug}`;
    for (const t of p.timeline) observed.add(timelineKey(id, t.date, t.summary));
  }
  return pr(exp.timeline, observed);
}

export interface FactEvent {
  spec: FactSpec;
  acknowledged: boolean;
  status: string;
  fact_id: string | null;
  entity_slug: string | null;
  error?: string;
}

export interface FactScore {
  acknowledged: number;
  lost: string[];
  residue: string[];
  collateral: string[];
  blocked: string[];
  wrong_entity: string[];
  errors: string[];
}

/**
 * Facts: an acknowledged write that is not forgotten must stay active under
 * its entity. The forgotten fact must not be active. Collateral is any loss
 * of a fact that shares the forgotten claim's text or entity, or a refused
 * write of the same claim for a different entity after the forget.
 */
export function scoreFacts(snap: Snapshot, events: FactEvent[], forgotten: Set<string>, forgetKey: string): FactScore {
  const s: FactScore = { acknowledged: 0, lost: [], residue: [], collateral: [], blocked: [], wrong_entity: [], errors: [] };
  for (const [entity, r] of Object.entries(snap.facts)) if (r.error) s.errors.push(`recall ${entity}: ${r.error}`);
  const forgottenSpec = events.find(e => e.spec.key === forgetKey)?.spec;
  const activeUnder = (entity: string, text: string) => (snap.facts[entity]?.active ?? []).some(f => f.fact === text);
  for (const e of events) {
    if (e.spec.owner === null) {
      if (e.entity_slug === 'people/exa-cheng' || activeUnder('people/exa-cheng', e.spec.fact)) s.wrong_entity.push(`${e.spec.key} attached to people/exa-cheng`);
      continue;
    }
    if (!e.acknowledged) {
      if (forgottenSpec && e.spec.fact === forgottenSpec.fact && forgotten.size) s.blocked.push(`${e.spec.key}: ${e.status}${e.error ? ` (${e.error})` : ''}`);
      continue;
    }
    s.acknowledged++;
    const active = activeUnder(e.spec.entity, e.spec.fact);
    if (forgotten.has(e.spec.key)) { if (active) s.residue.push(e.spec.key); continue; }
    if (!active) {
      s.lost.push(e.spec.key);
      if (forgotten.size && forgottenSpec && (e.spec.fact === forgottenSpec.fact || e.spec.entity === forgottenSpec.entity)) s.collateral.push(e.spec.key);
    }
  }
  return s;
}

/** A slug a file held before it moved or was renamed should still reach that page (an alias). */
export function scoreOldSlugs(snap: Snapshot, exp: Expected): { checked: number; resolved: string[]; unresolved: string[] } {
  const out = { checked: 0, resolved: [] as string[], unresolved: [] as string[] };
  if (!snap.old_slugs) return out;
  for (const m of MOVED) {
    const probe = snap.old_slugs[m.old_slug];
    const v = exp.files.get(m.id);
    if (!probe || !v) continue;
    out.checked++;
    (probe.canaries.includes(v.canary) ? out.resolved : out.unresolved).push(m.old_slug);
  }
  return out;
}

export interface CheckpointScore {
  bijection: BijectionScore;
  edges: ReturnType<typeof scoreEdges>;
  timeline: PrScore;
  facts?: FactScore;
  old_slugs: ReturnType<typeof scoreOldSlugs>;
  acknowledged_writes_lost: string[];
  read_errors: string[];
}

export function scoreCheckpoint(args: {
  snap: Snapshot;
  exp: Expected;
  hiddenIds: string[];
  ignoreIds?: string[];
  acknowledgedCanaries: Map<string, string>;
  factEvents?: FactEvent[];
  forgotten?: Set<string>;
  forgetKey: string;
}): CheckpointScore {
  const { snap, exp } = args;
  const bijection = scoreBijection(snap, exp, args.hiddenIds, args.ignoreIds ?? []);
  const edges = scoreEdges(snap, exp);
  const timeline = scoreTimeline(snap, exp);
  const facts = args.factEvents ? scoreFacts(snap, args.factEvents, args.forgotten ?? new Set(), args.forgetKey) : undefined;
  const lostFiles = [...bijection.lost, ...bijection.stale].filter(id => args.acknowledgedCanaries.get(id) === exp.files.get(id)?.canary);
  const readErrors = [
    ...(snap.list_error ? [`list_pages: ${snap.list_error}`] : []),
    ...snap.pages.flatMap(p => [
      ...(p.get_error ? [`get_page ${p.slug}: ${p.get_error}`] : []),
      ...(p.links_error ? [`get_links ${p.slug}: ${p.links_error}`] : []),
      ...(p.timeline_error ? [`get_timeline ${p.slug}: ${p.timeline_error}`] : []),
    ]),
  ];
  return {
    bijection, edges, timeline, facts,
    old_slugs: scoreOldSlugs(snap, exp),
    acknowledged_writes_lost: [...lostFiles.map(id => `file:${id}`), ...(facts?.lost ?? []).map(k => `fact:${k}`)],
    read_errors: readErrors,
  };
}
