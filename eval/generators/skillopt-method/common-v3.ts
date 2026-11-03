/**
 * Shared parts of the skillopt-method-v3 task generators (GBEV-30, plan
 * section 2): the world, the oracles, screening and assembly.
 *
 * The world (world-v3.ts) is the generators' first path to gold: they read its
 * model (people, orgs, contract chains, mentions). The oracles here are the
 * second path: they re-derive each gold value from the rendered page text
 * alone (the contract pages' dates and tables, a company page's founding line
 * and leadership list, a person page's career list), and a candidate whose
 * two paths disagree is dropped.
 *
 * Screening then runs two keyless controls per candidate: the solvability
 * control (an answer built from the deciding page's wording, in the contract's
 * shape) must pass every check, and every degenerate answer (empty, "I don't
 * know", every candidate value at once, a refusal where an answer exists) must
 * fail substance.
 *
 * Assembly keeps v2's rules over four splits (train, sel, gate, test): one
 * anchor per task, every gold fact and gold page in one split, at most three
 * tasks per connected group, and held-out families only in gate and test. A
 * family whose tasks have more than one gold status (a fact-check family that
 * makes claims right or wrong) fills each split's quota by status, in the
 * proportion of its confirmed candidates; a false claim with a true part counts
 * apart from one false throughout. Train and selection give neither an
 * every-claim-FALSE nor an every-claim-VERIFIED report a larger share of
 * passes than gate (statusSkewV3). Each task records its group id for
 * resampling. Train is ordered round-robin by
 * family, so gbrain's batches of 8 each cover every trained family. A family
 * that cannot fill its quota fails generation with the capacity report.
 */
import type { MethodTask } from './common.ts';
import { possessive } from './common.ts';
import {
  ATTRS, DEFAULT_V3_KNOBS, generateWorldV3, longDate, type AttrId, type AttrValue, type V3Knobs, type WorldV3,
} from './world-v3.ts';
import { Rng } from '../seeded.ts';
import { compileJudgeV3, SPLITS_V3, type GoldV3, type SplitV3 } from '../../runner/skillopt-method/score-v3.ts';
import { evaluateLayers, type GoldValue, type SkillName } from '../../runner/skillopt-method/score.ts';

export { SPLITS_V3, type SplitV3 };
export const SPLIT_SIZES_V3: Readonly<Record<SplitV3, number>> = { train: 24, sel: 24, gate: 36, test: 96 };
export const MAX_TASKS_PER_GROUP_V3 = 3;
export const ASSEMBLY_ATTEMPTS_V3 = 400;

export interface MethodTaskV3 extends Omit<MethodTask, 'split' | 'gold'> {
  split: SplitV3;
  gold: GoldV3;
  /** The connected group of tasks (shared anchor, gold fact or gold page) this task belongs to, for resampling. */
  group_id: string;
  /** The family is held out: it appears only in gate and test. */
  held_out: boolean;
  /** Abstention tasks: the pages a careless answer reaches instead (look-alikes and the closest wrong entities). */
  near_miss?: string[];
}

export type CandidateV3 = Omit<MethodTaskV3, 'task_id' | 'skill' | 'split' | 'judge' | 'group_id' | 'held_out'>;
export type DraftV3 = { ok: true; candidate: CandidateV3; priority?: number } | { ok: false; family: string; anchor: string; reason: string };
/** Per family: [train, sel, gate, test]. Held-out families have zero train and selection. */
export type QuotasV3 = Readonly<Record<string, readonly [number, number, number, number]>>;

export interface CapacityRow { family: string; held_out: boolean; candidates: number; confirmed: number; quota: Record<SplitV3, number>; placed: Record<SplitV3, number>; short: number }
export interface GenerationReportV3 {
  skill: SkillName;
  seed: number;
  knobs: V3Knobs;
  candidates: Record<string, number>;
  dropped_by_oracle: number;
  dropped_by_solvability: number;
  dropped_by_degenerate: number;
  dropped: Array<{ family: string; anchor: string; reason: string }>;
  capacity: CapacityRow[];
  groups: number;
  largest_group: number;
  unused_candidates: number;
  assembly_attempt: number;
  notes?: string[];
}
export interface SkillGenerationV3 { tasks: MethodTaskV3[]; report: GenerationReportV3 }

// ─── World ───────────────────────────────────────────────────────────────────

export interface WorldCorpus { world: WorldV3; pages: Map<string, string>; allText: string }
let cache: { key: string; corpus: WorldCorpus } | null = null;

