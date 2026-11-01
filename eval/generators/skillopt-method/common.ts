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
  anchor: { kind: 'page' | 'entity' | 'claim'; id: string };
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
export type Draft = { ok: true; candidate: Candidate } | { ok: false; family: string; anchor: string; reason: string };

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
export function assembleSkill(skill: SkillName, seed: number, drafts: readonly Draft[], quotas: Readonly<Record<string, readonly [number, number, number]>>): SkillGeneration {
  const rng = new Rng(seed);
  const report: GenerationReport = { skill, seed, candidates: {}, dropped_by_oracle: 0, dropped_by_solvability: 0, dropped: [], components: 0, assigned: {}, unused_candidates: 0 };
  const kept: Candidate[] = [];
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
    kept.push(d.candidate);
  }

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
