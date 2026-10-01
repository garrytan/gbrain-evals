/**
 * N1 knowledge-update generator: a seeded value-change ledger for fictional
 * people and companies, and the gold an independent oracle derives from it.
 *
 * Three kinds of chain, each a sequence of values written in rounds
 * (round 0 is the first value, round k the k-th update, then one extra
 * update written concurrently):
 *
 *   fence chains       a person's attribute ("Home city is ...", "Works at
 *                      ...") as rows of the page's Facts fence. An update
 *                      strikes the current row with `superseded by #N` and
 *                      appends the new row (explicit supersession). A revert
 *                      chain returns to an earlier value, as a new row with
 *                      the earlier claim text.
 *   ontology chains    a person's ontology dimension written with
 *                      ontology_propose and a valid-time date: forward
 *                      updates, reverts with the same and with distinct
 *                      provenance, and a late-recorded backdated value.
 *   trajectory chains  a company's typed metric rows (claim_metric mrr or
 *                      burn_rate) in its Facts fence: appended months and
 *                      corrections that strike an earlier month's row.
 *
 * Gold never comes from gbrain. The fence oracle is the author's own fence
 * (the active row of a chain is its current value; struck rows are its
 * history). The ontology oracle is valid time (the N3 semantics): the value
 * at day t is the observation with the latest valid_from on or before t,
 * ties going to the later recorded one; "now" is after every date. The
 * trajectory oracle charts every unstruck point in date order.
 *
 * Private chains (fence rows, ontology observations and trajectory points
 * with visibility private) carry exposure controls in the N6 style: a
 * trusted local caller must see them, a remote caller must not, and a public
 * twin on the same entity proves the remote probe can see that surface.
 *
 * All names are fictional placeholders.
 */
import { Rng, addDays, fingerprint, tokenFactory } from './seeded.ts';

export const N1_GENERATOR_VERSION = 'n1-knowledge-update-gen@1';
export const N1_DEFAULT_SEED = 11;
/** Sequential update rounds after round 0. */
export const N1_MAX_DEPTH = 4;

export type Visibility = 'world' | 'private';
export type GoldState = 'sequential' | 'concurrent';
export type UpdateKind = 'explicit' | 'revert' | 'forward' | 'revert-same-source' | 'revert-distinct-source' | 'backdated' | 'append' | 'correction' | 'exposure';

export interface N1Entity { slug: string; title: string; type: 'person' | 'company' }

export interface FenceValue { label: string; token: string; valid_from: string }
export interface FenceChain {
  id: string;
  entity: string;
  attr: 'city' | 'employer';
  /** Token in every claim of the chain, used as the search query. */
  key: string;
  kind: 'explicit' | 'revert';
  depth: number;
  visibility: Visibility;
  /** values[r] is written in round r (0..depth). */
  values: FenceValue[];
  concurrent: FenceValue;
}

export interface OntologyObservation { value: string; token: string; valid_from: string; source: string }
export interface OntologyChain {
  id: string;
  entity: string;
  dimension: string;
  kind: 'forward' | 'revert-same-source' | 'revert-distinct-source' | 'backdated' | 'exposure';
  depth: number;
  visibility: Visibility;
  observations: OntologyObservation[];
  concurrent: OntologyObservation;
}

export interface TrajectoryPoint { month: string; value: number; token: string }
export type TrajectoryOp = { op: 'append'; point: TrajectoryPoint } | { op: 'correct'; month: string; point: TrajectoryPoint };
export interface TrajectoryChain {
  id: string;
  entity: string;
  metric: 'mrr' | 'burn_rate';
  key: string;
  kind: 'append' | 'correction' | 'exposure';
  depth: number;
  visibility: Visibility;
  initial: TrajectoryPoint[];
  /** ops[k-1] is applied in round k. */
  ops: TrajectoryOp[];
  concurrent: TrajectoryOp;
}

export interface N1Ledger {
  generator_version: string;
  seed: number;
  entities: N1Entity[];
  fence: FenceChain[];
  ontology: OntologyChain[];
  trajectory: TrajectoryChain[];
  /** A key no chain uses: a negative control for recall and search. */
  ghost_key: string;
}

