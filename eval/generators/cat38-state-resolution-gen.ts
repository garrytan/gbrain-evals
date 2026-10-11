/**
 * Cat 38 state resolution: seeded write-sequence generator and tier oracle.
 *
 * A sequence is a short history of writes about one slot of one fictional
 * entity ("Acme Example 12's plan tier", "Alice Example 7's office city"),
 * made through the channels gbrain stamps with different trust tiers
 * (#5575 A3/A4):
 *
 *   owner_curated    the owner's own notes: a `## Facts` row on the entity
 *                    page, synced from the owner's repository
 *                    (operator_curated);
 *   owner_confirmed  the owner on the local CLI: `gbrain remember` followed by
 *                    the CEO-9 confirmation (written agent_written, raised to
 *                    user_confirmed);
 *   agent            a remote MCP agent's `remember` (agent_written);
 *   agent_page       a remote MCP agent's `put_page` rewriting the owner's
 *                    entity page with a changed `## Facts` row (agent_written;
 *                    A5 covers the fence re-projection on page publish);
 *   external         a remote agent saving tool output with
 *                    content_origin "tool_output" (external_untrusted).
 *
 * A write may name the fact it replaces (`replaces`, the step index of an
 * earlier write in the same sequence; for agent_page, the fence row it
 * rewrites). An `accept` step is the owner
 * accepting the trust proposal a contested write filed.
 *
 * The oracle is an independent implementation of the documented rules, never
 * read from gbrain:
 *
 *   order        user_confirmed > operator_curated > tool_observed >
 *                agent_written > unknown > external_untrusted;
 *   replaces     a write at least as trusted as its target supersedes it; a
 *                less trusted one leaves the target active and is itself
 *                active but contested (A5 guarded supersession, ENG-4);
 *   contradiction without replaces  (A5 conflict slot) a less trusted
 *                contradiction is contested; an equal or more trusted one may
 *                supersede the older value;
 *   accept       the owner's accept supersedes the target and confirms the
 *                contested row (A4: accepting also confirms);
 *   current      among active rows, the most trusted; the newest among equals.
 *
 * Negative controls: single-write sequences (one per channel mix) and twin
 * entities whose slug extends another sequence's slug and share its slot
 * name with a different value. Every name is a fictional `-example`
 * placeholder.
 */
import { Rng, fingerprint } from './seeded.ts';

export const CAT38_GENERATOR_VERSION = 'cat38-state-resolution-gen-v1';
export const CAT38_DEFAULT_SEED = 38;
export const CAT38_DEFAULT_SEQUENCES = 200;

export const TRUST_ORDER = ['user_confirmed', 'operator_curated', 'tool_observed', 'agent_written', 'unknown', 'external_untrusted'] as const;
export type Tier = typeof TRUST_ORDER[number];
export const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
  user_confirmed: 6, operator_curated: 5, tool_observed: 4, agent_written: 3, unknown: 2, external_untrusted: 1,
});
/** Rank of a tier as a reader sees it; a row with no tier reads as unknown. */
export function tierRank(tier: string | null | undefined): number {
  return TIER_RANK[(tier ?? 'unknown') as Tier] ?? TIER_RANK.unknown;
}

export const CHANNELS = ['owner_curated', 'owner_confirmed', 'agent', 'agent_page', 'external'] as const;
export type Channel = typeof CHANNELS[number];
/** Channels a single-write control may use (a page rewrite needs an owner page to rewrite). */
export const SINGLE_WRITE_CHANNELS: readonly Channel[] = ['owner_curated', 'owner_confirmed', 'agent', 'external'];
/** The tier a channel's row ends at (A3, A4). */
export const CHANNEL_TIER: Readonly<Record<Channel, Tier>> = Object.freeze({
  owner_curated: 'operator_curated', owner_confirmed: 'user_confirmed', agent: 'agent_written', agent_page: 'agent_written', external: 'external_untrusted',
});
/** The tier the write carries when its supersession is decided: the owner's confirmation runs after the CLI write. */
export const CHANNEL_WRITE_TIER: Readonly<Record<Channel, Tier>> = Object.freeze({
  owner_curated: 'operator_curated', owner_confirmed: 'agent_written', agent: 'agent_written', agent_page: 'agent_written', external: 'external_untrusted',
});

