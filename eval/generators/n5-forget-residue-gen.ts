/**
 * N5 forgetting-residue generator: a seeded set of canary claims about
 * fictional people, which of them the evaluator forgets, and what the
 * documented withdrawal contract says each tier must show afterwards.
 *
 * Every canary claim carries a unique token (`cnry` + 8 letters), so a
 * response contains the claim exactly when it contains the token. Groups:
 *
 *   retained      canaries never forgotten: the retained-neighbor control.
 *                 Same-entity neighbors share a page with forgotten ones;
 *                 same-text twins carry the forgotten claim's exact text on
 *                 another entity (the hard negative).
 *   forgotten     canaries forgotten after the witness checkpoint; a late
 *                 pair is forgotten during the concurrent round.
 *   private       canaries remembered with visibility private (one
 *                 forgotten, one retained): a remote caller must never see
 *                 them, the trusted local caller must until withdrawal.
 *   fence-authored canaries written as rows of the page's Facts fence by
 *                 put_page rather than by remember.
 *   prose         one forgotten canary whose text also appears in the page
 *                 prose; prose outside the fence is retained by design, so
 *                 its chunk tiers are reported, never scored as residue.
 *   paraphrase    a different wording of a forgotten claim on the same
 *                 entity; withdrawal matching is lexical by design, so it
 *                 stays active (a documented gap, never a failure).
 *   corrected     a corrected claim remembered after a forget (the
 *                 documented way back: reinstatement).
 *   repeat        the exact forgotten claim remembered again on the same
 *                 entity: documented as refused.
 *   concurrent    new claims remembered while the late forgets run.
 *
 * All names are fictional placeholders.
 */
import { Rng, fingerprint, tokenFactory } from './seeded.ts';

export const N5_GENERATOR_VERSION = 'n5-forget-residue-gen@1';
export const N5_DEFAULT_SEED = 5;

export type Visibility = 'world' | 'private';
export type CanaryRole = 'retained' | 'forgotten' | 'late-forgotten' | 'paraphrase' | 'corrected' | 'concurrent' | 'twin-concurrent';

export interface N5Entity { slug: string; title: string }

export interface Canary {
  id: string;
  entity: string;
  /** Claim text, including the token. Same-text twins share text and token across entities. */
  claim: string;
  token: string;
  phrase: string;
  visibility: Visibility;
  /** remember: the verb; fence: a row of the initial put_page body. */
  via: 'remember' | 'fence';
  role: CanaryRole;
  /** Present when this canary's exact text also lives on another entity. */
  twin_of?: string;
  /** For paraphrase and corrected canaries: the forgotten canary they relate to. */
  relates_to?: string;
  /** The claim's text also appears in the page prose (retained by design). */
  in_prose?: boolean;
}

export interface N5Ledger {
  generator_version: string;
  seed: number;
  entities: N5Entity[];
  canaries: Canary[];
  /** Forgotten canaries remembered again verbatim on the same entity (documented: refused). */
  repeats: string[];
  /** Retained canaries a read-only and a foreign-source HTTP client try to forget. */
  authority_targets: string[];
}

export interface N5World { ledger: N5Ledger; fingerprint: string }

const PEOPLE = ['Hazel', 'Ivy', 'Juniper', 'Laurel'];
const PHRASES: Array<[string, string]> = [
  ['Keeps bees', 'Is a beekeeper'], ['Plays the oboe', 'Is an oboist'], ['Collects stamps', 'Is a philatelist'],
  ['Prefers email', 'Likes to be contacted by email'], ['Speaks Basque', 'Is fluent in Basque'], ['Runs marathons', 'Is a marathon runner'],
  ['Grows bonsai', 'Cultivates bonsai trees'], ['Restores clocks', 'Repairs antique clocks'], ['Sails dinghies', 'Races small sailboats'],
  ['Brews cider', 'Makes cider at home'], ['Paints murals', 'Is a mural painter'], ['Studies moths', 'Is a moth enthusiast'],
  ['Builds kites', 'Makes kites by hand'], ['Carves spoons', 'Whittles wooden spoons'], ['Bakes sourdough', 'Is a sourdough baker'],
  ['Knits socks', 'Hand-knits socks'], ['Climbs boulders', 'Is a boulderer'], ['Juggles clubs', 'Is a club juggler'],
  ['Translates poetry', 'Is a poetry translator'], ['Rides unicycles', 'Is a unicyclist'], ['Tunes pianos', 'Is a piano tuner'],
  ['Binds books', 'Is a bookbinder'], ['Forages mushrooms', 'Gathers wild mushrooms'], ['Repairs bicycles', 'Fixes bikes'],
];