/** The world for `knobs`, generated once per process and knob set. */
export function loadWorldV3(knobs: V3Knobs = DEFAULT_V3_KNOBS): WorldCorpus {
  const key = JSON.stringify(knobs);
  if (cache?.key === key) return cache.corpus;
  const world = generateWorldV3(knobs);
  const corpus = { world, pages: world.pages, allText: [...world.pages.values()].join('\n').toLowerCase() };
  cache = { key, corpus };
  return corpus;
}

export const goldOf = (attr: AttrId, v: AttrValue): GoldValue =>
  attr === 'seats' ? { kind: 'number', value: Number(v) }
    : attr === 'price' ? { kind: 'number', value: Number(v), unit: 'money' }
      : attr === 'discount' ? { kind: 'number', value: Number(v), unit: 'percent' }
        : attr === 'notice' || attr === 'payment' ? { kind: 'number', value: Number(v), unit: 'days' }
          : attr === 'renewal_date' ? { kind: 'date', value: String(v) }
            : { kind: 'name', value: String(v) };
export const nameValue = (value: string): GoldValue => ({ kind: 'name', value });
export const uniqueValues = (vs: readonly GoldValue[], not: readonly GoldValue[] = []) => {
  const seen = new Set(not.map(v => JSON.stringify(v)));
  return vs.filter(v => { const k = JSON.stringify(v); return !seen.has(k) && !!seen.add(k); });
};

// ─── Oracles: the second path, from page text only ──────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "March 31, 2026" → 2026-03-31; "March 2026" → 2026-03-01 (or the month's last day with `end`). */
export function parseLongDate(s: string, end = false): string | null {
  const full = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(s.trim());
  if (full) { const m = MONTHS.indexOf(full[1]!); return m < 0 ? null : new Date(Date.UTC(Number(full[3]), m, Number(full[2]))).toISOString().slice(0, 10); }
  const month = /^([A-Z][a-z]+) (\d{4})$/.exec(s.trim());
  if (!month) return null;
  const m = MONTHS.indexOf(month[1]!);
  if (m < 0) return null;
  return new Date(Date.UTC(Number(month[2]), end ? m + 1 : m, end ? 0 : 1)).toISOString().slice(0, 10);
}

const LABEL_TO_ATTR = new Map(Object.entries(ATTRS).map(([k, a]) => [a.label, k as AttrId]));
function parseCell(attr: AttrId, cell: string): AttrValue | null {
  const c = cell.trim();
  if (attr === 'price') return /^USD ([\d,]+)$/.test(c) ? Number(c.slice(4).replace(/,/g, '')) : null;
  if (attr === 'discount') return /^\d+%$/.test(c) ? Number(c.slice(0, -1)) : null;
  if (attr === 'notice') return /^\d+ days$/.test(c) ? Number(c.split(' ')[0]) : null;
  if (attr === 'payment') return /^net \d+$/.test(c) ? Number(c.split(' ')[1]) : null;
  if (attr === 'seats') return /^\d+$/.test(c) ? Number(c) : null;
  if (attr === 'renewal_date') return parseLongDate(c);
  return /^Tier \d$/.test(c) ? c : null;
}

export interface ContractText { slug: string; title: string; signed: string; effective: string; sets: Partial<Record<AttrId, AttrValue>>; rescinds: string | null }

/** A contract page read from its text: dates, the values it sets from its effective date, and the record it rescinds. */
export function readContract(pages: ReadonlyMap<string, string>, slug: string): ContractText | null {
  const text = pages.get(slug);
  if (!text) return null;
  const title = /^# (.+)$/m.exec(text)?.[1] ?? '';
  const signed = parseLongDate(/^Signed: (.+)\.$/m.exec(text)?.[1] ?? '');
  const effective = parseLongDate(/^Effective: (.+)\.$/m.exec(text)?.[1] ?? '');
  if (!signed || !effective) return null;
  const sets: Partial<Record<AttrId, AttrValue>> = {};
  for (const row of text.matchAll(/^\| ([^|]+?) \|(?: [^|]+? \|)? ([^|]+?) \|$/gm)) {
    const attr = LABEL_TO_ATTR.get(row[1]!);
    if (!attr) continue;
    const v = parseCell(attr, row[2]!);
    if (v !== null) sets[attr] = v;
  }
  const rescinds = /rescinds \[[^\]]+\]\((contracts\/[a-z0-9-]+)\) in full/.exec(text)?.[1] ?? null;
  return { slug, title, signed, effective, sets, rescinds };
}