export const CONTESTED_KINDS = [
  'owner_agent_contradiction', 'owner_agent_replaces', 'owner_owner_update', 'agent_agent_update', 'agent_agent_restated',
  'agent_owner_update', 'external_over_owner', 'external_over_agent', 'confirmed_agent_replaces', 'contested_accepted', 'agent_page_rewrite',
] as const;
export type Kind = typeof CONTESTED_KINDS[number] | 'single_write' | 'twin_control';

export const SLOTS = {
  person: ['office city', 'phone extension'],
  company: ['billing contact', 'plan tier', 'renewal date'],
} as const;
export type Slot = typeof SLOTS[keyof typeof SLOTS][number];
export const ALL_SLOTS: readonly Slot[] = [...SLOTS.person, ...SLOTS.company];

const CITIES = ['lima', 'oslo', 'quito', 'lagos', 'perth', 'porto', 'turin', 'kyoto', 'accra', 'hanoi', 'dakar', 'sofia', 'tunis', 'rabat', 'bern', 'riga', 'malmo', 'cork', 'leeds', 'graz'];
const CONTACTS = ['ana', 'ben', 'cleo', 'dan', 'eve', 'finn', 'gus', 'hana', 'ike', 'joss', 'kai', 'lux', 'max', 'ned', 'ola', 'pia', 'rex', 'sky', 'tess', 'val'].map(n => `${n}-example`);
const PLANS = ['bronze', 'silver', 'gold', 'platinum', 'starter', 'team', 'scale', 'enterprise', 'basic', 'pro', 'growth', 'premier'].map(p => `plan-${p}`);
const PEOPLE = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'kevin', 'laura', 'mike', 'nora', 'oscar', 'peggy', 'quinn', 'rita', 'steve', 'tina', 'ursula', 'victor', 'wendy', 'yvonne'];
const COMPANIES = ['acme', 'globex', 'initech', 'hooli', 'vandelay', 'contoso', 'fabrikam', 'northwind', 'tailspin', 'wingtip', 'litware', 'adatum'];

export type Step =
  | { op: 'write'; channel: Channel; value: string; replaces?: number }
  | { op: 'accept'; of: number };

export interface Entity { slug: string; title: string; type: 'person' | 'company' }

export interface Sequence {
  id: string;
  kind: Kind;
  entity: Entity;
  slot: Slot;
  steps: Step[];
  negative: boolean;
  /** For twin controls: the sequence whose entity slug this one extends. */
  twin_of?: string;
}

export interface Cat38Ledger { seed: number; generator_version: string; sequences: Sequence[] }

export interface OracleRow {
  step: number;
  value: string;
  channel: Channel;
  /** Tier after every step so far (A4 raises owner_confirmed rows and accepted rows to user_confirmed). */
  tier: Tier;
  active: boolean;
  /** A less trusted write contradicting a more trusted active value, not (yet) accepted. */
  contested: boolean;
  /** Step of the row this one contests. */
  contests?: number;
  superseded_by?: number;
  /** An equal or more trusted contradiction without `replaces` may supersede this row (conflict slot). */
  may_expire: boolean;
  /** A less trusted write targeted or contradicted this row. */
  guarded: boolean;
}

export interface Cat38Gold {
  /** The value that must be current after the whole sequence. */
  current: string;
  /** Every value written for this slot in the sequence. */
  candidates: string[];
  /** The value current before the last step (null for a single step). */
  prior: string | null;
  rows: OracleRow[];
}

export interface Cat38Probe {
  id: string;
  sequence: string;
  kind: Kind;
  entity: string;
  title: string;
  slot: Slot;
  negative: boolean;
  question: string;
}

export interface GeneratedCat38 {
  ledger: Cat38Ledger;
  fingerprint: string;
  probes: Cat38Probe[];
  gold: Map<string, Cat38Gold>;
  negative: Set<string>;
}

/** The claim text every channel writes for one slot value. */
export function factText(entity: Pick<Entity, 'title'>, slot: Slot, value: string): string {
  return `${entity.title}'s ${slot} is ${value}.`;
}

const SLOT_RE = new RegExp(`\\b(${ALL_SLOTS.join('|')}) is ([a-z0-9-]+)`);
/** The slot and value a fact states, from its text alone (any entity: a leaked twin row still parses). */
export function parseSlotValue(text: string): { slot: Slot; value: string } | null {
  const m = SLOT_RE.exec(text);
  return m ? { slot: m[1] as Slot, value: m[2]! } : null;
}