export function generateN5World(opts: { seed?: number } = {}): N5World {
  const seed = opts.seed ?? N5_DEFAULT_SEED;
  const rng = new Rng(seed);
  const token = tokenFactory(rng);
  const phrases = rng.shuffle(PHRASES);
  let next = 0;
  const entities = PEOPLE.map(n => ({ slug: `people/${n.toLowerCase()}-example`, title: `${n} Example` }));
  const canaries: Canary[] = [];
  const add = (c: Omit<Canary, 'id' | 'token' | 'claim' | 'phrase'> & { phrase?: string; token?: string }) => {
    const phrase = c.phrase ?? phrases[next++][0];
    const t = c.token ?? token();
    const canary: Canary = { ...c, id: `c${String(canaries.length + 1).padStart(2, '0')}`, phrase, token: t, claim: `${phrase} ${t}` };
    canaries.push(canary);
    return canary;
  };
  const [e1, e2, e3, e4] = entities.map(e => e.slug);
  // Per entity: two remembered canaries and one fence-authored canary, forget one of the remembered pair.
  for (const e of entities) {
    add({ entity: e.slug, visibility: 'world', via: 'remember', role: 'forgotten' });
    add({ entity: e.slug, visibility: 'world', via: 'remember', role: 'retained' });
    add({ entity: e.slug, visibility: 'world', via: 'fence', role: e.slug === e1 || e.slug === e3 ? 'forgotten' : 'retained' });
  }
  // Same-text twins: the forgotten claim's exact text on another entity, retained.
  for (const [from, to] of [[e1, e2], [e3, e4]] as const) {
    const src = canaries.find(c => c.entity === from && c.role === 'forgotten' && c.via === 'remember')!;
    add({ entity: to, visibility: 'world', via: 'remember', role: 'retained', phrase: src.phrase, token: src.token, twin_of: src.id });
  }
  // Private canaries: one forgotten, one retained.
  add({ entity: e2, visibility: 'private', via: 'remember', role: 'forgotten' });
  add({ entity: e4, visibility: 'private', via: 'remember', role: 'retained' });
  // Prose canary: a forgotten remembered claim whose text is also in the page prose.
  add({ entity: e4, visibility: 'world', via: 'remember', role: 'forgotten', in_prose: true });
  // Late forgets (concurrent round): one retained-looking canary on each of two entities.
  add({ entity: e2, visibility: 'world', via: 'remember', role: 'late-forgotten' });
  add({ entity: e3, visibility: 'world', via: 'remember', role: 'late-forgotten' });
  // Paraphrases of two forgotten claims, remembered before the forget.
  for (const e of [e1, e2]) {
    const src = canaries.find(c => c.entity === e && c.role === 'forgotten' && c.via === 'remember' && c.visibility === 'world')!;
    const para = PHRASES.find(p => p[0] === src.phrase)![1];
    add({ entity: e, visibility: 'world', via: 'remember', role: 'paraphrase', phrase: para, relates_to: src.id });
  }
  // Corrected claims after forgets (reinstatement), on two entities.
  for (const e of [e1, e3]) {
    const src = canaries.find(c => c.entity === e && c.role === 'forgotten' && c.via === 'remember')!;
    add({ entity: e, visibility: 'world', via: 'remember', role: 'corrected', phrase: `No longer: ${src.phrase.toLowerCase()}; now ${phrases[next++][0].toLowerCase()}`, relates_to: src.id });
  }
  // Concurrent round: new neighbors, and a forgotten claim's exact text remembered on a third entity.
  add({ entity: e1, visibility: 'world', via: 'remember', role: 'concurrent' });
  add({ entity: e3, visibility: 'world', via: 'remember', role: 'concurrent' });
  {
    const src = canaries.find(c => c.entity === e1 && c.role === 'forgotten' && c.via === 'remember')!;
    add({ entity: e3, visibility: 'world', via: 'remember', role: 'twin-concurrent', phrase: src.phrase, token: src.token, twin_of: src.id });
  }
  const repeats = [canaries.find(c => c.entity === e2 && c.role === 'forgotten' && c.via === 'remember' && c.visibility === 'world')!.id];
  const authority_targets = [canaries.find(c => c.entity === e1 && c.role === 'retained' && c.via === 'remember')!.id, canaries.find(c => c.entity === e3 && c.role === 'retained' && c.via === 'remember')!.id];
  const ledger: N5Ledger = { generator_version: N5_GENERATOR_VERSION, seed, entities, canaries, repeats, authority_targets };
  return { ledger, fingerprint: fingerprint(ledger) };
}