export interface N1World { ledger: N1Ledger; fingerprint: string }

const PEOPLE = ['Alder', 'Birch', 'Cedar', 'Dune', 'Ember', 'Fern'];
const COMPANIES = ['Gamma', 'Delta', 'Kappa'];
const CITIES = ['Lisbon', 'Porto', 'Braga', 'Faro', 'Leiria', 'Evora', 'Coimbra', 'Aveiro', 'Viseu', 'Tomar', 'Sintra', 'Setubal'];
const EMPLOYERS = ['Orchard Labs', 'Harbor Works', 'Quarry Systems', 'Lantern Media', 'Summit Freight', 'Meadow Health', 'Granite Bank', 'Willow Robotics'];
const ROLES = ['engineer', 'manager', 'director', 'advisor', 'founder', 'analyst'];
const RISK = ['low', 'medium', 'high'];
const STYLE = ['deliberate', 'fast', 'consensus'];

const slugOf = (name: string, type: 'person' | 'company') => `${type === 'person' ? 'people' : 'companies'}/${name.toLowerCase()}-example`;

/** Distinct labels from a pool; a revert reuses an earlier label. */
function labelSequence(rng: Rng, pool: readonly string[], n: number): string[] {
  return rng.shuffle(pool).slice(0, n);
}

export function generateN1World(opts: { seed?: number } = {}): N1World {
  const seed = opts.seed ?? N1_DEFAULT_SEED;
  const rng = new Rng(seed);
  const token = tokenFactory(rng);
  const keys = new Set<string>();
  const key = () => { for (;;) { const k = `n1k${rng.letters(6)}`; if (!keys.has(k)) { keys.add(k); return k; } } };
  const entities: N1Entity[] = [
    ...PEOPLE.map(n => ({ slug: slugOf(n, 'person'), title: `${n} Example`, type: 'person' as const })),
    ...COMPANIES.map(n => ({ slug: slugOf(n, 'company'), title: `${n} Example Co`, type: 'company' as const })),
  ];
  const people = entities.filter(e => e.type === 'person');
  const companies = entities.filter(e => e.type === 'company');

  // Fence chains: two per person, depths 1..4 three times each, a revert at depths 2, 3 and 4.
  const depths = rng.shuffle([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
  const revertAt = new Set<number>();
  for (const d of [2, 3, 4]) revertAt.add(depths.findIndex((x, i) => x === d && !revertAt.has(i)));
  const fence: FenceChain[] = [];
  let i = 0;
  for (const [pi, person] of people.entries()) {
    for (const attr of ['city', 'employer'] as const) {
      const depth = depths[i];
      const kind = revertAt.has(i) ? 'revert' : 'explicit';
      const labels = labelSequence(rng, attr === 'city' ? CITIES : EMPLOYERS, depth + 2);
      let day = addDays('2019-01-01', rng.int(0, 120));
      const values: FenceValue[] = [];
      for (let r = 0; r <= depth; r++) {
        if (r > 0) day = addDays(day, rng.int(200, 400));
        const back = kind === 'revert' && r === depth ? values[depth - 2] : null;
        values.push(back ? { label: back.label, token: back.token, valid_from: day } : { label: labels[r], token: token(), valid_from: day });
      }
      fence.push({
        id: `fence-${pi + 1}-${attr}`, entity: person.slug, attr, key: key(), kind, depth,
        visibility: attr === 'city' && pi >= 4 ? 'private' : 'world',
        values, concurrent: { label: labels[depth + 1], token: token(), valid_from: addDays(day, rng.int(200, 400)) },
      });
      i++;
    }
  }

  // Ontology chains.
  const obs = (value: string, valid_from: string, source = 'manual'): OntologyObservation => {
    const t = token();
    return { value: `${value} ${t}`, token: t, valid_from, source };
  };
  const forward = (id: string, entity: string, dimension: string, pool: readonly string[], depth: number): OntologyChain => {
    const labels = labelSequence(rng, pool, depth + 2);
    let day = addDays('2019-03-01', rng.int(0, 90));
    const observations: OntologyObservation[] = [];
    for (let r = 0; r <= depth; r++) { if (r > 0) day = addDays(day, rng.int(200, 400)); observations.push(obs(labels[r], day)); }
    return { id, entity, dimension, kind: 'forward', depth, visibility: 'world', observations, concurrent: obs(labels[depth + 1], addDays(day, rng.int(200, 400))) };
  };
  const revert = (id: string, entity: string, dimension: string, pool: readonly string[], distinct: boolean): OntologyChain => {
    const [a, b, c] = labelSequence(rng, pool, 3);
    const d0 = addDays('2019-06-01', rng.int(0, 90));
    const d1 = addDays(d0, rng.int(300, 500));
    const d2 = addDays(d1, rng.int(300, 500));
    const first = obs(a, d0, distinct ? `n1/${id}/1` : 'manual');
    const observations = [first, obs(b, d1, distinct ? `n1/${id}/2` : 'manual'), { ...first, valid_from: d2, source: distinct ? `n1/${id}/3` : 'manual' }];
    return { id, entity, dimension, kind: distinct ? 'revert-distinct-source' : 'revert-same-source', depth: 2, visibility: 'world', observations, concurrent: obs(c, addDays(d2, rng.int(200, 400)), distinct ? `n1/${id}/4` : 'manual') };
  };
  const [p1, p2, p3, p4, p5, p6] = people.map(p => p.slug);
  const backdatedLabels = labelSequence(rng, ROLES, 4);
  const b0 = addDays('2020-01-01', rng.int(0, 60));
  const b1 = addDays(b0, rng.int(900, 1100));
  const b2 = addDays(b0, rng.int(300, 600));
  const ontology: OntologyChain[] = [
    forward('ont-1-location', p1, 'location', CITIES, 1),
    forward('ont-2-employer', p2, 'employer', EMPLOYERS, 2),
    forward('ont-3-role', p3, 'role', ROLES, 3),
    forward('ont-4-location', p4, 'location', CITIES, 4),
    revert('ont-5-role', p5, 'role', ROLES, false),
    revert('ont-6-employer', p6, 'employer', EMPLOYERS, true),
    {
      id: 'ont-1-role', entity: p1, dimension: 'role', kind: 'backdated', depth: 2, visibility: 'world',
      observations: [obs(backdatedLabels[0], b0), obs(backdatedLabels[1], b1), obs(backdatedLabels[2], b2)],
      concurrent: obs(backdatedLabels[3], addDays(b1, rng.int(200, 400))),
    },
    { id: 'ont-2-risk', entity: p2, dimension: 'risk_tolerance', kind: 'exposure', depth: 0, visibility: 'private',
      observations: [obs(rng.pick(RISK), addDays('2021-01-01', rng.int(0, 90)))], concurrent: obs(rng.pick(RISK), addDays('2024-01-01', rng.int(0, 90))) },
    { id: 'ont-2-style', entity: p2, dimension: 'decision_style', kind: 'exposure', depth: 0, visibility: 'world',
      observations: [obs(rng.pick(STYLE), addDays('2021-01-01', rng.int(0, 90)))], concurrent: obs(rng.pick(STYLE), addDays('2024-01-01', rng.int(0, 90))) },
  ];

  // Trajectory chains: monthly points from 2024-01.
  const month = (k: number) => { const y = 2024 + Math.floor(k / 12); const m = (k % 12) + 1; return `${y}-${String(m).padStart(2, '0')}`; };
  const usedValues = new Set<number>();
  const value = (base: number) => { for (;;) { const v = base + rng.int(1, 400) * 50; if (!usedValues.has(v)) { usedValues.add(v); return v; } } };
  const point = (k: number, base: number): TrajectoryPoint => ({ month: month(k), value: value(base), token: token() });
  const trajectory: TrajectoryChain[] = [];
  const plans: Array<{ company: N1Entity; ops: Array<'append' | 'correct'>; kind: 'append' | 'correction' }> = [
    { company: companies[0], ops: ['append', 'append'], kind: 'append' },
    { company: companies[1], ops: ['append', 'correct', 'append'], kind: 'correction' },
    { company: companies[2], ops: ['correct'], kind: 'correction' },
  ];
  for (const [ci, plan] of plans.entries()) {
    const base = 10_000 * (ci + 1);
    const initial = [0, 1, 2].map(k => point(k, base));
    let next = 3;
    const months = initial.map(p => p.month);
    const ops: TrajectoryOp[] = plan.ops.map(o => {
      if (o === 'append') { const p = point(next++, base); months.push(p.month); return { op: 'append', point: p }; }
      const m = months[rng.int(0, months.length - 1)];
      return { op: 'correct', month: m, point: { month: m, value: value(base), token: token() } };
    });
    trajectory.push({ id: `traj-${ci + 1}-mrr`, entity: plan.company.slug, metric: 'mrr', key: key(), kind: plan.kind, depth: ops.length, visibility: 'world', initial, ops, concurrent: { op: 'append', point: point(next, base) } });
  }
  trajectory.push({
    id: 'traj-3-burn', entity: companies[2].slug, metric: 'burn_rate', key: key(), kind: 'exposure', depth: 0, visibility: 'private',
    initial: [0, 1].map(k => point(k, 2_000)), ops: [], concurrent: { op: 'append', point: point(2, 2_000) },
  });

  const ledger: N1Ledger = { generator_version: N1_GENERATOR_VERSION, seed, entities, fence, ontology, trajectory, ghost_key: key() };
  return { ledger, fingerprint: fingerprint(ledger) };
}

// ─── Fence rendering (the author's canonical text; independent of gbrain) ──

export const FENCE_BEGIN = '<!--- gbrain:facts:begin -->';
export const FENCE_END = '<!--- gbrain:facts:end -->';

export interface FenceRow {
  row: number;
  claim: string;
  visibility: Visibility;
  valid_from: string;
  valid_until: string;
  context: string;
  active: boolean;
  metric?: { name: string; value: number; unit: string; period: string };
  /** Evaluator bookkeeping, not rendered. */
  chain: string;
  token: string;
}

export function fenceClaim(c: FenceChain, v: FenceValue): string {
  return `${c.attr === 'city' ? 'Home city is' : 'Works at'} ${v.label} ${c.key} ${v.token}`;
}

export function trajectoryClaim(c: TrajectoryChain, p: TrajectoryPoint): string {
  return `${c.metric === 'mrr' ? 'MRR' : 'Burn rate'} for ${p.month} was ${p.value} USD ${c.key} ${p.token}`;
}

/** Index of the value a chain holds after `round` (0..N1_MAX_DEPTH, or 'C' for the concurrent round). */
export type Round = number | 'C';
export const ROUNDS: readonly Round[] = [0, 1, 2, 3, 4, 'C'];

function chainValueAt(c: FenceChain, round: Round): FenceValue[] {
  const seq = c.values.slice(0, round === 'C' ? c.values.length : Math.min(round, c.depth) + 1);
  return round === 'C' ? [...seq, c.concurrent] : seq;
}

function trajectoryOpsAt(c: TrajectoryChain, round: Round): TrajectoryOp[] {
  const seq = c.ops.slice(0, round === 'C' ? c.ops.length : Math.min(round, c.depth));
  return round === 'C' ? [...seq, c.concurrent] : seq;
}

/**
 * The entity page's fence rows after `round`, in recorded order: rows are
 * appended round by round, chain by chain; an update strikes the chain's
 * previous active row with `superseded by #N`.
 */
export function fenceRowsAt(ledger: N1Ledger, entity: string, round: Round): FenceRow[] {
  const rows: FenceRow[] = [];
  const activeRow = new Map<string, FenceRow>();
  const add = (chain: string, claim: string, token: string, visibility: Visibility, valid_from: string, metric?: FenceRow['metric'], supersedes?: FenceRow) => {
    const row: FenceRow = { row: rows.length + 1, claim, visibility, valid_from, valid_until: '', context: '', active: true, chain, token, ...(metric ? { metric } : {}) };
    if (supersedes) { supersedes.active = false; supersedes.valid_until = valid_from; supersedes.context = `superseded by #${row.row}`; }
    rows.push(row);
    return row;
  };
  const fenceChains = ledger.fence.filter(c => c.entity === entity);
  const trajChains = ledger.trajectory.filter(c => c.entity === entity);
  const order = ROUNDS.slice(0, ROUNDS.indexOf(round) + 1);
  for (const r of order) {
    for (const c of fenceChains) {
      const vals = chainValueAt(c, r);
      const prev = r === 0 ? 0 : chainValueAt(c, order[order.indexOf(r) - 1]).length;
      for (let k = prev; k < vals.length; k++) {
        activeRow.set(c.id, add(c.id, fenceClaim(c, vals[k]), vals[k].token, c.visibility, vals[k].valid_from, undefined, activeRow.get(c.id)));
      }
    }
    for (const c of trajChains) {
      const metric = (p: TrajectoryPoint) => ({ name: c.metric, value: p.value, unit: 'USD', period: 'monthly' });
      if (r === 0) {
        for (const p of c.initial) activeRow.set(`${c.id}|${p.month}`, add(c.id, trajectoryClaim(c, p), p.token, c.visibility, `${p.month}-01`, metric(p)));
        continue;
      }
      const ops = trajectoryOpsAt(c, r);
      const prev = trajectoryOpsAt(c, order[order.indexOf(r) - 1]).length;
      for (const o of ops.slice(prev)) {
        const k = `${c.id}|${o.point.month}`;
        activeRow.set(k, add(c.id, trajectoryClaim(c, o.point), o.point.token, c.visibility, `${o.point.month}-01`, metric(o.point), o.op === 'correct' ? activeRow.get(k) : undefined));
      }
    }
  }
  return rows;
}

const cell = (s: string) => s.replace(/\|/g, '\\|');

export function renderFence(rows: readonly FenceRow[]): string {
  const typed = rows.some(r => r.metric);
  const header = `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |${typed ? ' claim_metric | claim_value | claim_unit | claim_period |' : ''}`;
  const sep = `|---|---|---|---|---|---|---|---|---|---|${typed ? '---|---|---|---|' : ''}`;
  const lines = rows.map(r => {
    const claim = r.active ? r.claim : `~~${r.claim}~~`;
    const base = `| ${r.row} | ${cell(claim)} | fact | 1.0 | ${r.visibility} | medium | ${r.valid_from} | ${r.valid_until} | n1-ledger | ${cell(r.context)} |`;
    return typed ? `${base} ${r.metric?.name ?? ''} | ${r.metric?.value ?? ''} | ${r.metric?.unit ?? ''} | ${r.metric?.period ?? ''} |` : base;
  });
  return ['## Facts', '', FENCE_BEGIN, '', header, sep, ...lines, FENCE_END, ''].join('\n');
}

export function renderEntityPage(ledger: N1Ledger, entity: N1Entity, round: Round): string {
  const intro = `${entity.title} is a fictional ${entity.type} used by the N1 knowledge-update category.`;
  return `---\ntitle: ${entity.title}\ntype: ${entity.type}\n---\n${intro}\n\n${renderFence(fenceRowsAt(ledger, entity.slug, round))}`;
}

// ─── Ontology oracle (valid time) ─────────────────────────────────────────

export function ontologyObservationsAt(c: OntologyChain, round: Round): OntologyObservation[] {
  const seq = c.observations.slice(0, round === 'C' ? c.observations.length : Math.min(round, c.depth) + 1);
  return round === 'C' ? [...seq, c.concurrent] : seq;
}

/** Value at day `asof` (null = after every date): latest valid_from on or before it, later recorded wins ties. */
export function ontologyValueAt(observations: readonly OntologyObservation[], asof: string | null): string | null {
  let best: { o: OntologyObservation; i: number } | null = null;
  observations.forEach((o, i) => {
    if (asof !== null && o.valid_from > asof) return;
    if (!best || o.valid_from > best.o.valid_from || (o.valid_from === best.o.valid_from && i > best.i)) best = { o, i };
  });
  return best ? (best as { o: OntologyObservation }).o.value : null;
}

// ─── Probes and gold ──────────────────────────────────────────────────────

interface ProbeBase { id: string; chain: string; entity: string; depth: number; kind: UpdateKind; private: boolean }
export type N1Probe =
  | ProbeBase & { type: 'fence_current'; surface: 'recall' | 'search'; key: string; gold: string | null; stale: string[]; all: string[] }
  | ProbeBase & { type: 'fence_history'; key: string; gold: string[] }
  | ProbeBase & { type: 'ontology_current'; dimension: string; gold: string; stale: string[]; all: string[] }
  | ProbeBase & { type: 'ontology_asof'; dimension: string; asof: string; gold: string | null; all: string[] }
  | ProbeBase & { type: 'trajectory_current'; metric: string; key: string; gold: number; stale: number[] }
  | ProbeBase & { type: 'trajectory_history'; metric: string; key: string; gold: Array<[string, number]>; superseded: Array<[string, number]> };

export type N1ProbeType = N1Probe['type'];
export const SURFACE_OF: Record<N1ProbeType, string> = {
  fence_current: 'fence', fence_history: 'recall-history', ontology_current: 'ontology_get', ontology_asof: 'ontology_get-asof',
  trajectory_current: 'find_trajectory', trajectory_history: 'find_trajectory-history',
};

export interface ExposureProbe {
  id: string;
  surface: 'recall' | 'ontology_get' | 'find_trajectory';
  entity: string;
  metric?: string;
  /** Tokens only the private item carries. */
  private_tokens: string[];
  /** A world-visible token on the same entity and surface. */
  twin_token: string;
  /** The twin's metric when it differs from the private item's (trajectories). */
  twin_metric?: string;
}

const lastRoundIndex = (state: GoldState): Round => (state === 'concurrent' ? 'C' : N1_MAX_DEPTH);

/** Current value after each round up to `round`, distinct from the final one. */
function staleValues<T>(seq: readonly T[], final: T): T[] {
  return [...new Set(seq.filter(v => v !== final))];
}

export function n1Probes(ledger: N1Ledger, state: GoldState): N1Probe[] {
  const round = lastRoundIndex(state);
  const probes: N1Probe[] = [];
  const upto = ROUNDS.slice(0, ROUNDS.indexOf(round) + 1);
  for (const c of ledger.fence) {
    const vals = chainValueAt(c, round);
    const final = vals[vals.length - 1].token;
    const currents = upto.map(r => chainValueAt(c, r).at(-1)!.token);
    const all = [...new Set([...c.values.map(v => v.token), c.concurrent.token])];
    const base = { chain: c.id, entity: c.entity, depth: c.depth, kind: c.kind as UpdateKind, private: c.visibility === 'private', key: c.key };
    for (const surface of ['recall', 'search'] as const) {
      probes.push({ ...base, id: `${state}:fence_current:${surface}:${c.id}`, type: 'fence_current', surface, gold: final, stale: staleValues(currents, final), all });
    }
    const struck = fenceRowsAt(ledger, c.entity, round).filter(r => r.chain === c.id && !r.active).map(r => r.token);
    probes.push({ ...base, id: `${state}:fence_history:${c.id}`, type: 'fence_history', gold: struck });
  }
  for (const surface of ['recall', 'search'] as const) {
    probes.push({ id: `${state}:fence_current:${surface}:ghost`, chain: 'ghost', entity: ledger.entities[0].slug, depth: 0, kind: 'explicit', private: false, type: 'fence_current', surface, key: ledger.ghost_key, gold: null, stale: [], all: [] });
  }
  for (const c of ledger.ontology) {
    const o = ontologyObservationsAt(c, round);
    const final = ontologyValueAt(o, null)!;
    const currents = upto.map(r => ontologyValueAt(ontologyObservationsAt(c, r), null)!);
    const all = [...new Set([...c.observations, c.concurrent].map(x => x.value))];
    const base = { chain: c.id, entity: c.entity, depth: c.depth, kind: c.kind as UpdateKind, private: c.visibility === 'private', dimension: c.dimension };
    probes.push({ ...base, id: `${state}:ontology_current:${c.id}`, type: 'ontology_current', gold: final, stale: staleValues(currents, final), all });
    const days = [...new Set(o.map(x => x.valid_from))].sort();
    const asofs = [addDays(days[0], -1), ...days.slice(0, -1).map((d, k) => addDays(d, Math.max(1, Math.floor((Date.parse(days[k + 1]) - Date.parse(d)) / 86_400_000 / 2))))];
    for (const asof of asofs) probes.push({ ...base, id: `${state}:ontology_asof:${c.id}:${asof}`, type: 'ontology_asof', asof, gold: ontologyValueAt(o, asof), all });
  }
  for (const c of ledger.trajectory) {
    const rows = fenceRowsAt(ledger, c.entity, round).filter(r => r.chain === c.id);
    const active = rows.filter(r => r.active).map(r => [r.valid_from.slice(0, 7), r.metric!.value] as [string, number]).sort((a, b) => a[0].localeCompare(b[0]));
    const superseded = rows.filter(r => !r.active).map(r => [r.valid_from.slice(0, 7), r.metric!.value] as [string, number]);
    const latestAt = (r: Round) => {
      const rs = fenceRowsAt(ledger, c.entity, r).filter(x => x.chain === c.id && x.active).sort((a, b) => a.valid_from.localeCompare(b.valid_from));
      return rs.at(-1)!.metric!.value;
    };
    const final = active.at(-1)![1];
    const base = { chain: c.id, entity: c.entity, depth: c.depth, kind: c.kind as UpdateKind, private: c.visibility === 'private', metric: c.metric, key: c.key };
    probes.push({ ...base, id: `${state}:trajectory_current:${c.id}`, type: 'trajectory_current', gold: final, stale: staleValues(upto.map(latestAt), final) });
    probes.push({ ...base, id: `${state}:trajectory_history:${c.id}`, type: 'trajectory_history', gold: active, superseded });
  }
  return probes;
}

/** Exposure probes: one per private item, each with its world twin on the same entity and surface. */
export function n1ExposureProbes(ledger: N1Ledger, state: GoldState): ExposureProbe[] {
  const round = lastRoundIndex(state);
  const out: ExposureProbe[] = [];
  for (const c of ledger.fence.filter(x => x.visibility === 'private')) {
    const twin = ledger.fence.find(x => x.entity === c.entity && x.visibility === 'world')!;
    out.push({ id: `${state}:exposure:recall:${c.id}`, surface: 'recall', entity: c.entity, private_tokens: chainValueAt(c, round).map(v => v.token), twin_token: chainValueAt(twin, round).at(-1)!.token });
  }
  for (const c of ledger.ontology.filter(x => x.visibility === 'private')) {
    const twin = ledger.ontology.find(x => x.entity === c.entity && x.visibility === 'world' && x.kind === 'exposure')!;
    out.push({ id: `${state}:exposure:ontology_get:${c.id}`, surface: 'ontology_get', entity: c.entity, private_tokens: ontologyObservationsAt(c, round).map(o => o.token), twin_token: ontologyObservationsAt(twin, round).at(-1)!.token });
  }
  for (const c of ledger.trajectory.filter(x => x.visibility === 'private')) {
    const twin = ledger.trajectory.find(x => x.entity === c.entity && x.visibility === 'world')!;
    const tokens = fenceRowsAt(ledger, c.entity, round).filter(r => r.chain === c.id).map(r => r.token);
    const twinTok = fenceRowsAt(ledger, c.entity, round).filter(r => r.chain === twin.id && r.active).at(-1)!.token;
    out.push({ id: `${state}:exposure:find_trajectory:${c.id}`, surface: 'find_trajectory', entity: c.entity, metric: c.metric, private_tokens: tokens, twin_token: twinTok, twin_metric: twin.metric });
  }
  return out;
}

/** Every token a private item ever carries: a remote response containing one is a leak. */
export function privateTokens(ledger: N1Ledger): string[] {
  const out = new Set<string>();
  for (const c of ledger.fence.filter(x => x.visibility === 'private')) for (const v of [...c.values, c.concurrent]) out.add(v.token);
  for (const c of ledger.ontology.filter(x => x.visibility === 'private')) for (const o of [...c.observations, c.concurrent]) out.add(o.token);
  for (const c of ledger.trajectory.filter(x => x.visibility === 'private')) {
    for (const p of c.initial) out.add(p.token);
    for (const o of [...c.ops, c.concurrent]) out.add(o.point.token);
  }
  return [...out].sort();
}