/** The contract pages an account page lists under "Contract history". */
export function accountContracts(pages: ReadonlyMap<string, string>, account: string): string[] {
  const text = pages.get(account) ?? '';
  const section = /## Contract history\n\n([\s\S]*?)(?:\n\n|$)/.exec(text)?.[1] ?? '';
  return [...section.matchAll(/\]\((contracts\/[a-z0-9-]+)\)/g)].map(m => m[1]!);
}

export interface ValueFromText { value: AttrValue; slug: string; rescission: string | null; evidence: string }

/**
 * Oracle for an account's value of `attr` on `date`, from the contract pages
 * alone: of the records in force on that date (effective on or before it),
 * drop any a rescission in force has rescinded, then take the latest by
 * effective date (then signing date) that sets the attribute. When a rescission
 * removed a later record that set it, that rescission also decides.
 */
export function valueFromText(pages: ReadonlyMap<string, string>, account: string, attr: AttrId, date: string): ValueFromText | null {
  const records = accountContracts(pages, account).map(s => readContract(pages, s)).filter((c): c is ContractText => !!c);
  const inForce = records.filter(c => c.effective <= date);
  const rescinded = new Map(inForce.filter(c => c.rescinds).map(c => [c.rescinds!, c.slug]));
  const setting = inForce.filter(c => !rescinded.has(c.slug) && attr in c.sets).sort((a, b) => a.effective.localeCompare(b.effective) || a.signed.localeCompare(b.signed));
  const best = setting.at(-1);
  if (!best) return null;
  const removed = inForce.filter(c => rescinded.has(c.slug) && attr in c.sets && c.effective >= best.effective).map(c => rescinded.get(c.slug)!);
  const label = ATTRS[attr].label;
  const row = pages.get(best.slug)!.split('\n').find(l => l.startsWith(`| ${label} |`)) ?? '';
  return { value: best.sets[attr]!, slug: best.slug, rescission: removed.at(-1) ?? null, evidence: `${best.title}, effective ${longDate(best.effective)}: ${row}` };
}

const escapeRe = (s: string) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
const linkRe = (slugPrefix: string) => `\\[([^\\]]+)\\]\\((${slugPrefix}\\/[a-z0-9-]+)\\)`;

/** Oracle for a company's founder: its page's founding line names the founder, and the founder's page says they founded it. */
export function founderFromText(pages: ReadonlyMap<string, string>, company: string): { name: string; slug: string; evidence: string } | { reason: string } {
  const text = pages.get(company);
  if (!text) return { reason: `no page ${company}` };
  const title = /^# (.+)$/m.exec(text)?.[1] ?? '';
  const m = new RegExp(`It was founded in (\\d{4}) by ${linkRe('people')}\\.`).exec(text);
  if (!m) return { reason: `${company} has no founding line` };
  const founderPage = pages.get(m[3]!) ?? '';
  const line = founderPage.split('\n').find(l => new RegExp(`founded \\[${escapeRe(title)}\\]\\(${escapeRe(company)}\\)`).test(l));
  if (!line) return { reason: `the founder's page ${m[3]} does not say they founded ${title}` };
  return { name: m[2]!, slug: m[3]!, evidence: `${company}: "${m[0]}" ${m[3]}: "${line.trim()}"` };
}

export interface StintText { org: string; orgName: string; title: string; start: string; end: string | null; line: string }

/** A person's career as their page lists it, newest first. */
export function careerFromText(pages: ReadonlyMap<string, string>, person: string): StintText[] {
  const text = pages.get(person) ?? '';
  const section = /## Career\n\n([\s\S]*?)(?:\n\n|$)/.exec(text)?.[1] ?? '';
  const out: StintText[] = [];
  for (const line of section.split('\n')) {
    const m = new RegExp(`^- (?:Since ([A-Z][a-z]+ \\d{4})|([A-Z][a-z]+ \\d{4}) to ([A-Z][a-z]+ \\d{4})): (.+), ${linkRe('(?:companies|accounts)')}$`).exec(line);
    if (!m) continue;
    out.push({ start: parseLongDate(m[1] ?? m[2]!)!, end: m[3] ? parseLongDate(m[3], true) : null, title: m[4]!, orgName: m[5]!, org: m[6]!, line });
  }
  return out;
}

/**
 * Oracle for where a person works on `date`: the stint their career list
 * gives for that date, confirmed by the organization's page naming the person
 * in a team, leadership or contacts line (or its founding line).
 */
export function stintFromText(pages: ReadonlyMap<string, string>, person: string, date: string): StintText | { reason: string } {
  const covering = careerFromText(pages, person).filter(s => s.start <= date && (s.end === null || date <= s.end));
  if (covering.length !== 1) return { reason: `${covering.length} career entries on ${person}'s page cover ${date}` };
  const s = covering[0]!;
  const orgText = pages.get(s.org) ?? '';
  if (!orgText.includes(`](${person})`)) return { reason: `${s.org} does not name ${person}` };
  return s;
}

