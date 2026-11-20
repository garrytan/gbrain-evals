/**
 * G6 world generator: a seeded, fictional mixed-access brain for measuring gold
 * out of view by cause (GBEV-55, rank 10, with rank 8's cross-source tasks
 * inside it).
 *
 * Each fictional project has two gold pages from two different channels (a CRM
 * note, meeting notes, an email thread, a chat log), one fact each. Every gold
 * page is assigned one intended view, in exact counts set by the knobs:
 *
 *   visible            no privacy marker; every caller should reach it;
 *   direct_flag        `visibility: private`;
 *   alias_inheritance  private through a privacy alias key (`access: confidential`,
 *                      `confidentiality: secret`, ...) or through a declared
 *                      `derived_from` link to an explicitly private page;
 *   derived_default    a derived page gbrain treats as private by default: an
 *                      atom or synthesized concept with no `visibility`, or an
 *                      atom whose `source_slug` origin is private.
 *
 * These are the rules gbrain 0.60.557.0 implements in
 * src/core/search/private-visibility.ts (privateSnapshotFilterFragment,
 * PRIVACY_ALIASES, declaredLineagePrivateSql, derivedPageSql and
 * derivedOriginPrivateSql). The knobs are design choices, set independently of
 * any real count (gate change D1): never tune them to a measured freeze.
 * A sibling decoy project per entity carries the same fields with other values,
 * so a system that answers from the wrong project can be caught.
 *
 * Pure and deterministic: Rng, tokenFactory and fingerprint from
 * eval/generators/seeded.ts. No gbrain import, no I/O.
 */
import { fingerprint, Rng, tokenFactory } from '../../../generators/seeded.ts';
import type { PrivacySubcause } from '../causes.ts';

export const WORLD_SCHEMA = 'gbrain-evals/predictive-out-of-view/world/v1';

export type IntendedView = 'visible' | PrivacySubcause;

/** A local caller is the trusted CLI (remote: false); a remote caller is an MCP client with no private-pages grant. */
export const CALLERS = ['local', 'remote'] as const;
export type Caller = (typeof CALLERS)[number];

/** What gbrain's rules say each caller should get: the local caller gets every page, the remote caller only unmarked ones. */
export function expectedReachable(intended: IntendedView, caller: Caller): boolean {
  return caller === 'local' || intended === 'visible';
}

export interface Knobs {
  /** Fictional projects; each has two gold pages and yields one cross-source task. */
  entities: number;
  /** Share of gold pages per sub-cause; the rest are visible. Shares sum to at most 1. */
  direct_flag_share: number;
  alias_share: number;
  derived_share: number;
}

/** Round design values, chosen before any measurement (D1). Gold private share 0.5. */
export const DEFAULT_KNOBS: Knobs = { entities: 50, direct_flag_share: 0.2, alias_share: 0.15, derived_share: 0.15 };

export const VARIANTS: Record<IntendedView, readonly string[]> = {
  visible: ['plain'],
  direct_flag: ['visibility_private'],
  alias_inheritance: ['access_alias', 'confidentiality_alias', 'declared_lineage'],
  derived_default: ['atom', 'synthesized_concept', 'atom_of_private_origin'],
};

const ACCESS_VALUES = ['private', 'restricted', 'confidential'];
const CONFIDENTIALITY_VALUES = ['confidential', 'secret', 'private', 'restricted'];

export const CHANNELS = ['crm', 'meeting', 'email', 'chat'] as const;
export type Channel = (typeof CHANNELS)[number];

const FIELD_BY_CHANNEL: Record<Channel, { field: string; label: string; where: string }> = {
  crm: { field: 'budget_code', label: 'budget code', where: 'the CRM record' },
  meeting: { field: 'launch_venue', label: 'launch venue', where: 'the meeting notes' },
  email: { field: 'vendor_contract', label: 'vendor contract number', where: 'the email thread' },
  chat: { field: 'review_room', label: 'review room', where: 'the team chat' },
};

const STEMS = ['Vellum', 'Kestrel', 'Lantern', 'Quarry', 'Saffron', 'Tamarind', 'Orrery', 'Juniper', 'Bramble', 'Cobalt', 'Marrow', 'Pylon'];

export interface WorldPage {
  slug: string;
  markdown: string;
  gold: boolean;
  /** Gold pages only. */
  intended?: IntendedView;
  variant?: string;
  entity?: string;
  channel?: Channel;
  field?: string;
  value?: string;
}

export interface Entity {
  id: string;
  name: string;
  /** The decoy sibling's name and pages, never gold. */
  decoy: { name: string; slug: string; values: Record<string, string> };
  facts: Array<{ channel: Channel; field: string; label: string; where: string; value: string; slug: string }>;
}

export interface World {
  schema: typeof WORLD_SCHEMA;
  seed: number;
  knobs: Knobs;
  entities: Entity[];
  pages: WorldPage[];
  /** sha256 of the canonical page list (slug and Markdown), pinned in the test. */
  digest: string;
}