/** True when `text` states `value` as a whole token. */
export function mentionsValue(text: string, value: string): boolean {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9-])${esc}(?![a-z0-9-])`, 'i').test(text);
}

function activeTop(rows: readonly OracleRow[], except?: OracleRow): OracleRow | null {
  let top: OracleRow | null = null;
  for (const r of rows) {
    if (!r.active || r === except) continue;
    if (!top || TIER_RANK[r.tier] > TIER_RANK[top.tier] || (TIER_RANK[r.tier] === TIER_RANK[top.tier] && r.step > top.step)) top = r;
  }
  return top;
}

/** Oracle state after the first `upTo` steps. */
export function oracle(seq: Sequence, upTo = seq.steps.length): Cat38Gold {
  const rows: OracleRow[] = [];
  for (let i = 0; i < upTo; i++) {
    const s = seq.steps[i]!;
    if (s.op === 'accept') {
      const row = rows.find(r => r.step === s.of);
      const target = row?.contests === undefined ? undefined : rows.find(r => r.step === row.contests);
      if (!row || !row.contested || !target?.active) throw new Error(`${seq.id}: step ${i} accepts step ${s.of}, which contests no active row`);
      row.contested = false;
      row.tier = 'user_confirmed';
      target.active = false;
      target.superseded_by = row.step;
      continue;
    }
    const writeTier = CHANNEL_WRITE_TIER[s.channel];
    const row: OracleRow = { step: i, value: s.value, channel: s.channel, tier: CHANNEL_TIER[s.channel], active: true, contested: false, may_expire: false, guarded: false };
    if (s.replaces !== undefined) {
      const target = rows.find(r => r.step === s.replaces);
      if (!target?.active) throw new Error(`${seq.id}: step ${i} replaces step ${s.replaces}, which is not active`);
      if (TIER_RANK[writeTier] >= TIER_RANK[target.tier]) {
        target.active = false;
        target.superseded_by = i;
      } else {
        row.contested = true;
        row.contests = target.step;
        target.guarded = true;
      }
    } else {
      const top = activeTop(rows);
      for (const r of rows) if (r.active && TIER_RANK[writeTier] >= TIER_RANK[r.tier]) r.may_expire = true;
      if (top && TIER_RANK[writeTier] < TIER_RANK[top.tier]) {
        row.contested = true;
        row.contests = top.step;
        top.guarded = true;
      }
    }
    rows.push(row);
  }
  const top = activeTop(rows);
  if (!top) throw new Error(`${seq.id}: no active row after ${upTo} steps`);
  const candidates = [...new Set(seq.steps.flatMap(s => (s.op === 'write' ? [s.value] : [])))];
  return { current: top.value, candidates, prior: upTo > 1 ? oracle(seq, upTo - 1).current : null, rows };
}

function valuePool(slot: Slot, rng: Rng): string[] {
  switch (slot) {
    case 'office city': return CITIES;
    case 'billing contact': return CONTACTS;
    case 'plan tier': return PLANS;
    case 'phone extension': return Array.from({ length: 12 }, () => `ext-${rng.int(1000, 9999)}`);
    case 'renewal date': return Array.from({ length: 12 }, () => `2027-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`);
  }
}

function distinctValues(slot: Slot, n: number, rng: Rng): string[] {
  const out = [...new Set(rng.shuffle(valuePool(slot, rng)))];
  if (out.length < n) throw new Error(`value pool for ${slot} too small`);
  return out.slice(0, n);
}

const w = (channel: Channel, value: string, replaces?: number): Step => ({ op: 'write', channel, value, ...(replaces === undefined ? {} : { replaces }) });

function stepsFor(kind: Kind, v: string[], rng: Rng): Step[] {
  switch (kind) {
    case 'owner_agent_contradiction': return [w('owner_curated', v[0]!), w('agent', v[1]!)];
    case 'owner_agent_replaces': return [w('owner_curated', v[0]!), w('agent', v[1]!, 0)];
    case 'owner_owner_update': return [w('owner_curated', v[0]!), w('owner_curated', v[1]!, 0)];
    case 'agent_agent_update': return [w('agent', v[0]!), w('agent', v[1]!, 0)];
    case 'agent_agent_restated': return [w('agent', v[0]!), w('agent', v[1]!)];
    case 'agent_owner_update': return [w('agent', v[0]!), w('owner_confirmed', v[1]!, 0)];
    case 'external_over_owner': return [w('owner_curated', v[0]!), w('external', v[1]!, 0)];
    case 'external_over_agent': return [w('agent', v[0]!), rng.float() < 0.5 ? w('external', v[1]!, 0) : w('external', v[1]!)];
    case 'confirmed_agent_replaces': return [w('owner_confirmed', v[0]!), w('agent', v[1]!, 0)];
    case 'contested_accepted': return [w(rng.float() < 0.5 ? 'owner_curated' : 'owner_confirmed', v[0]!), w('agent', v[1]!, 0), { op: 'accept', of: 1 }];
    case 'agent_page_rewrite': return [w('owner_curated', v[0]!), w('agent_page', v[1]!, 0)];
    case 'single_write':
    case 'twin_control': return [w(rng.pick(SINGLE_WRITE_CHANNELS), v[0]!)];
  }
}

export function questionFor(title: string, slot: Slot, slug: string): string {
  return `What is ${title}'s current ${slot}? (memory entity: ${slug})`;
}