export const FENCE_BEGIN = '<!--- gbrain:facts:begin -->';
export const FENCE_END = '<!--- gbrain:facts:end -->';

/** The initial page: prose (with the prose canary's text) and a Facts fence holding the fence-authored canaries. */
export function renderInitialPage(ledger: N5Ledger, entity: N5Entity): string {
  const prose = ledger.canaries.filter(c => c.entity === entity.slug && c.in_prose).map(c => ` A colleague noted: ${c.claim}.`).join('');
  const rows = ledger.canaries.filter(c => c.entity === entity.slug && c.via === 'fence')
    .map((c, i) => `| ${i + 1} | ${c.claim} | fact | 1.0 | ${c.visibility} | medium | 2024-01-0${i + 1} |  | n5-ledger |  |`);
  const fence = rows.length
    ? ['', '## Facts', '', FENCE_BEGIN, '', '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |', '|---|---|---|---|---|---|---|---|---|---|', ...rows, FENCE_END].join('\n')
    : '';
  return `---\ntitle: ${entity.title}\ntype: person\n---\n${entity.title} is a fictional person used by the N5 forgetting category.${prose}\n${fence}\n`;
}

/** Tiers an active claim can surface in. Each is one documented active-recall surface. */
export const ACTIVE_TIERS = ['recall_facts', 'recall_query', 'search', 'query', 'context_pack', 'fence_active', 'entity_card'] as const;
export type ActiveTier = typeof ACTIVE_TIERS[number];
/** Tiers whose evidence is a chunk of page text: prose outside the fence is retained there by design. */
export const CHUNK_TIERS: ReadonlySet<ActiveTier> = new Set(['recall_query', 'search', 'query']);

export const CHECKPOINTS = ['witness', 'immediate', 'settled', 'stale_reimport', 'restart', 'concurrent'] as const;
export type N5Checkpoint = typeof CHECKPOINTS[number];
export const POST_FORGET: readonly N5Checkpoint[] = ['immediate', 'settled', 'stale_reimport', 'restart', 'concurrent'];

/** Forgotten as of `cp`: the main set after witness, plus the late pair at the concurrent checkpoint. */
export function isForgottenAt(c: Canary, cp: N5Checkpoint): boolean {
  if (cp === 'witness') return false;
  if (c.role === 'forgotten') return true;
  return c.role === 'late-forgotten' && cp === 'concurrent';
}

/** Canaries that exist (were written) by `cp`. */
export function writtenBy(c: Canary, cp: N5Checkpoint): boolean {
  if (c.role === 'corrected') return cp !== 'witness';
  if (c.role === 'concurrent' || c.role === 'twin-concurrent') return cp === 'concurrent';
  return true;
}

/** Retained-neighbor control at `cp`: written, not forgotten, and not a paraphrase or corrected claim (scored separately). */
export function isRetainedAt(c: Canary, cp: N5Checkpoint): boolean {
  return writtenBy(c, cp) && !isForgottenAt(c, cp) && !['paraphrase', 'corrected'].includes(c.role);
}

/** Whether a (canary, tier) pair is scored as residue; the prose canary's chunk tiers are retained by design. */
export function residueScored(c: Canary, tier: ActiveTier): boolean {
  return !(c.in_prose && CHUNK_TIERS.has(tier));
}

export function privateTokens(ledger: N5Ledger): string[] {
  return [...new Set(ledger.canaries.filter(c => c.visibility === 'private').map(c => c.token))].sort();
}
