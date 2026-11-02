/**
 * Shared parts of the SkillOpt method task generators (GST-799, plan Phase 1).
 *
 * The three generators (query.ts, briefing.ts, fact-check.ts) turn committed
 * gold into candidate tasks over two frozen corpora:
 *
 *   messy-company-v1  the dev split's public pages, with gold from
 *                     labels/governing-records/dev.jsonl (value as of a date,
 *                     governing page, deciding passage, distractor pages);
 *   world-v1          every page, with gold from each page's structured
 *                     `_facts` (founders, affiliations).
 *
 * Each candidate names one anchor and the fact keys of its gold. An
 * independent oracle re-derives every gold value along a second path (the
 * deciding passage on the governing page; the other side of a world-v1
 * relationship and the page prose) and a candidate it cannot confirm is
 * dropped. A solvability control then scores an answer built from the gold
 * page's own wording, or the right abstention on a negative control, and drops
 * the candidate if that answer fails. `assembleSkill` joins candidates that
 * share an anchor or a fact key into one component, puts each component in
 * exactly one split and fills 24 train, 24 selection and 36 test tasks by
 * family quota, so no gold fact appears in two splits.
 *
 * skillopt-method-v2 (query-v2.ts, briefing-v2.ts, fact-check-v2.ts) adds
 * families that need procedure: a value as of a date that a later record
 * superseded, two values at once, a second hop through world-v1, several
 * meetings in one briefing. Its candidates draw on overlapping pages, so
 * `assembleGrouped` places them one at a time and joins a group only while it
 * stays in one split with at most three tasks.
 *
 * Everything is seeded and deterministic; no model is called.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSplit } from '../../runner/messy-company/load.ts';
import { renderWorldPage } from '../../runner/p5-brain.ts';
import { loadCorpus, type RichPage } from '../../runner/world-v1-gold.ts';
import { compileJudge, evaluateJudge, SPLITS, valuePattern, type Gold, type GoldValue, type Judge, type SkillName, type Split } from '../../runner/skillopt-method/score.ts';
import { addDays, Rng } from '../seeded.ts';

export const REPO_ROOT = join(import.meta.dir, '../../..');
export const MESSY_DIR = join(REPO_ROOT, 'eval/data/messy-company-v1');
export const WORLD_DIR = join(REPO_ROOT, 'eval/data/world-v1');
export const SPLIT_SIZES: Readonly<Record<Split, number>> = { train: 24, sel: 24, test: 36 };
/** At most this many tasks come from one component, so no split leans on a few pages. */
export const MAX_TASKS_PER_COMPONENT = 3;

export interface MethodTask {
  task_id: string;
  skill: SkillName;
  split: Split;
  family: string;
  task: string;
  judge: Judge;
  anchor: { kind: 'page' | 'entity' | 'claim' | 'record' | 'calendar'; id: string };
  /** Keys of the gold facts; tasks sharing one land in the same split. */
  fact_keys: string[];
  answerable: boolean;
  gold: Gold;
  /** Pages and values a careless answer might use instead (stale records, look-alikes, co-occurring people). */
  distractors: { slugs: string[]; values: GoldValue[] };
  /** Where the gold comes from: a label row or a structured field. */
  source: string;
  /** The oracle's second derivation path and the text it confirmed the gold in. */
  oracle: { path: string; evidence: string };
  /** Solvability control: an answer built from the gold page's wording (or the right abstention) that the scorer must pass. */
  oracle_answer: string;
}

export type Candidate = Omit<MethodTask, 'task_id' | 'split' | 'judge' | 'skill'>;
/** `priority` (v2 only): within a family, `assembleGrouped` tries higher-priority candidates first (more traps, more pages to consult). */
export type Draft = { ok: true; candidate: Candidate; priority?: number } | { ok: false; family: string; anchor: string; reason: string };
export type Quotas = Readonly<Record<string, readonly [number, number, number]>>;

export interface GenerationReport {
  skill: SkillName;
  seed: number;
  candidates: Record<string, number>;
  dropped_by_oracle: number;
  dropped_by_solvability: number;
  dropped: Array<{ family: string; anchor: string; reason: string }>;
  components: number;
  assigned: Record<string, Record<Split, number>>;
  unused_candidates: number;
  /** v2: the seeded attempt of `assembleGrouped` that filled every quota. */
  assembly_attempt?: number;
  /** v2: why a family's quota differs from the plan, when the corpora could not fill it. */
  notes?: string[];
}

export interface SkillGeneration { tasks: MethodTask[]; report: GenerationReport }

// ─── Corpora ─────────────────────────────────────────────────────────────────

export interface Corpus {
  /** Slug to page text, for every page the rollout brain holds. */
  pages: Map<string, string>;
  world: Map<string, RichPage>;
  /** Lowercased text of every page of both corpora (held-out and private pages included), for absence checks. */
  allText: string;
}

let cached: Corpus | null = null;