/** Oracle for who held a leadership role on `date`: the company page's leadership line, confirmed by that person's career list. */
export function roleHolderFromText(pages: ReadonlyMap<string, string>, company: string, label: 'Chief executive' | 'Chief technology officer', date: string): { name: string; slug: string; evidence: string } | { reason: string } {
  const text = pages.get(company) ?? '';
  const line = text.split('\n').find(l => l.startsWith(`- ${label}: `));
  if (!line) return { reason: `${company} lists no ${label.toLowerCase()}` };
  const tenures = [...line.matchAll(new RegExp(`${linkRe('people')} \\((?:since ([A-Z][a-z]+ \\d{4})|([A-Z][a-z]+ \\d{4}) to ([A-Z][a-z]+ \\d{4}))\\)`, 'g'))]
    .map(m => ({ name: m[1]!, slug: m[2]!, start: parseLongDate(m[3] ?? m[4]!)!, end: m[5] ? parseLongDate(m[5], true) : null }));
  const t = tenures.filter(x => x.start <= date && (x.end === null || date <= x.end));
  if (t.length !== 1) return { reason: `${t.length} ${label.toLowerCase()} tenures on ${company}'s page cover ${date}` };
  const career = careerFromText(pages, t[0]!.slug).find(s => s.org === company && s.start <= date && (s.end === null || date <= s.end));
  const role = label === 'Chief executive' ? /chief executive/ : /chief technology officer/;
  if (!career || !role.test(career.title)) return { reason: `${t[0]!.slug}'s career list does not hold the role on ${date}` };
  return { name: t[0]!.name, slug: t[0]!.slug, evidence: `${company}: "${line.trim()}" ${t[0]!.slug}: "${career.line}"` };
}

/** Oracle for a company's acquirer: its ownership line, confirmed by the acquirer's page. */
export function acquirerFromText(pages: ReadonlyMap<string, string>, company: string): { name: string; slug: string; evidence: string } | { reason: string } {
  const text = pages.get(company) ?? '';
  const title = /^# (.+)$/m.exec(text)?.[1] ?? '';
  const m = new RegExp(`was acquired by ${linkRe('companies')}`).exec(text);
  if (!m) return { reason: `${company} has no acquirer` };
  if (!new RegExp(`acquired \\[${escapeRe(title)}\\]\\(${escapeRe(company)}\\)`).test(pages.get(m[2]!) ?? '')) return { reason: `${m[2]} does not say it acquired ${title}` };
  return { name: m[1]!, slug: m[2]!, evidence: `${company}: "${m[0]}"` };
}

/** Oracle for a company's only investor: its investors list holds one firm, whose portfolio lists the company. */
export function soleInvestorFromText(pages: ReadonlyMap<string, string>, company: string): { name: string; slug: string; evidence: string } | { reason: string } {
  const text = pages.get(company) ?? '';
  const section = /## Investors\n\n([\s\S]*?)(?:\n\n|$)/.exec(text)?.[1] ?? '';
  const firms = [...section.matchAll(new RegExp(linkRe('companies'), 'g'))];
  if (firms.length !== 1) return { reason: `${company} lists ${firms.length} investors` };
  const firm = firms[0]!;
  if (!(pages.get(firm[2]!) ?? '').includes(`](${company})`)) return { reason: `${firm[2]} does not list ${company}` };
  return { name: firm[1]!, slug: firm[2]!, evidence: `${company}: "${section.trim()}"` };
}

/** True when `phrase` occurs as a whole word sequence on no page. */
export function absentFromWorld(corpus: WorldCorpus, phrase: string): boolean {
  return !new RegExp(`(?<![a-z0-9])${escapeRe(phrase.toLowerCase()).replace(/\\s+/g, '\\s+')}(?![a-z0-9])`).test(corpus.allText);
}

// ─── Degenerate answers ──────────────────────────────────────────────────────

const show = (v: GoldValue) => (v.kind === 'number' ? (v.unit === 'percent' ? `${v.value}%` : v.unit === 'days' ? `${v.value} days` : v.unit === 'money' ? `$${v.value.toLocaleString('en-US')}` : String(v.value)) : v.kind === 'date' ? longDate(v.value) : v.value);

