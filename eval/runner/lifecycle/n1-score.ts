/**
 * N1 scoring: pure functions from normalized answers to probe rows and
 * metrics. No gbrain import, no I/O. Gold comes from the generator
 * (eval/generators/n1-knowledge-update-gen.ts).
 *
 * Definitions (every count has a named denominator):
 *   current-value probe   fence_current (recall and search surfaces, not the
 *                         ghost control), ontology_current, trajectory_current.
 *                         Correct when the surface serves exactly the current
 *                         value.
 *   stale served          a probe that serves a value which was current before
 *                         a later update (or a corrected trajectory point) as
 *                         current. A struck row inside a returned fence is
 *                         history, not stale.
 *   history probe         fence_history (every struck row is still readable as
 *                         an expired fact), ontology_asof with a value at that
 *                         date, trajectory_history (every unstruck point is
 *                         charted, no struck point is).
 *   negative control      the ghost key (no chain uses it) and ontology_asof
 *                         before the first observation: the answer is empty.
 */
import type { ExposureProbe, N1Probe } from '../../generators/n1-knowledge-update-gen.ts';
import { SURFACE_OF } from '../../generators/n1-knowledge-update-gen.ts';

export type N1Answer =
  | { error: string }
  | { tokens: string[] }
  | { unstruck: string[]; struck: string[] }
  | { expired: string[] }
  | { value: string | null }
  | { latest: number | null }
  | { points: Array<[string, number]> };

export type ProbeClass = 'current' | 'history' | 'negative';

export interface N1Row {
  probe_id: string;
  type: N1Probe['type'];
  surface: string;
  class: ProbeClass;
  chain: string;
  depth: number;
  kind: string;
  pass: boolean;
  stale: boolean;
  error?: string;
  gold: unknown;
  answer: unknown;
}

export function classOf(p: N1Probe): ProbeClass {
  if (p.type === 'fence_current') return p.gold === null ? 'negative' : 'current';
  if (p.type === 'ontology_asof') return p.gold === null ? 'negative' : 'history';
  if (p.type === 'ontology_current' || p.type === 'trajectory_current') return 'current';
  return 'history';
}

const sameSet = <T>(a: readonly T[], b: readonly T[]) => {
  const x = new Set(a.map(v => JSON.stringify(v)));
  const y = new Set(b.map(v => JSON.stringify(v)));
  return x.size === y.size && [...x].every(v => y.has(v));
};

/** Every element of `need` (with multiplicity) appears in `have`. */
function containsMultiset(have: readonly string[], need: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const h of have) counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const n of need) {
    const c = counts.get(n) ?? 0;
    if (c === 0) return false;
    counts.set(n, c - 1);
  }
  return true;
}

export function scoreN1Probe(p: N1Probe, a: N1Answer): N1Row {
  const base = { probe_id: p.id, type: p.type, surface: p.type === 'fence_current' ? `fence-${p.surface}` : SURFACE_OF[p.type], class: classOf(p), chain: p.chain, depth: p.depth, kind: p.kind, gold: p.gold, answer: a };
  if ('error' in a) return { ...base, pass: false, stale: false, error: a.error };
  switch (p.type) {
    case 'fence_current': {
      const served = 'tokens' in a ? a.tokens : 'unstruck' in a ? a.unstruck : [];
      const stale = served.some(t => p.stale.includes(t));
      if (p.gold === null) return { ...base, pass: served.length === 0, stale };
      return { ...base, pass: sameSet(served, [p.gold]), stale };
    }
    case 'fence_history': {
      const expired = 'expired' in a ? a.expired : [];
      return { ...base, pass: containsMultiset(expired, p.gold), stale: false };
    }
    case 'ontology_current': {
      const v = 'value' in a ? a.value : null;
      return { ...base, pass: v === p.gold, stale: v !== null && p.stale.includes(v) };
    }
    case 'ontology_asof': {
      const v = 'value' in a ? a.value : null;
      return { ...base, pass: v === p.gold, stale: false };
    }
    case 'trajectory_current': {
      const v = 'latest' in a ? a.latest : null;
      return { ...base, pass: v === p.gold, stale: v !== null && p.stale.includes(v) };
    }
    case 'trajectory_history': {
      const pts = 'points' in a ? a.points : [];
      const stale = pts.some(([m, v]) => p.superseded.some(([sm, sv]) => sm === m && sv === v));
      return { ...base, pass: sameSet(pts, p.gold), stale };
    }
  }
}