export function validateKnobs(k: Knobs): void {
  if (!Number.isInteger(k.entities) || k.entities < 1) throw new Error('entities must be a positive integer');
  const shares = [k.direct_flag_share, k.alias_share, k.derived_share];
  if (!shares.every(s => Number.isFinite(s) && s >= 0 && s <= 1)) throw new Error('every share must be in 0..1');
  if (shares.reduce((a, b) => a + b, 0) > 1 + 1e-9) throw new Error('shares must sum to at most 1');
}

/** Exact intended counts per view for gold pages: round(share x gold) each, the rest visible. */
export function intendedCounts(k: Knobs): Record<IntendedView, number> {
  const gold = 2 * k.entities;
  const direct_flag = Math.round(k.direct_flag_share * gold);
  const alias_inheritance = Math.round(k.alias_share * gold);
  const derived_default = Math.round(k.derived_share * gold);
  const visible = gold - direct_flag - alias_inheritance - derived_default;
  if (visible < 0) throw new Error('rounded shares exceed the gold count');
  return { visible, direct_flag, alias_inheritance, derived_default };
}

function frontmatter(fields: Record<string, string>): string {
  return '---\n' + Object.entries(fields).map(([k, v]) => k + ': ' + v).join('\n') + '\n---\n';
}

/** Slug folder and frontmatter for one gold page's variant; an origin page when the variant links to one. */
function placeGold(variant: string, base: Record<string, string>, id: string, rng: Rng): { slug: string; fields: Record<string, string>; origin?: WorldPage } {
  const originSlug = 'origins/' + id;
  const origin: WorldPage = { slug: originSlug, gold: false, markdown: frontmatter({ title: 'Working file ' + id, visibility: 'private' }) + 'Working file for ' + base.title + '. Nothing in it answers a task.\n' };
  switch (variant) {
    case 'plain': return { slug: 'notes/' + id, fields: base };
    case 'visibility_private': return { slug: 'notes/' + id, fields: { ...base, visibility: 'private' } };
    case 'access_alias': return { slug: 'notes/' + id, fields: { ...base, access: rng.pick(ACCESS_VALUES) } };
    case 'confidentiality_alias': return { slug: 'notes/' + id, fields: { ...base, confidentiality: rng.pick(CONFIDENTIALITY_VALUES) } };
    case 'declared_lineage': return { slug: 'notes/' + id, fields: { ...base, derived_from: originSlug }, origin };
    case 'atom': return { slug: 'atoms/' + id, fields: { ...base, type: 'atom' } };
    case 'synthesized_concept': return { slug: 'concepts/' + id, fields: { ...base, type: 'concept', synthesized_by: 'dream-cycle' } };
    case 'atom_of_private_origin': return { slug: 'atoms/' + id, fields: { ...base, type: 'atom', visibility: 'world', source_slug: originSlug }, origin };
    default: throw new Error('unknown variant ' + variant);
  }
}

export function generateWorld(seed: number, knobs: Knobs = DEFAULT_KNOBS): World {
  validateKnobs(knobs);
  const rng = new Rng(seed);
  const token = tokenFactory(rng);
  const counts = intendedCounts(knobs);
  const views = rng.shuffle((Object.keys(counts) as IntendedView[]).flatMap(v => Array.from({ length: counts[v] }, () => v)));
  const entities: Entity[] = [];
  const pages: WorldPage[] = [];
  for (let e = 0; e < knobs.entities; e++) {
    const stem = rng.pick(STEMS);
    const tag = rng.letters(2);
    const id = 'p' + String(e + 1).padStart(3, '0');
    const name = 'Project ' + stem + '-' + tag + (e + 1);
    const decoyName = 'Project ' + stem + '-' + tag + (e + 1) + 'b';
    const channels = rng.shuffle(CHANNELS).slice(0, 2);
    const facts: Entity['facts'] = [];
    const decoyValues: Record<string, string> = {};
    channels.forEach((channel, i) => {
      const f = FIELD_BY_CHANNEL[channel];
      const value = token();
      decoyValues[f.field] = token();
      const intended = views[2 * e + i];
      const variant = rng.pick(VARIANTS[intended]);
      const pageId = id + '-' + channel;
      const base = { title: name + ' ' + f.label, channel };
      const placed = placeGold(variant, base, pageId, rng);
      if (placed.origin) pages.push(placed.origin);
      const markdown = frontmatter(placed.fields) + 'From ' + f.where + ': the ' + f.label + ' for ' + name + ' is ' + value + '.\n';
      pages.push({ slug: placed.slug, markdown, gold: true, intended, variant, entity: id, channel, field: f.field, value });
      facts.push({ channel, field: f.field, label: f.label, where: f.where, value, slug: placed.slug });
    });
    const decoySlug = 'notes/' + id + '-decoy';
    const decoyBody = facts.map(f => 'The ' + f.label + ' for ' + decoyName + ' is ' + decoyValues[f.field] + '.').join(' ');
    pages.push({ slug: decoySlug, gold: false, markdown: frontmatter({ title: decoyName + ' summary', channel: 'crm' }) + decoyBody + '\n' });
    entities.push({ id, name, decoy: { name: decoyName, slug: decoySlug, values: decoyValues }, facts });
  }
  pages.sort((a, b) => a.slug.localeCompare(b.slug));
  return { schema: WORLD_SCHEMA, seed, knobs, entities, pages, digest: fingerprint(pages.map(p => [p.slug, p.markdown])) };
}