/** Answers no system should pass on substance: empty, "I don't know", every candidate value and page at once, a refusal where an answer exists, and a fact-check that calls every claim true, or every claim or part false when one is true. */
export function degenerateAnswers(skill: SkillName, c: Pick<CandidateV3, 'gold' | 'distractors' | 'answerable'>): Array<{ kind: string; text: string }> {
  const spec = c.gold.spec;
  const slugs = [...new Set([...c.gold.slugs, ...c.distractors.slugs])];
  const values: GoldValue[] = spec.kind === 'value' ? [...spec.distractors, spec.answer] : spec.kind === 'ambiguous' ? spec.candidates : spec.kind === 'absent' ? spec.distractors : spec.kind === 'briefing' ? spec.meetings.flatMap(m => [...m.distractors, ...(m.answer ? [m.answer] : [])]) : spec.parts.flatMap(p => (p.correct ? [p.correct] : []));
  const cites = slugs.map(s => `[Source: ${s}]`).join(' ');
  const out: Array<{ kind: string; text: string }> = [{ kind: 'empty', text: '' }, { kind: 'dont-know', text: "I don't know." }];
  if (spec.kind === 'briefing') {
    out.push({ kind: 'everything', text: spec.meetings.map(m => `- ${m.time} ${m.title}\n  ${[...spec.meetings.flatMap(x => [...x.distractors, ...(x.answer ? [x.answer] : [])])].map(show).join(', ')} ${cites}`).join('\n') });
    out.push({ kind: 'refuse', text: spec.meetings.map(m => `- ${m.time} ${m.title}\n  No brain page for ${m.subject}.`).join('\n') });
  } else if (spec.kind === 'fact-check') {
    out.push({ kind: 'everything', text: ['VERIFIED', 'FALSE', 'UNVERIFIED'].map((s, i) => `[${i + 1}] CLAIM: the claim\nSTATUS: ${s}\nSOURCE: ${slugs.join(', ')}\nNOTES: ${values.map(show).join(', ')}`).join('\n\n') });
    if (spec.status !== 'not-supported') out.push({ kind: 'refuse', text: '[1] CLAIM: the claim\nSTATUS: 🤷 UNVERIFIED\nSOURCE: none\nNOTES: The brain has no record of this.' });
    if (spec.status !== 'supported') out.push({ kind: 'always-positive', text: '[1] CLAIM: the claim\nSTATUS: ✅ VERIFIED\nSOURCE: ' + slugs.join(', ') });
    if (spec.parts.some(p => p.status === 'supported')) {
      const claims = spec.parts.length > 1 ? spec.parts.map(p => `the claim's ${p.key}`) : ['the claim'];
      out.push({ kind: 'always-negative', text: claims.map((claim, i) => `[${i + 1}] CLAIM: ${claim}\nSTATUS: ❌ FALSE\nSOURCE: ${slugs.join(', ')}\nNOTES: ${values.map(show).join(', ')}`).join('\n\n') });
    }
  } else {
    if (spec.kind !== 'value' || spec.distractors.length) out.push({ kind: 'everything', text: `Answer: ${values.map(show).join(', ')} ${cites}` });
    if (c.answerable) out.push({ kind: 'refuse', text: "The brain doesn't have information on that." });
  }
  return out;
}

/**
 * GST-1150: for each split of a fact-check task set, the share of tasks whose
 * oracle report still passes substance with every STATUS: line set to FALSE
 * (all-false) or to VERIFIED (all-true). A problem when train or selection
 * gives either report a larger share than gate, since a skill that leans one
 * way would then score better where it is trained and selected than where it
 * is gated.
 */
export function statusSkewV3(tasks: readonly MethodTaskV3[]): { shares: Record<'all-false' | 'all-true', Partial<Record<SplitV3, number>>>; problems: string[] } {
  for (const t of tasks) if (!/^STATUS: /m.test(t.oracle_answer)) throw new Error(`statusSkewV3: ${t.task_id}'s oracle report has no STATUS: line to replace`);
  const shares: Record<'all-false' | 'all-true', Partial<Record<SplitV3, number>>> = { 'all-false': {}, 'all-true': {} };
  for (const split of SPLITS_V3) {
    const inSplit = tasks.filter(t => t.split === split);
    if (!inSplit.length) continue;
    for (const [report, label] of [['all-false', '❌ FALSE'], ['all-true', '✅ VERIFIED']] as const) {
      shares[report][split] = inSplit.filter(t => evaluateLayers(t.oracle_answer.replace(/^STATUS: .*$/gm, `STATUS: ${label}`), t.judge).substance).length / inSplit.length;
    }
  }
  const problems = (['all-false', 'all-true'] as const).flatMap(report => (['train', 'sel'] as const).flatMap(split => {
    const s = shares[report][split], gate = shares[report].gate;
    return s !== undefined && gate !== undefined && s > gate ? [`${report} oracle reports pass substance on ${(100 * s).toFixed(1)}% of ${split}, more than gate's ${(100 * gate).toFixed(1)}%`] : [];
  }));
  return { shares, problems };
}