/** The pages the rollout brain holds: messy-company-v1 dev public pages and every world-v1 page. */
export function loadCorpora(): Corpus {
  if (cached) return cached;
  const pages = new Map<string, string>();
  for (const p of readSplit('dev', MESSY_DIR)) if (!p.private) pages.set(p.slug, p.content);
  const world = new Map<string, RichPage>();
  for (const p of loadCorpus(WORLD_DIR)) {
    if (pages.has(p.slug)) throw new Error(`slug ${p.slug} is in both corpora`);
    world.set(p.slug, p);
    pages.set(p.slug, renderWorldPage(p));
  }
  const allText = [...readSplit('all', MESSY_DIR).map(p => p.content), ...[...world.values()].map(renderWorldPage)].join('\n').toLowerCase();
  cached = { pages, world, allText };
  return cached;
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

export const matches = (v: GoldValue, text: string) => new RegExp(valuePattern(v), 'm').test(text);

/** The first sentence of `text` that mentions `needle` (case-insensitive), or null. */
export function sentenceWith(text: string, needle: string): string | null {
  const lower = needle.toLowerCase();
  return text.split(/(?<=[.!?])\s+|\n+/).map(normalize).find(s => s.toLowerCase().includes(lower)) ?? null;
}

/** True when `phrase` occurs in no page of either corpus as a whole word sequence. */
export function absentFromCorpora(corpus: Corpus, phrase: string): boolean {
  const re = new RegExp(`(?<![a-z0-9])${phrase.toLowerCase().replace(/[.*+?^$(){}|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![a-z0-9])`);
  return !re.test(corpus.allText);
}

// ─── messy-company-v1 governing records ──────────────────────────────────────

export interface GovRow {
  id: string;
  account: string;
  attribute: string;
  as_of: string;
  value: number | string;
  /** Signing and effective dates of the governing record. */
  signed: string;
  effective: string;
  governing_slug: string;
  deciding_passage: { slug: string; line: number; quote: string };
  traps: string[];
  distractor_slugs: string[];
}

export interface Attribute {
  /** How a question or claim names the attribute. */
  phrase: string;
  gold(value: number | string): GoldValue;
  /** How a claim states a value. */
  format(value: number | string): string;
}

const thousands = (n: number) => n.toLocaleString('en-US');

export const ATTRIBUTES: Readonly<Record<string, Attribute>> = {
  seats: { phrase: 'subscribed seat count', gold: v => ({ kind: 'number', value: Number(v) }), format: v => `${thousands(Number(v))} seats` },
  price_per_seat: { phrase: 'list price per seat per year (before discount)', gold: v => ({ kind: 'number', value: Number(v), unit: 'money' }), format: v => `$${thousands(Number(v))}` },
  discount_pct: { phrase: 'discount off list price', gold: v => ({ kind: 'number', value: Number(v), unit: 'percent' }), format: v => `${v}%` },
  renewal_date: { phrase: 'renewal date (the last day of the current subscription term)', gold: v => ({ kind: 'date', value: String(v) }), format: v => longDate(String(v)) },
  sla_tier: { phrase: 'support tier', gold: v => ({ kind: 'name', value: String(v) }), format: v => String(v) },
  notice_days: { phrase: 'non-renewal notice period', gold: v => ({ kind: 'number', value: Number(v), unit: 'days' }), format: v => `${v} days` },
  payment_terms_days: { phrase: 'payment term (days until an invoice is due)', gold: v => ({ kind: 'number', value: Number(v), unit: 'days' }), format: v => `${v} days` },
};

let names: Map<string, string> | null = null;

/** Account id to display name, from the messy-company plan. */
export function accountNames(): Map<string, string> {
  if (names) return names;
  const world = JSON.parse(readFileSync(join(MESSY_DIR, 'plan/world.json'), 'utf8')) as { accounts: Array<{ id: string; name: string }> };
  names = new Map(world.accounts.map(a => [a.id, a.name]));
  return names;
}

export function governingRows(split: 'dev' | 'heldout' = 'dev'): GovRow[] {
  return readFileSync(join(MESSY_DIR, 'labels/governing-records', `${split}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as GovRow);
}

/**
 * Oracle for a governing-records row: the governing page is in the brain, the
 * deciding passage sits on that page, and the gold value reads out of the
 * passage through the scorer's own tolerant pattern. Returns the passage, or
 * the reason the row is dropped.
 */
export function confirmGovRow(corpus: Corpus, row: GovRow): { evidence: string } | { reason: string } {
  const page = corpus.pages.get(row.governing_slug);
  if (!page) return { reason: 'governing page is not in the rollout brain' };
  if (row.deciding_passage.slug !== row.governing_slug) return { reason: 'deciding passage is on another page' };
  const quote = normalize(row.deciding_passage.quote);
  const paragraph = page.split(/\n\s*\n/).map(normalize).find(p => p.includes(quote));
  if (!paragraph) return { reason: 'deciding passage not found on the governing page' };
  const attribute = ATTRIBUTES[row.attribute];
  if (!attribute) return { reason: `unknown attribute ${row.attribute}` };
  if (!matches(attribute.gold(row.value), paragraph)) return { reason: 'gold value does not read out of the paragraph holding the deciding passage' };
  return { evidence: paragraph };
}

export interface GovFact {
  row: GovRow;
  /** The account's display name. */
  account: string;
  attribute: Attribute;
  /** The paragraph of the governing page that holds the deciding passage. */
  evidence: string;
  /** The account's other values for this attribute, at other dates (stale or not yet in force). */
  others: GoldValue[];
}

export type GovResult = { ok: true; fact: GovFact } | { ok: false; row: GovRow; reason: string };

/** Every dev governing record, each confirmed by the oracle or carrying the reason it is dropped. */
export function govFacts(corpus: Corpus): GovResult[] {
  const names = accountNames();
  const rows = governingRows();
  return rows.map((row): GovResult => {
    const account = names.get(row.account);
    if (!account) return { ok: false, row, reason: 'account is not in plan/world.json' };
    const o = confirmGovRow(corpus, row);
    if ('reason' in o) return { ok: false, row, reason: o.reason };
    const attribute = ATTRIBUTES[row.attribute]!;
    const others = [...new Set(rows.filter(r => r.account === row.account && r.attribute === row.attribute && String(r.value) !== String(row.value)).map(r => String(r.value)))].sort();
    return { ok: true, fact: { row, account, attribute, evidence: o.evidence, others: others.map(v => attribute.gold(v)) } };
  });
}

/** Gold, fact keys and citation for a governing-record fact, shared by the three skills. */
export function govBase(f: GovFact) {
  return {
    anchor: { kind: 'page' as const, id: f.row.governing_slug },
    fact_keys: [govFactKey(f.row), `page:${f.row.governing_slug}`],
    distractors: { slugs: f.row.distractor_slugs, values: f.others },
    source: `messy-company-v1 labels/governing-records/dev.jsonl ${f.row.id}`,
    oracle: { path: 'the paragraph holding the labelled deciding passage on the governing page; the gold value reads out of it through the scorer pattern', evidence: f.evidence },
  };
}

/**
 * A wrong value for a contradicted claim: a nearby value of the same kind that
 * is none of the account's recorded values for the attribute and does not read
 * out of the governing paragraph.
 */
export function perturbedValue(f: GovFact, rng: Rng): number | string | null {
  const { row } = f;
  const known = new Set([String(row.value), ...f.others.map(v => String(v.value))]);
  const options: Array<number | string> = [];
  const n = Number(row.value);
  if (row.attribute === 'seats') for (const d of [15, -12, 25, -20, 40, 8]) options.push(n + d);
  if (row.attribute === 'price_per_seat') for (const d of [150, -120, 250, -200, 90]) options.push(n + d);
  if (row.attribute === 'discount_pct') for (const d of [3, -4, 5, -2, 7]) options.push(n + d);
  if (row.attribute === 'notice_days' || row.attribute === 'payment_terms_days') for (const d of [30, -15, 15, 45]) options.push(n + d);
  if (row.attribute === 'sla_tier') options.push('Tier 1', 'Tier 2', 'Tier 3');
  if (row.attribute === 'renewal_date') for (const months of [1, -2, 3, -1]) options.push(monthEnd(String(row.value), months));
  const valid = options.filter(v => !known.has(String(v)) && (typeof v === 'string' || v > 0) && !matches(f.attribute.gold(v), f.evidence));
  return valid.length ? rng.pick(valid) : null;
}

/** The last day of the month `months` after the month of `iso`. */
function monthEnd(iso: string, months: number): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, m! + months, 0)).toISOString().slice(0, 10);
}

export const govFactKey = (row: GovRow) => `gov:${row.account}:${row.attribute}=${row.value}`;

// ─── v2: superseded records and pairs ────────────────────────────────────────

/**
 * The record a governing-records row supersedes: the latest earlier labelled
 * row for the same account and attribute whose governing page and value both
 * differ from this row's. Null when no earlier record held another value.
 */
export function supersededRow(rows: readonly GovRow[], row: GovRow): GovRow | null {
  return rows
    .filter(r => r.account === row.account && r.attribute === row.attribute && r.as_of < row.as_of && r.governing_slug !== row.governing_slug && String(r.value) !== String(row.value))
    .sort((a, b) => a.as_of.localeCompare(b.as_of))
    .at(-1) ?? null;
}

export interface SupersededFact {
  fact: GovFact;
  /** The superseded record's row, and the paragraph of its own page its value reads out of. */
  prev: GovRow;
  prevEvidence: string;
}

export type SupersededResult = { ok: true; s: SupersededFact } | { ok: false; row: GovRow; reason: string };

/**
 * Every dev governing record that superseded another value, confirmed or with
 * its drop reason. Beyond confirmGovRow, the oracle checks that the superseded
 * value reads out of the superseded record's own deciding paragraph (so the
 * brain really holds the stale value) and that the labels' effective dates put
 * that record in force first and the governing one in force on the row's date.
 */
export function supersededFacts(corpus: Corpus): SupersededResult[] {
  const rows = governingRows();
  const out: SupersededResult[] = [];
  for (const g of govFacts(corpus)) {
    const row = g.ok ? g.fact.row : g.row;
    const prev = supersededRow(rows, row);
    if (!prev) continue;
    if (!g.ok) { out.push({ ok: false, row, reason: g.reason }); continue; }
    if (!(prev.effective < row.effective && row.effective <= row.as_of)) { out.push({ ok: false, row, reason: 'the labels do not put the superseded record in force before the governing one' }); continue; }
    const o = confirmGovRow(corpus, prev);
    if ('reason' in o) { out.push({ ok: false, row, reason: `superseded record: ${o.reason}` }); continue; }
    out.push({ ok: true, s: { fact: g.fact, prev, prevEvidence: o.evidence } });
  }
  return out;
}

export const pairId = (a: GovRow, b: GovRow) => `${a.account}:${a.attribute}+${b.attribute}:${a.as_of}`;

export type GovPairResult = { ok: true; a: GovFact; b: GovFact } | { ok: false; anchor: string; reason: string };

/**
 * Every pair of dev governing records for one account on one date (two
 * attributes, in ATTRIBUTES order). A pair is confirmed when the oracle
 * confirms both rows and neither value reads as the other, since two "30 days"
 * values could not be told apart.
 */
export function govPairs(corpus: Corpus): GovPairResult[] {
  const results = govFacts(corpus);
  const order = Object.keys(ATTRIBUTES);
  const rowOf = (g: GovResult) => (g.ok ? g.fact.row : g.row);
  const out: GovPairResult[] = [];
  for (const a of results) for (const b of results) {
    const ra = rowOf(a), rb = rowOf(b);
    if (ra.account !== rb.account || ra.as_of !== rb.as_of || order.indexOf(ra.attribute) >= order.indexOf(rb.attribute)) continue;
    const anchor = pairId(ra, rb);
    if (!a.ok) { out.push({ ok: false, anchor, reason: `${ra.attribute}: ${a.reason}` }); continue; }
    if (!b.ok) { out.push({ ok: false, anchor, reason: `${rb.attribute}: ${b.reason}` }); continue; }
    const [fa, fb] = [a.fact, b.fact];
    if (matches(fa.attribute.gold(ra.value), fb.attribute.format(rb.value)) || matches(fb.attribute.gold(rb.value), fa.attribute.format(ra.value))) { out.push({ ok: false, anchor, reason: 'the two values read as each other' }); continue; }
    out.push({ ok: true, a: fa, b: fb });
  }
  return out;
}

/** Fields a candidate about two governing-record facts shares across skills, and the distinct governing pages (one citation group each). */
export function pairBase(a: GovFact, b: GovFact) {
  const pages = [...new Set([a.row.governing_slug, b.row.governing_slug])];
  return {
    pages,
    base: {
      anchor: { kind: 'record' as const, id: pairId(a.row, b.row) },
      fact_keys: [govFactKey(a.row), govFactKey(b.row), ...pages.map(p => `page:${p}`)],
      distractors: { slugs: [...new Set([...a.row.distractor_slugs, ...b.row.distractor_slugs])].filter(x => !pages.includes(x)), values: [...a.others, ...b.others] },
      source: `messy-company-v1 labels/governing-records/dev.jsonl ${a.row.id} and ${b.row.id}`,
      oracle: { path: 'for each row, the paragraph holding the labelled deciding passage on its governing page; each gold value reads out of its own paragraph through the scorer pattern', evidence: a.evidence === b.evidence ? a.evidence : `${a.evidence}\n\n${b.evidence}` },
    },
  };
}

// ─── world-v1 relationships ──────────────────────────────────────────────────

const ROLE_FIELDS = ['founders', 'employees', 'investors', 'advisors'] as const;

/** True when no other world-v1 page and no messy-company account carries this page's title, so a question naming it is unambiguous. */
export function uniqueTitle(corpus: Corpus, page: RichPage): boolean {
  if ([...accountNames().values()].some(n => n.toLowerCase() === page.title.toLowerCase())) return false;
  return [...corpus.world.values()].filter(p => p.title.toLowerCase() === page.title.toLowerCase()).length === 1;
}

/**
 * Oracle for "P founded C": C's facts list P as its only founder, P's own
 * facts say founder of C, and C's page prose names P. Returns the sentence.
 */
export function confirmFounder(corpus: Corpus, company: RichPage): { founder: string; evidence: string } | { reason: string } {
  const founders = company._facts.founders ?? [];
  if (founders.length !== 1) return { reason: `${founders.length} founders in _facts` };
  const founder = corpus.world.get(founders[0]!);
  if (!founder) return { reason: 'founder page missing' };
  if (founder._facts.role !== 'founder' || founder._facts.primary_affiliation !== company.slug) return { reason: "founder's own page does not say founder of this company" };
  if (!uniqueTitle(corpus, company) || !uniqueTitle(corpus, founder)) return { reason: 'company or founder title is not unique' };
  const evidence = sentenceWith(company.compiled_truth, founder.title);
  if (!evidence) return { reason: 'company page prose does not name the founder' };
  return { founder: founder.slug, evidence };
}

const sentences = (p: RichPage) => `${p.compiled_truth}\n${p.timeline}`.split(/(?<=[.!?])\s+|\n+/).map(normalize).filter(Boolean);

/**
 * Oracle for "P works with C" (P's primary affiliation): C's facts list P in a
 * role or C's page prose names P, and P's page prose names C. Returns the
 * sentence on P's page.
 */
export function confirmAffiliation(corpus: Corpus, person: RichPage): { company: string; evidence: string } | { reason: string } {
  const slug = person._facts.primary_affiliation;
  const company = slug ? corpus.world.get(slug) : undefined;
  if (!company) return { reason: 'no primary affiliation page' };
  const listed = ROLE_FIELDS.some(f => (company._facts[f] ?? []).includes(person.slug));
  if (!listed && !sentences(company).some(x => x.includes(person.title))) return { reason: "neither the company's _facts nor its page prose name the person" };
  if (!uniqueTitle(corpus, company) || !uniqueTitle(corpus, person)) return { reason: 'person or company title is not unique' };
  const evidence = sentenceWith(person.compiled_truth, company.title);
  if (!evidence) return { reason: 'person page prose does not name the company' };
  return { company: company.slug, evidence };
}

/** People the company's facts tie to it in a role other than founder (investors, employees, advisors). */
export function nonFounderAffiliates(corpus: Corpus, company: RichPage): RichPage[] {
  const founders = new Set(company._facts.founders ?? []);
  return [...new Set([...(company._facts.investors ?? []), ...(company._facts.employees ?? []), ...(company._facts.advisors ?? [])])]
    .filter(s => !founders.has(s))
    .map(s => corpus.world.get(s))
    .filter((p): p is RichPage => !!p && !(p._facts.role === 'founder' && p._facts.primary_affiliation === company.slug));
}

/**
 * Oracle for "P did not found C" (AFFILIATION ≠ AUTHORSHIP): C's facts tie P
 * to C in another role, neither P's facts nor C's founders list say founder,
 * no sentence linking them (C's page naming P, or P's page naming C) has a
 * "found" word, and at least one such sentence exists, so the brain holds the
 * affiliation. Returns the first linking sentence.
 */
export function confirmNotFounder(corpus: Corpus, company: RichPage, person: RichPage): { evidence: string } | { reason: string } {
  if ((company._facts.founders ?? []).includes(person.slug)) return { reason: 'listed as a founder' };
  if (person._facts.role === 'founder' && person._facts.primary_affiliation === company.slug) return { reason: "person's own facts say founder of this company" };
  if (!uniqueTitle(corpus, company) || !uniqueTitle(corpus, person)) return { reason: 'person or company title is not unique' };
  const linking = [...sentences(company).filter(x => x.includes(person.title)), ...sentences(person).filter(x => x.includes(company.title))];
  if (linking.some(x => /\bfound/i.test(x))) return { reason: 'a sentence linking the person and the company has a "found" word' };
  if (!linking.length) return { reason: "neither page's prose names the other" };
  return { evidence: linking[0]! };
}

// ─── v2: second hops ─────────────────────────────────────────────────────────

/**
 * Oracle for the last hop of a multi-hop question: C's founder is confirmed
 * (confirmFounder), and the founder's own page has a sentence naming C with a
 * "found" word, so the page the answer must cite holds the answer.
 */
export function confirmFounderPage(corpus: Corpus, company: RichPage): { founder: RichPage; evidence: string } | { reason: string } {
  const o = confirmFounder(corpus, company);
  if ('reason' in o) return o;
  const founder = corpus.world.get(o.founder)!;
  const evidence = sentences(founder).find(x => x.includes(company.title) && /\bfound/i.test(x));
  if (!evidence) return { reason: "the founder's page has no sentence naming the company with a founding word" };
  return { founder, evidence };
}

/**
 * Oracle for "P is an employee of C" or "P advises C" as a first hop: exactly
 * one company lists P in that role, both titles are unique, and a sentence on
 * either page names the other.
 */
export function confirmRoleTie(corpus: Corpus, person: RichPage, role: 'employees' | 'advisors'): { company: RichPage; evidence: string } | { reason: string } {
  const tied = [...corpus.world.values()].filter(c => c.type === 'company' && (c._facts[role] ?? []).includes(person.slug));
  if (tied.length !== 1) return { reason: `${tied.length} companies list the person among ${role}` };
  const company = tied[0]!;
  if (!uniqueTitle(corpus, company) || !uniqueTitle(corpus, person)) return { reason: 'person or company title is not unique' };
  const evidence = sentences(person).find(x => x.includes(company.title)) ?? sentences(company).find(x => x.includes(person.title));
  if (!evidence) return { reason: "neither page's prose names the other" };
  return { company, evidence };
}

/** Oracle for a world-v1 meeting's topic company as a first hop: the company's title is unique and the meeting page's prose names it. */
export function confirmMeetingTopic(corpus: Corpus, meeting: RichPage): { company: RichPage; evidence: string } | { reason: string } {
  const company = corpus.world.get(String(meeting._facts.topic_company));
  if (!company) return { reason: 'topic company page missing' };
  if (!uniqueTitle(corpus, company)) return { reason: 'company title is not unique' };
  const evidence = sentences(meeting).find(x => x.includes(company.title));
  if (!evidence) return { reason: 'meeting page prose does not name the topic company' };
  return { company, evidence };
}

// ─── Negative controls ───────────────────────────────────────────────────────

const INVENTED_FIRST = ['Corvin', 'Talisa', 'Odran', 'Mireille', 'Bastien', 'Ysolde', 'Caspian', 'Linnea', 'Thaddeus', 'Oriane', 'Leopold', 'Saskia', 'Evander', 'Ingrid', 'Ambrose', 'Petrina', 'Lisandro', 'Wilhelmina'];
const INVENTED_LAST = ['Vantwerp', 'Halloran', 'Quist', 'Ellery', 'Marchbank', 'Oyelaran', 'Szabo', 'Tremaine', 'Fairweather', 'Castellane', 'Okonkwo', 'Lindqvale', 'Abernathy', 'Kowalczyk', 'Iversen', 'Montclair'];
const INVENTED_STEMS = ['Thistlewick', 'Corvane', 'Halbridge', 'Pellmora', 'Starlow', 'Brindlecote', 'Wexmoor', 'Kelderline', 'Mirefield', 'Quenby', 'Tolvane', 'Ferncastle', 'Ostraval', 'Glimmerton', 'Varrowby', 'Lunsford'];
const COMPANY_SUFFIXES = ['Robotics', 'Analytics', 'Health', 'Labs', 'Logistics', 'Systems', 'Biotech', 'Capital'];

export interface NegativeName { name: string; kind: 'invented' | 'lookalike'; near?: string; evidence: string }

/** Invented people: neither the full name nor the surname occurs in either corpus. */
export function inventedPeople(corpus: Corpus, rng: Rng, n: number): NegativeName[] {
  const out: NegativeName[] = [];
  for (const first of rng.shuffle(INVENTED_FIRST)) {
    const last = INVENTED_LAST[out.length % INVENTED_LAST.length]!;
    const name = `${first} ${last}`;
    if (absentFromCorpora(corpus, name) && absentFromCorpora(corpus, last)) out.push({ name, kind: 'invented', evidence: `neither "${name}" nor "${last}" occurs in any page of either corpus` });
    if (out.length === n) break;
  }
  return out;
}

/** Invented companies: neither the full name nor its stem occurs in either corpus. */
export function inventedCompanies(corpus: Corpus, rng: Rng, n: number): NegativeName[] {
  const out: NegativeName[] = [];
  for (const stem of rng.shuffle(INVENTED_STEMS)) {
    const name = `${stem} ${rng.pick(COMPANY_SUFFIXES)}`;
    if (absentFromCorpora(corpus, name) && absentFromCorpora(corpus, stem)) out.push({ name, kind: 'invented', evidence: `neither "${name}" nor "${stem}" occurs in any page of either corpus` });
    if (out.length === n) break;
  }
  return out;
}

/** Look-alike people: a world-v1 first name with another world-v1 person's surname, a full name no page carries. */
export function lookalikePeople(corpus: Corpus, rng: Rng, n: number): NegativeName[] {
  const people = rng.shuffle([...corpus.world.values()].filter(p => p.type === 'person'));
  const out: NegativeName[] = [];
  for (let i = 0; i < people.length && out.length < n; i++) {
    const a = people[i]!;
    const b = people[(i + 7) % people.length]!;
    const [first] = a.title.split(' ');
    const last = b.title.split(' ').slice(1).join(' ');
    const name = `${first} ${last}`;
    if (!last || a.title === name || b.title === name || out.some(o => o.name === name)) continue;
    if (absentFromCorpora(corpus, name)) out.push({ name, kind: 'lookalike', near: a.slug, evidence: `"${name}" occurs in no page; "${a.title}" and "${b.title}" do` });
  }
  return out;
}

/** v2: invented people from every first-and-last-name pair, in seeded order: neither the full name nor the surname occurs in either corpus. */
export function inventedPeopleGrid(corpus: Corpus, rng: Rng, n: number): NegativeName[] {
  const out: NegativeName[] = [];
  for (const [first, last] of rng.shuffle(INVENTED_FIRST.flatMap(f => INVENTED_LAST.map(l => [f, l] as const)))) {
    if (out.length === n) break;
    const name = `${first} ${last}`;
    if (absentFromCorpora(corpus, name) && absentFromCorpora(corpus, last)) out.push({ name, kind: 'invented', evidence: `neither "${name}" nor "${last}" occurs in any page of either corpus` });
  }
  return out;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Marrow Fieldworks" → "Marrow Fieldworks'", "Orrin" → "Orrin's" */
export const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);

/** 2026-03-31 → March 31, 2026 */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTH_NAMES[m! - 1]} ${d}, ${y}`;
}

export function weekday(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()]!;
}

/** `iso` itself on a weekday, else the Friday before it. */
export function workday(iso: string): string {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return day === 0 ? addDays(iso, -2) : day === 6 ? addDays(iso, -1) : iso;
}

/** Internal calendar entries with no brain page behind them; they fill the day around the meeting a task asks about. */
export const FILLER_ENTRIES = ['Team standup (internal)', 'Focus block', 'Lunch', 'Weekly planning (internal)', 'Inbox and follow-ups', 'Hiring sync (internal)'];
export const MEETING_TIMES = ['09:00', '10:30', '11:30', '13:00', '14:30', '16:00', '17:00'];

// ─── Assembly ────────────────────────────────────────────────────────────────

/** Every anchor, fact key and gold slug that appears in more than one split, and duplicate task ids. */
export function splitLeaks(tasks: readonly MethodTask[]): string[] {
  const seen = new Map<string, Split>();
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.task_id)) problems.push(`duplicate task id ${t.task_id}`);
    ids.add(t.task_id);
    const keys = new Set([`anchor:${t.anchor.id}`, ...t.fact_keys, ...t.gold.slugs.map(s => `page:${s}`)]);
    for (const k of keys) {
      const at = seen.get(k);
      if (at && at !== t.split) problems.push(`${k} is in ${at} and ${t.split}`);
      seen.set(k, t.split);
    }
  }
  return problems;
}