export interface ExposureRow {
  probe_id: string;
  surface: ExposureProbe['surface'];
  /** Remote caller saw a private token. */
  leak: boolean;
  /** Trusted local caller saw the private item. */
  control_trusted: boolean;
  /** Remote caller saw the world twin on the same surface. */
  control_twin: boolean;
  signal: boolean;
}

export function scoreExposure(p: ExposureProbe, remoteRaw: string | null, trustedRaw: string | null, twinRaw: string | null = remoteRaw): ExposureRow {
  const leak = remoteRaw !== null && p.private_tokens.some(t => remoteRaw.includes(t));
  const control_trusted = trustedRaw !== null && p.private_tokens.some(t => trustedRaw.includes(t));
  const control_twin = twinRaw !== null && twinRaw.includes(p.twin_token);
  return { probe_id: p.id, surface: p.surface, leak, control_trusted, control_twin, signal: control_trusted && control_twin };
}

export interface N1Metrics {
  current_value_probes: number;
  current_value_correct: number;
  current_value_accuracy: number | null;
  stale_served: number;
  stale_served_rate: number | null;
  history_probes: number;
  history_retained: number;
  history_retained_rate: number | null;
  negative_controls: number;
  negative_controls_passed: number;
  private_value_leaks: number;
  exposure_probes: number;
  exposure_probes_with_signal: number;
  acknowledged_writes_lost: number;
  sut_errors: number;
}

const rate = (n: number, d: number) => (d ? n / d : null);

export function n1Metrics(rows: readonly N1Row[], extra: { private_value_leaks: number; exposure: readonly ExposureRow[]; acknowledged_writes_lost: number }): N1Metrics {
  const cur = rows.filter(r => r.class === 'current');
  const hist = rows.filter(r => r.class === 'history');
  const neg = rows.filter(r => r.class === 'negative');
  const stale = rows.filter(r => r.stale).length;
  return {
    current_value_probes: cur.length,
    current_value_correct: cur.filter(r => r.pass).length,
    current_value_accuracy: rate(cur.filter(r => r.pass).length, cur.length),
    stale_served: stale,
    stale_served_rate: rate(stale, cur.length + hist.length),
    history_probes: hist.length,
    history_retained: hist.filter(r => r.pass).length,
    history_retained_rate: rate(hist.filter(r => r.pass).length, hist.length),
    negative_controls: neg.length,
    negative_controls_passed: neg.filter(r => r.pass).length,
    private_value_leaks: extra.private_value_leaks,
    exposure_probes: extra.exposure.length,
    exposure_probes_with_signal: extra.exposure.filter(e => e.signal).length,
    acknowledged_writes_lost: extra.acknowledged_writes_lost,
    sut_errors: rows.filter(r => r.error).length,
  };
}

/** Pass counts grouped by a row field, for data.by_surface / by_depth / by_kind. */
export function breakdown(rows: readonly N1Row[], key: (r: N1Row) => string): Record<string, { probes: number; passed: number; stale: number }> {
  const out: Record<string, { probes: number; passed: number; stale: number }> = {};
  for (const r of rows) {
    if (r.class === 'negative') continue;
    const k = key(r);
    out[k] ??= { probes: 0, passed: 0, stale: 0 };
    out[k].probes++;
    if (r.pass) out[k].passed++;
    if (r.stale) out[k].stale++;
  }
  return out;
}

// ─── Answer extraction from gbrain responses (shape parsing only) ─────────

const TOKEN = /cnry[a-z]{8}/g;

export function tokensIn(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Active-fact tokens for one chain key from a recall response's facts[]. */
export function recallTokens(facts: ReadonlyArray<Record<string, unknown>>, key: string, which: 'active' | 'expired'): string[] {
  return facts
    .filter(f => String(f.fact ?? '').includes(key) && (which === 'active' ? f.expired_at == null : f.expired_at != null))
    .flatMap(f => tokensIn(String(f.fact ?? '')));
}

/** Fence rows carrying `key` inside search chunk texts, split into unstruck and struck tokens. */
export function searchRowTokens(chunks: readonly string[], key: string): { unstruck: string[]; struck: string[] } {
  const unstruck: string[] = [];
  const struck: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (!line.includes(key)) continue;
      const claimCell = line.split('|').find(c => c.includes(key)) ?? line;
      (claimCell.includes('~~') ? struck : unstruck).push(...tokensIn(claimCell));
    }
  }
  return { unstruck: [...new Set(unstruck)], struck: [...new Set(struck)] };
}