// ─── Screening and assembly ──────────────────────────────────────────────────

const taskKeys = (t: Pick<CandidateV3, 'anchor' | 'fact_keys' | 'gold'>) => [...new Set([`anchor:${t.anchor.id}`, ...t.fact_keys, ...t.gold.slugs.map(x => `page:${x}`)])];

/** Every anchor, fact key and gold page in more than one split, and duplicate task ids. */
export function splitLeaksV3(tasks: readonly MethodTaskV3[]): string[] {
  const seen = new Map<string, SplitV3>();
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.task_id)) problems.push(`duplicate task id ${t.task_id}`);
    ids.add(t.task_id);
    for (const k of taskKeys(t)) {
      const at = seen.get(k);
      if (at && at !== t.split) problems.push(`${k} is in ${at} and ${t.split}`);
      seen.set(k, t.split);
    }
  }
  return problems;
}

/** Connected groups over shared keys: each task's group index, numbered by first appearance. */
export function groupIndex(tasks: ReadonlyArray<Pick<CandidateV3, 'anchor' | 'fact_keys' | 'gold'>>): number[] {
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
  const numbers = new Map<number, number>();
  return tasks.map((_, i) => { const r = find(i); if (!numbers.has(r)) numbers.set(r, numbers.size); return numbers.get(r)!; });
}

interface Kept { candidate: CandidateV3; priority: number }

function screenV3(skill: SkillName, drafts: readonly DraftV3[], report: GenerationReportV3): Kept[] {
  const kept: Kept[] = [];
  for (const d of drafts) {
    const family = d.ok ? d.candidate.family : d.family;
    report.candidates[family] = (report.candidates[family] ?? 0) + 1;
    if (!d.ok) { report.dropped_by_oracle++; report.dropped.push({ family, anchor: d.anchor, reason: d.reason }); continue; }
    const judge = compileJudgeV3(skill, d.candidate.gold);
    if (!evaluateLayers(d.candidate.oracle_answer, judge).full) {
      report.dropped_by_solvability++;
      report.dropped.push({ family, anchor: d.candidate.anchor.id, reason: 'solvability control failed: the answer built from the deciding page does not pass every check' });
      continue;
    }
    const passing = degenerateAnswers(skill, d.candidate).filter(a => evaluateLayers(a.text, judge).substance);
    if (passing.length) {
      report.dropped_by_degenerate++;
      report.dropped.push({ family, anchor: d.candidate.anchor.id, reason: `degenerate answer passes substance: ${passing.map(a => a.kind).join(', ')}` });
      continue;
    }
    kept.push({ candidate: d.candidate, priority: d.priority ?? 0 });
  }
  return kept;
}

/** One seeded attempt (v2's fillOnce over four splits), filling the quota of each stratum (`stratum` names a candidate's). */
function fillOnceV3(kept: readonly Kept[], quotas: QuotasV3, order: readonly string[], rng: Rng, stratum: (c: CandidateV3) => string): Array<CandidateV3 & { split: SplitV3 }> {
  const assigned = Object.fromEntries(Object.keys(quotas).map(f => [f, { train: 0, sel: 0, gate: 0, test: 0 }])) as Record<string, Record<SplitV3, number>>;
  const quota = (f: string, sp: SplitV3) => quotas[f]![SPLITS_V3.indexOf(sp)]!;
  const need = (f: string, sp: SplitV3) => quota(f, sp) - assigned[f]![sp];
  const groups: Array<{ split: SplitV3; size: number; keys: string[] }> = [];
  const groupOf = new Map<string, number>();
  const anchors = new Set<string>();
  const placed: Array<CandidateV3 & { split: SplitV3 }> = [];
  const splitOrder = rng.shuffle(SPLITS_V3);
  const queue = order.flatMap(f => rng.shuffle(kept.filter(k => stratum(k.candidate) === f)).sort((a, b) => b.priority - a.priority));
  for (const { candidate: c } of queue) {
    if (anchors.has(c.anchor.id)) continue;
    const s = stratum(c);
    const keys = taskKeys(c);
    const touched = [...new Set(keys.map(k => groupOf.get(k)).filter((g): g is number => g !== undefined))];
    let split: SplitV3 | undefined;
    if (touched.length) {
      if (new Set(touched.map(g => groups[g]!.split)).size > 1) continue;
      split = groups[touched[0]!]!.split;
      if (touched.reduce((n, g) => n + groups[g]!.size, 0) + 1 > MAX_TASKS_PER_GROUP_V3 || need(s, split) <= 0) continue;
    } else {
      split = splitOrder.filter(sp => need(s, sp) > 0).sort((a, b) => need(s, b) / quota(s, b) - need(s, a) / quota(s, a))[0];
      if (!split) continue;
    }
    const merged = { split, size: touched.reduce((n, g) => n + groups[g]!.size, 0) + 1, keys: [...keys, ...touched.flatMap(g => groups[g]!.keys)] };
    groups.push(merged);
    for (const k of merged.keys) groupOf.set(k, groups.length - 1);
    anchors.add(c.anchor.id);
    assigned[s]![split]++;
    placed.push({ ...c, split });
  }
  return placed;
}