/** Union-find over anchors and fact keys: candidates that share either land in one component. */
function components(candidates: readonly Candidate[]): Candidate[][] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const key = (c: Candidate) => `anchor:${c.anchor.id}`;
  for (const c of candidates) for (const k of [key(c), ...c.fact_keys]) if (!parent.has(k)) parent.set(k, k);
  for (const c of candidates) for (const k of c.fact_keys) parent.set(find(k), find(key(c)));
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const root = find(key(c));
    groups.set(root, [...(groups.get(root) ?? []), c]);
  }
  return [...groups.values()];
}

/**
 * Validate drafts (oracle), run the solvability control, then fill the splits
 * by family quota (quotas[family] = [train, sel, test]) one whole component at
 * a time. Throws when the candidates cannot fill a quota.
 */
/** Count candidates per family, drop those the oracle rejected or whose solvability control fails, and record each drop. */
function screen(skill: SkillName, seed: number, drafts: readonly Draft[]): { report: GenerationReport; kept: Array<{ candidate: Candidate; priority: number }> } {
  const report: GenerationReport = { skill, seed, candidates: {}, dropped_by_oracle: 0, dropped_by_solvability: 0, dropped: [], components: 0, assigned: {}, unused_candidates: 0 };
  const kept: Array<{ candidate: Candidate; priority: number }> = [];
  for (const d of drafts) {
    const family = d.ok ? d.candidate.family : d.family;
    report.candidates[family] = (report.candidates[family] ?? 0) + 1;
    if (!d.ok) {
      report.dropped_by_oracle++;
      report.dropped.push({ family, anchor: d.anchor, reason: d.reason });
      continue;
    }
    if (!evaluateJudge(d.candidate.oracle_answer, compileJudge(skill, d.candidate.gold)).correct) {
      report.dropped_by_solvability++;
      report.dropped.push({ family, anchor: d.candidate.anchor.id, reason: 'solvability control failed: the answer built from the gold page does not pass the scorer' });
      continue;
    }
    kept.push({ candidate: d.candidate, priority: d.priority ?? 0 });
  }
  return { report, kept };
}

