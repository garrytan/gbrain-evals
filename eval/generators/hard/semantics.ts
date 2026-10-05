/**
 * Cat 40 Hard: the meaning of time, corrections, user statements and names
 * (ENG-F4). The generator computes every answer key with these functions,
 * the 50k key-equality check calls the same ones, and the Hard system prompt
 * states the same rules to every arm.
 *
 *   Effective and recorded time. Every attribute value has the date it takes
 *   effect and the date a document recorded it.
 *   "As of D" is the value in effect on D, using every document, including
 *   documents written after D (valid time with hindsight).
 *   A correction replaces the corrected value from that value's effective
 *   date: it is a value with the corrected one's effective date and a later
 *   recorded date. Two values with the same effective date resolve to the
 *   later recorded one, so a correction always wins over what it corrects.
 *   User statements in an H5 session chain outrank documents, and a later
 *   user statement outranks an earlier one.
 *   Names: every name, account code, former name and name of a merged account
 *   maps to exactly one entity id (the namespace is injective at both
 *   scales), so a name resolves to the same entity on every date.
 */
import type { H1Clause, H1Predicate, HardEntity } from './schema.ts';

export interface ValueEvent {
  value: string;
  /** Date the value takes effect (YYYY-MM-DD). */
  effective: string;
  /** Date a document recorded it. */
  recorded: string;
  /** Document that states it. */
  doc: string;
  kind: 'initial' | 'change' | 'correction';
}

/** The event in effect on `date`, or null before the first one. */
export function eventAsOf(events: readonly ValueEvent[], date: string): ValueEvent | null {
  let best: ValueEvent | null = null;
  for (const e of events) {
    if (e.effective > date) continue;
    if (!best || e.effective > best.effective || (e.effective === best.effective && e.recorded > best.recorded)) best = e;
  }
  return best;
}

export function valueAsOf(events: readonly ValueEvent[], date: string): string | null {
  return eventAsOf(events, date)?.value ?? null;
}

/** A correction of `target`: same effective date, recorded later. */
export function correctionOf(target: ValueEvent, value: string, recorded: string, doc: string): ValueEvent {
  if (recorded <= target.recorded) throw new Error(`a correction is recorded after what it corrects (${recorded} <= ${target.recorded})`);
  return { value, effective: target.effective, recorded, doc, kind: 'correction' };
}

/** Values that were in effect at some time, or were stated and then corrected away; the answer key excludes the one in effect. */
export function historyValues(events: readonly ValueEvent[]): string[] {
  return [...new Set(events.map(e => e.value))];
}

// ─── User statements (H5) ───────────────────────────────────────────

export interface UserStatement { session: number; key: string; value: string }

/** The value of `key` after a session chain: the latest statement wins over earlier ones and over `documentValue`. */
export function statedValue(statements: readonly UserStatement[], key: string, documentValue: string | null): string | null {
  let out: UserStatement | null = null;
  for (const s of statements) if (s.key === key && (!out || s.session > out.session)) out = s;
  return out ? out.value : documentValue;
}

// ─── Names ──────────────────────────────────────────────────────────

/** Name → entity id. Throws when a name maps to two entities (the namespace must be injective). */
export function nameRegistry(entities: readonly HardEntity[], normalize: (s: string) => string = s => s.toLowerCase().trim()): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entities) for (const n of [e.name, ...e.aliases]) {
    const k = normalize(n);
    const prev = m.get(k);
    if (prev && prev !== e.id) throw new Error(`name ${JSON.stringify(n)} refers to both ${prev} and ${e.id}`);
    m.set(k, e.id);
  }
  return m;
}

// ─── H1 predicates ──────────────────────────────────────────────────

/** What the predicate evaluator needs about one entity. */
export interface PredicateFacts {
  id: string;
  segment: string;
  region: string;
  owner: readonly ValueEvent[];
  renewal: readonly ValueEvent[];
  tickets: ReadonlyArray<{ opened: string; escalated?: string; closed?: string }>;
}

function addDays(iso: string, days: number) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

export function clauseHolds(c: H1Clause, f: PredicateFacts, asOf: string): boolean {
  switch (c.kind) {
    case 'owner': return valueAsOf(f.owner, asOf) === c.staff;
    case 'segment': return f.segment === c.segment;
    case 'region': return f.region === c.region;
    case 'open_escalated_ticket': return f.tickets.some(t => t.opened <= asOf && t.escalated !== undefined && t.escalated <= asOf && !(t.closed !== undefined && t.closed <= asOf));
    case 'renewal_within': { const r = valueAsOf(f.renewal, asOf); return r !== null && r >= asOf && r <= addDays(asOf, c.days); }
  }
}

/**
 * The single H1 predicate evaluator (CEO-F29): members hold every clause;
 * near misses hold at least one clause and not all. Key generation, the 50k
 * key-equality assertion and the oracle's near-miss evidence all call it.
 */
export function evaluatePredicate(p: H1Predicate, facts: readonly PredicateFacts[]): { members: string[]; nearMisses: string[] } {
  const members: string[] = [], nearMisses: string[] = [];
  for (const f of facts) {
    const held = p.clauses.filter(c => clauseHolds(c, f, p.as_of)).length;
    if (held === p.clauses.length) members.push(f.id);
    else if (held > 0) nearMisses.push(f.id);
  }
  return { members, nearMisses };
}