const shortfall = (placed: ReadonlyArray<CandidateV3 & { split: SplitV3 }>, quotas: QuotasV3, stratum: (c: CandidateV3) => string) =>
  Object.entries(quotas).reduce((n, [f, q]) => n + SPLITS_V3.reduce((m, sp, i) => m + Math.max(0, q[i]! - placed.filter(c => stratum(c) === f && c.split === sp).length), 0), 0);

/**
 * Each family's quotas split by gold status in proportion to its confirmed
 * candidates (largest remainder per split), so a family the generator makes
 * right or wrong places true and false claims in the generator's mix. A false
 * claim with a true part is its own stratum, so a compound claim's mix of
 * reports that fail when every part is called FALSE holds in every split. A
 * family with one status keeps its own name and quotas.
 */
function statusStrata(kept: ReadonlyArray<{ candidate: Pick<CandidateV3, 'family' | 'gold'> }>, quotas: QuotasV3): { quotas: QuotasV3; stratum: (c: Pick<CandidateV3, 'family' | 'gold'>) => string } {
  const key = (g: GoldV3) => (g.status ?? '') + (g.status === 'contradicted' && g.spec.kind === 'fact-check' && g.spec.parts.some(p => p.status === 'supported') ? '+supported-part' : '');
  const statuses = new Map<string, string[]>();
  for (const f of Object.keys(quotas)) statuses.set(f, [...new Set(kept.filter(k => k.candidate.family === f).map(k => key(k.candidate.gold)))].sort());
  const stratum = (c: Pick<CandidateV3, 'family' | 'gold'>) => (statuses.get(c.family)!.length > 1 ? `${c.family}|${key(c.gold)}` : c.family);
  const out: Record<string, [number, number, number, number]> = {};
  for (const [f, q] of Object.entries(quotas)) {
    const ss = statuses.get(f)!;
    if (ss.length <= 1) { out[f] = [...q] as [number, number, number, number]; continue; }
    const counts = ss.map(s => kept.filter(k => k.candidate.family === f && key(k.candidate.gold) === s).length);
    const total = counts.reduce((a, b) => a + b, 0);
    for (const s of ss) out[`${f}|${s}`] = [0, 0, 0, 0];
    q.forEach((n, i) => {
      const exact = counts.map(c => (n * c) / total);
      const base = exact.map(Math.floor);
      const byRemainder = ss.map((_, j) => j).sort((a, b) => exact[b]! - base[b]! - (exact[a]! - base[a]!) || a - b);
      for (let r = n - base.reduce((a, b) => a + b, 0), k = 0; r > 0; r--, k++) base[byRemainder[k]!]!++;
      ss.forEach((s, j) => { out[`${f}|${s}`]![i] = base[j]!; });
    });
  }
  return { quotas: out, stratum };
}

/** Train in round-robin family order (families in quota order), so every batch of 8 holds every trained family. */
export function roundRobin<T extends { family: string }>(tasks: readonly T[], families: readonly string[]): T[] {
  const queues = families.map(f => tasks.filter(t => t.family === f));
  const out: T[] = [];
  while (queues.some(q => q.length)) for (const q of queues) { const t = q.shift(); if (t) out.push(t); }
  return out;
}

/**
 * Screen the drafts, then fill every split by family quota, retrying seeded
 * attempts until one fills every quota exactly. Throws with the capacity
 * report of the best attempt when none does.
 */