export function assembleSkill(skill: SkillName, seed: number, drafts: readonly Draft[], quotas: Quotas): SkillGeneration {
  const rng = new Rng(seed);
  const screened = screen(skill, seed, drafts);
  const report = screened.report;
  const kept = screened.kept.map(k => k.candidate);

  for (const family of Object.keys(quotas)) report.assigned[family] = { train: 0, sel: 0, test: 0 };
  const comps = rng.shuffle(components(kept).map(c => rng.shuffle(c).slice(0, MAX_TASKS_PER_COMPONENT)));
  report.components = comps.length;
  const need = (family: string, split: Split) => (quotas[family]?.[SPLITS.indexOf(split)] ?? 0) - report.assigned[family]![split];
  const placed: Array<Candidate & { split: Split }> = [];
  for (const comp of comps.sort((a, b) => b.length - a.length)) {
    const gain = (split: Split) => comp.filter((c, i) => comp.slice(0, i).filter(x => x.family === c.family).length < need(c.family, split)).length;
    const best = [...SPLITS].sort((a, b) => gain(b) - gain(a))[0]!;
    if (gain(best) === 0) continue;
    for (const c of comp) {
      if (need(c.family, best) <= 0) continue;
      report.assigned[c.family]![best]++;
      placed.push({ ...c, split: best });
    }
  }
  for (const [family, q] of Object.entries(quotas)) {
    const got = report.assigned[family]!;
    if (got.train !== q[0] || got.sel !== q[1] || got.test !== q[2]) throw new Error(`${skill}: family ${family} filled ${got.train}/${got.sel}/${got.test} of ${q.join('/')} from ${kept.filter(c => c.family === family).length} confirmed candidates`);
  }
  report.unused_candidates = kept.length - placed.length;

  const tasks: MethodTask[] = [];
  for (const split of SPLITS) {
    const inSplit = rng.shuffle(placed.filter(c => c.split === split));
    if (inSplit.length !== SPLIT_SIZES[split]) throw new Error(`${skill}: ${split} has ${inSplit.length} tasks, want ${SPLIT_SIZES[split]}`);
    inSplit.forEach((c, i) => {
      const { split: _, ...rest } = c;
      tasks.push({ task_id: `${skill}-${split}-${String(i + 1).padStart(2, '0')}`, skill, split, ...rest, judge: compileJudge(skill, c.gold) });
    });
  }
  return { tasks, report };
}