/** The seeded world: about 85% contested kinds (round-robin), 10% single writes, 5% twin controls. */
export function generateCat38World(opts: { seed?: number; sequences?: number } = {}): GeneratedCat38 {
  const seed = opts.seed ?? CAT38_DEFAULT_SEED;
  const n = opts.sequences ?? CAT38_DEFAULT_SEQUENCES;
  if (!Number.isInteger(n) || n < 3) throw new Error('cat38: sequences must be an integer >= 3');
  const rng = new Rng(seed);
  const twins = Math.max(1, Math.round(n * 0.05));
  const singles = Math.max(1, Math.round(n * 0.10));
  const kinds: Kind[] = [
    ...Array.from({ length: n - twins - singles }, (_, i) => CONTESTED_KINDS[i % CONTESTED_KINDS.length]!),
    ...Array.from({ length: singles }, () => 'single_write' as const),
  ];
  const base: Sequence[] = rng.shuffle(kinds).map((kind, i) => {
    const type = rng.float() < 0.5 ? 'person' as const : 'company' as const;
    const name = type === 'person' ? rng.pick(PEOPLE) : rng.pick(COMPANIES);
    const num = i + 1;
    const entity: Entity = { slug: `${type === 'person' ? 'people' : 'companies'}/${name}-example-${num}`, title: `${name[0]!.toUpperCase()}${name.slice(1)} Example ${num}`, type };
    const slot = rng.pick(SLOTS[type]) as Slot;
    const steps = stepsFor(kind, distinctValues(slot, 2, rng), rng);
    return { id: `s${String(num).padStart(3, '0')}`, kind, entity, slot, steps, negative: kind === 'single_write' };
  });
  const twinSeqs: Sequence[] = rng.shuffle(base).slice(0, twins).map((of, j) => {
    const baseValues = new Set(of.steps.flatMap(s => (s.op === 'write' ? [s.value] : [])));
    const value = distinctValues(of.slot, baseValues.size + 1, rng).find(v => !baseValues.has(v))!;
    return {
      id: `t${String(j + 1).padStart(3, '0')}`, kind: 'twin_control', negative: true, twin_of: of.id, slot: of.slot,
      entity: { slug: `${of.entity.slug}-twin`, title: `${of.entity.title} Twin`, type: of.entity.type },
      steps: stepsFor('twin_control', [value], rng),
    };
  });
  const sequences = [...base, ...twinSeqs];
  const ledger: Cat38Ledger = { seed, generator_version: CAT38_GENERATOR_VERSION, sequences };
  const gold = new Map<string, Cat38Gold>();
  const probes: Cat38Probe[] = [];
  const negative = new Set<string>();
  for (const s of sequences) {
    const id = `probe:${s.id}`;
    gold.set(id, oracle(s));
    probes.push({ id, sequence: s.id, kind: s.kind, entity: s.entity.slug, title: s.entity.title, slot: s.slot, negative: s.negative, question: questionFor(s.entity.title, s.slot, s.entity.slug) });
    if (s.negative) negative.add(id);
  }
  return { ledger, fingerprint: fingerprint(ledger), probes, gold, negative };
}

/** The highest step count in the ledger (the number of write rounds). */
export function rounds(ledger: Cat38Ledger): number {
  return Math.max(...ledger.sequences.map(s => s.steps.length));
}