export function assembleV3(skill: SkillName, seed: number, knobs: V3Knobs, drafts: readonly DraftV3[], quotas: QuotasV3, opts: { heldOut: readonly string[]; notes?: readonly string[] }): SkillGenerationV3 {
  const report: GenerationReportV3 = { skill, seed, knobs, candidates: {}, dropped_by_oracle: 0, dropped_by_solvability: 0, dropped_by_degenerate: 0, dropped: [], capacity: [], groups: 0, largest_group: 0, unused_candidates: 0, assembly_attempt: -1 };
  for (const f of opts.heldOut) if (quotas[f]![0] || quotas[f]![1]) throw new Error(`${skill}: held-out family ${f} has train or selection quota`);
  const kept = screenV3(skill, drafts, report);
  const families = Object.keys(quotas);
  const stray = kept.find(k => !families.includes(k.candidate.family));
  if (stray) throw new Error(`${skill}: family ${stray.candidate.family} has no quota`);
  const strata = statusStrata(kept, quotas);
  const total = (f: string) => strata.quotas[f]!.reduce((a, b) => a + b, 0);
  const supply = (f: string) => kept.filter(k => strata.stratum(k.candidate) === f).length / total(f);
  const order = Object.keys(strata.quotas).sort((a, b) => supply(a) - supply(b) || a.localeCompare(b));
  let best: Array<CandidateV3 & { split: SplitV3 }> = [];
  let attempt = 0;
  for (; attempt < ASSEMBLY_ATTEMPTS_V3; attempt++) {
    const placed = fillOnceV3(kept, strata.quotas, order, new Rng(seed + attempt * 104_729), strata.stratum);
    if (!best.length || shortfall(placed, strata.quotas, strata.stratum) < shortfall(best, strata.quotas, strata.stratum)) best = placed;
    if (shortfall(placed, strata.quotas, strata.stratum) === 0) break;
  }
  report.capacity = families.map(f => {
    const quota = Object.fromEntries(SPLITS_V3.map((sp, i) => [sp, quotas[f]![i]!])) as Record<SplitV3, number>;
    const placed = Object.fromEntries(SPLITS_V3.map(sp => [sp, best.filter(c => c.family === f && c.split === sp).length])) as Record<SplitV3, number>;
    return { family: f, held_out: opts.heldOut.includes(f), candidates: report.candidates[f] ?? 0, confirmed: kept.filter(k => k.candidate.family === f).length, quota, placed, short: SPLITS_V3.reduce((n, sp) => n + Math.max(0, quota[sp] - placed[sp]), 0) };
  });
  if (opts.notes?.length) report.notes = [...opts.notes];
  if (shortfall(best, strata.quotas, strata.stratum) > 0) {
    const rows = Object.entries(strata.quotas).filter(([s, q]) => SPLITS_V3.some((sp, i) => best.filter(c => strata.stratum(c) === s && c.split === sp).length < q[i]!)).map(([s, q]) => `${s} placed ${SPLITS_V3.map((sp, i) => `${best.filter(c => strata.stratum(c) === s && c.split === sp).length}/${q[i]}`).join(' ')} from ${kept.filter(k => strata.stratum(k.candidate) === s).length} confirmed`);
    throw new Error(`${skill}: capacity short after ${ASSEMBLY_ATTEMPTS_V3} attempts: ${rows.join('; ')}`);
  }
  report.assembly_attempt = attempt;
  report.unused_candidates = kept.length - best.length;

  const rng = new Rng(seed + attempt * 104_729 + 1);
  const ordered: Array<CandidateV3 & { split: SplitV3; task_id: string }> = [];
  for (const split of SPLITS_V3) {
    const inSplit = best.filter(c => c.split === split);
    if (inSplit.length !== SPLIT_SIZES_V3[split]) throw new Error(`${skill}: ${split} has ${inSplit.length} tasks, want ${SPLIT_SIZES_V3[split]}`);
    const list = split === 'train' ? roundRobin(rng.shuffle(inSplit), families.filter(f => !opts.heldOut.includes(f))) : rng.shuffle(inSplit);
    list.forEach((c, i) => ordered.push({ ...c, task_id: `${skill}-${split}-${String(i + 1).padStart(2, '0')}` }));
  }
  const groupOfTask = groupIndex(ordered);
  const sizes = new Map<number, number>();
  for (const g of groupOfTask) sizes.set(g, (sizes.get(g) ?? 0) + 1);
  report.groups = sizes.size;
  report.largest_group = Math.max(...sizes.values());
  const tasks: MethodTaskV3[] = ordered.map((c, i) => {
    const { split, task_id, ...rest } = c;
    return { task_id, skill, split, ...rest, held_out: opts.heldOut.includes(c.family), group_id: `${skill}-g${String(groupOfTask[i]! + 1).padStart(3, '0')}`, judge: compileJudgeV3(skill, c.gold) };
  });
  return { tasks, report };
}

// ─── Text helpers ────────────────────────────────────────────────────────────

export { possessive };
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayName = (iso: string) => WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()]!;