// ─── v2 assembly ─────────────────────────────────────────────────────────────

/** The keys that tie tasks into one group: anchor, gold facts and gold pages (the same keys splitLeaks checks). */
const taskKeys = (t: Pick<MethodTask, 'anchor' | 'fact_keys' | 'gold'>) => [...new Set([`anchor:${t.anchor.id}`, ...t.fact_keys, ...t.gold.slugs.map(x => `page:${x}`)])];

/** Sizes of the connected groups of tasks that share an anchor, a gold fact or a gold page, largest first. */
export function groupSizes(tasks: ReadonlyArray<Pick<MethodTask, 'anchor' | 'fact_keys' | 'gold'>>): number[] {
  const owner = new Map<string, number>();
  const parent = tasks.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  tasks.forEach((t, i) => {
    for (const k of taskKeys(t)) {
      const j = owner.get(k);
      if (j === undefined) owner.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const sizes = new Map<number, number>();
  tasks.forEach((_, i) => sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1));
  return [...sizes.values()].sort((a, b) => b - a);
}

/** Seeded attempts `assembleGrouped` makes before it gives up. */
export const ASSEMBLY_ATTEMPTS = 500;

/**
 * One seeded attempt: place candidates one at a time (scarcest family first,
 * then by priority, then in seeded order). A candidate joins the groups it
 * touches only when they sit in one split, its family still needs tasks there,
 * the joined group stays at MAX_TASKS_PER_COMPONENT or fewer and its anchor is
 * unused; a candidate touching no group opens one in the split its family
 * most needs. Returns the placed tasks when every quota is filled exactly.
 */
function fillOnce(kept: ReadonlyArray<{ candidate: Candidate; priority: number }>, quotas: Quotas, order: readonly string[], rng: Rng): Array<Candidate & { split: Split }> | null {
  const assigned = Object.fromEntries(Object.keys(quotas).map(f => [f, { train: 0, sel: 0, test: 0 }])) as Record<string, Record<Split, number>>;
  const quota = (f: string, sp: Split) => quotas[f]![SPLITS.indexOf(sp)]!;
  const need = (f: string, sp: Split) => quota(f, sp) - assigned[f]![sp];
  const groups: Array<{ split: Split; size: number; keys: string[] }> = [];
  const groupOf = new Map<string, number>();
  const anchors = new Set<string>();
  const placed: Array<Candidate & { split: Split }> = [];
  const splitOrder = rng.shuffle(SPLITS);
  const queue = order.flatMap(f => rng.shuffle(kept.filter(k => k.candidate.family === f)).sort((a, b) => b.priority - a.priority));
  for (const { candidate: c } of queue) {
    if (anchors.has(c.anchor.id)) continue;
    const keys = taskKeys(c);
    const touched = [...new Set(keys.map(k => groupOf.get(k)).filter((g): g is number => g !== undefined))];
    let split: Split | undefined;
    if (touched.length) {
      if (new Set(touched.map(g => groups[g]!.split)).size > 1) continue;
      split = groups[touched[0]!]!.split;
      if (touched.reduce((n, g) => n + groups[g]!.size, 0) + 1 > MAX_TASKS_PER_COMPONENT || need(c.family, split) <= 0) continue;
    } else {
      split = splitOrder.filter(sp => need(c.family, sp) > 0).sort((a, b) => need(c.family, b) / quota(c.family, b) - need(c.family, a) / quota(c.family, a))[0];
      if (!split) continue;
    }
    const merged = { split, size: touched.reduce((n, g) => n + groups[g]!.size, 0) + 1, keys: [...keys, ...touched.flatMap(g => groups[g]!.keys)] };
    groups.push(merged);
    for (const k of merged.keys) groupOf.set(k, groups.length - 1);
    anchors.add(c.anchor.id);
    assigned[c.family]![split]++;
    placed.push({ ...c, split });
  }
  return Object.keys(quotas).every(f => SPLITS.every(sp => need(f, sp) === 0)) ? placed : null;
}

/**
 * v2 assembly. Screens the drafts like `assembleSkill`, then fills the splits
 * with `fillOnce`, retrying with the next seed until one attempt fills every
 * family quota exactly. Families are placed scarcest first (confirmed
 * candidates per quota slot), after any families `opts.first` names.
 * Candidates of one family that share an anchor are
 * alternatives (variants of one calendar or claim): at most one is placed.
 * Throws when no attempt fills the quotas.
 */
export function assembleGrouped(skill: SkillName, seed: number, drafts: readonly Draft[], quotas: Quotas, opts: { notes?: readonly string[]; first?: readonly string[] } = {}): SkillGeneration {
  const { report, kept } = screen(skill, seed, drafts);
  const families = Object.keys(quotas);
  const stray = kept.find(k => !families.includes(k.candidate.family));
  if (stray) throw new Error(`${skill}: family ${stray.candidate.family} has no quota`);
  const supply = (f: string) => kept.filter(k => k.candidate.family === f).length / quotas[f]!.reduce((a, b) => a + b, 0);
  const rank = (f: string) => (opts.first?.includes(f) ? opts.first.indexOf(f) - opts.first.length : 0);
  const order = [...families].sort((a, b) => rank(a) - rank(b) || supply(a) - supply(b) || a.localeCompare(b));
  for (let attempt = 0; attempt < ASSEMBLY_ATTEMPTS; attempt++) {
    const rng = new Rng(seed + attempt * 104_729);
    const placed = fillOnce(kept, quotas, order, rng);
    if (!placed) continue;
    for (const f of families) report.assigned[f] = Object.fromEntries(SPLITS.map(sp => [sp, placed.filter(c => c.family === f && c.split === sp).length])) as Record<Split, number>;
    report.components = groupSizes(placed).length;
    report.unused_candidates = kept.length - placed.length;
    report.assembly_attempt = attempt;
    if (opts.notes?.length) report.notes = [...opts.notes];
    const tasks: MethodTask[] = [];
    for (const split of SPLITS) {
      rng.shuffle(placed.filter(c => c.split === split)).forEach((c, i) => {
        const { split: _, ...rest } = c;
        tasks.push({ task_id: `${skill}-${split}-${String(i + 1).padStart(2, '0')}`, skill, split, ...rest, judge: compileJudge(skill, c.gold) });
      });
    }
    return { tasks, report };
  }
  throw new Error(`${skill}: no seeded attempt filled the quotas ${JSON.stringify(quotas)} from ${JSON.stringify(Object.fromEntries(families.map(f => [f, kept.filter(k => k.candidate.family === f).length])))} confirmed candidates`);
}
