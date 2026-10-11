/**
 * Scoring for the facts-absorb quality gate (R2): match the facts gbrain's
 * background extractor stored to the planted claims of the facts-absorb
 * world (eval/generators/facts-absorb-gen.ts), without a model.
 *
 * A fact belongs to the page whose slug its `context` names (the facts-absorb
 * job writes the source page there). A fact matches a claim on its page when
 * it names the claim's entity (a person's first or full name, or a company,
 * in the text or the entity slug) and carries its value (the city, employer,
 * hobby, allergy, venue or vendor, or the amount in the text or the typed
 * claim value). Recommendations have no entity and match on the value.
 *
 * Amendments after the counted run (docs/benchmarks/2026-10-08-facts-extraction-model/PREREGISTRATION.md,
 * "Amendments"): (1) accents and singular forms match; (2) a claim an earlier page already stated counts as
 * recalled through that page's fact, since gbrain stores one copy; (3) the user's own reply about a
 * recommendation is not an attribution error. The counted receipt keeps the preregistered scores.
 *
 * Per-fact classes (precision's denominator excludes `unmatched`):
 *   supported  matches a claim on its page, names its page's aside, restates
 *              the assistant's general advice as the assistant's, reports a
 *              rejected suggestion as the assistant's or as declined, or
 *              records the meeting a pronoun claim opens with;
 *   wrong      states a retracted value as current, states a rejected
 *              suggestion as fact, gives the assistant's advice as the
 *              user's, or pairs a named entity with a world value that no
 *              claim on its page gives that entity;
 *   unmatched  names no claim value of the world (paraphrased chatter, or a
 *              claim the matcher cannot see; audited by hand in the report).
 */
import type { Claim, FactsAbsorbWorld } from '../../generators/facts-absorb-gen.ts';
import { ASSISTANT_NOISE_KEYS, CITIES, EMPLOYERS, MEETING_LEAD } from '../../generators/facts-absorb-gen.ts';
import { Rng } from '../../generators/seeded.ts';

export interface StoredFact {
  id: number;
  fact: string;
  entity_slug: string | null;
  attributed_to: string | null;
  context: string | null;
  claim_value: number | null;
  expired_at?: string | null;
}

const NEGATION = /\b(not|no longer|never|isn'?t|wasn'?t|instead of|rather than|incorrect(ly)?|mistaken(ly)?|misspoke|mixed up|mixing|correct(ed|ion|ing)|wrong|retract(ed)?|typo|had said|initially|originally|previously|earlier|declined?|turned down|refused|rejected|won'?t|would never|said no|ruled out)\b/i;
const ASSISTANT = /\bassistant\b/i;
/** The user presenting a recommendation as their own choice or advice (amendment 3). */
const USER_CHOICE = /\b(chose|chosen|choose|book(s|ed|ing)?|decided|selected|going with|went with|will use|uses|picked|recommend(s|ed)?|prefers?)\b/i;
/** A hedge that keeps a user fact about a recommendation a reply, not a choice: "will look into", "will think about the suggestion". */
const HEDGE = /\b(look(ing)? into|consider(ing)?|think(ing)? about|check|may|might|maybe|suggest(ion|ed)|recommendation|not yet decided)\b/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Lowercase without accents: models write "Setúbal" and "Évora" for the world's "Setubal" and "Evora". */
export const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Whole-word match on folded text; a plural value also matches its singular ("peanuts", "a peanut allergy"). */
const word = (text: string, w: string) => {
  const v = fold(w);
  const forms = v.endsWith('s') && !v.includes(' ') && v.length > 4 ? [v, v.slice(0, -1)] : [v];
  return forms.some(f => new RegExp(`(^|[^a-z0-9])${esc(f)}([^a-z0-9]|$)`).test(fold(text)));
};

/** Every amount written in the text: "$61,000", "$61k", "61 thousand", "1.2 million", "47". */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.toLowerCase().matchAll(/\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b|thousand\b|million\b|m\b)?/g)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const scale = m[2] === 'k' || m[2] === 'thousand' ? 1000 : m[2] === 'million' || m[2] === 'm' ? 1_000_000 : 1;
    out.push(Math.round(n * scale));
  }
  return out;
}

/** The token a value is matched on: an employer's distinctive first word, otherwise the whole value. */
export function valueToken(c: Pick<Claim, 'attr' | 'value'>): string {
  return c.attr === 'employer' ? c.value.split(' ')[0] : c.value;
}

export interface WorldIndex {
  names: Map<string, string[]>;
  /** Every string value token of the world with the attr it belongs to. */
  tokens: string[];
  amounts: Set<number>;
  byPage: Map<string, Claim[]>;
}

export function indexWorld(world: FactsAbsorbWorld): WorldIndex {
  const names = new Map<string, string[]>();
  for (const e of world.entities) {
    const parts = e.name.toLowerCase().split(' ');
    names.set(e.id, [...new Set([e.name.toLowerCase(), parts[0], e.id.split('/')[1].replace(/-example$/, '')])]);
  }
  const tokens = new Set<string>([...CITIES.map(c => c.toLowerCase()), ...EMPLOYERS.map(e => e.toLowerCase().split(' ')[0])]);
  const amounts = new Set<number>();
  for (const c of world.claims) {
    if (c.amount !== undefined) { amounts.add(c.amount); if (c.retracted_amount !== undefined) amounts.add(c.retracted_amount); continue; }
    tokens.add(valueToken(c));
  }
  for (const r of world.rejections) tokens.add(r.attr === 'employer' ? r.value.split(' ')[0] : r.value);
  const byPage = new Map<string, Claim[]>();
  for (const c of world.claims) byPage.set(c.page, [...(byPage.get(c.page) ?? []), c]);
  return { names, tokens: [...tokens], amounts, byPage };
}

export function factPage(f: StoredFact, pages: readonly string[]): string | null {
  const ctx = f.context ?? '';
  return pages.find(p => ctx === p || ctx.startsWith(`${p} `) || ctx.startsWith(`${p}\n`) || ctx.startsWith(`${p}(`) || ctx.startsWith(`${p};`)) ?? null;
}

function names(idx: WorldIndex, f: StoredFact, entity: string): boolean {
  const text = f.fact.toLowerCase();
  const slug = (f.entity_slug ?? '').toLowerCase();
  return (idx.names.get(entity) ?? []).some(n => word(text, n) || (slug !== '' && word(slug.replace(/[/-]/g, ' '), n)));
}

function carries(f: StoredFact, c: Pick<Claim, 'attr' | 'value' | 'amount'>): boolean {
  if (c.amount !== undefined) return f.claim_value === c.amount || amountsIn(f.fact).includes(c.amount);
  return word(f.fact.toLowerCase(), valueToken(c));
}

export function matches(idx: WorldIndex, f: StoredFact, c: Claim): boolean {
  return (c.entity === null || names(idx, f, c.entity)) && carries(f, c);
}

const byAssistant = (f: StoredFact) => f.attributed_to === 'assistant' || ASSISTANT.test(f.fact);

/** True when the fact restates a correction's retracted value as current. */
export function restatesRetracted(idx: WorldIndex, f: StoredFact, c: Claim): boolean {
  if (c.type !== 'self-fix' && c.type !== 'metric-fix') return false;
  if (!names(idx, f, c.entity!)) return false;
  const retracted = c.type === 'self-fix'
    ? word(f.fact.toLowerCase(), valueToken({ attr: c.attr, value: c.retracted! }))
    : amountsIn(f.fact).includes(c.retracted_amount!) || f.claim_value === c.retracted_amount;
  return retracted && !carries(f, c) && !NEGATION.test(f.fact);
}

export interface PageStats {
  page: string;
  claims: number;
  recalled: number;
  facts: number;
  supported: number;
  wrong: number;
  unmatched: number;
  attribution_cases: number;
  attribution_correct: number;
  correction_cases: number;
  correction_correct: number;
}

export interface ClaimResult { id: string; type: Claim['type']; page: string; recalled: boolean; fact_ids: number[]; attribution_ok?: boolean; correction_ok?: boolean }
export interface FactResult { id: number; page: string | null; class: 'supported' | 'wrong' | 'unmatched'; reason?: string; claims: string[] }

export interface ArmScore {
  pages: PageStats[];
  claims: ClaimResult[];
  rejections: Array<{ id: string; page: string; leaked_fact_ids: number[] }>;
  facts: FactResult[];
  user_claims_attributed_to_assistant: number;
  facts_without_page: number;
  totals: ReturnType<typeof totals>;
}

export function scoreArm(world: FactsAbsorbWorld, facts: readonly StoredFact[]): ArmScore {
  const idx = indexWorld(world);
  const pages = world.sessions.map(s => s.slug);
  const active = facts.filter(f => !f.expired_at);
  const onPage = new Map<string, StoredFact[]>();
  let withoutPage = 0;
  const factResults: FactResult[] = [];
  for (const f of active) {
    const p = factPage(f, pages);
    if (!p) { withoutPage++; factResults.push({ id: f.id, page: null, class: 'unmatched', reason: 'no source page in context', claims: [] }); continue; }
    onPage.set(p, [...(onPage.get(p) ?? []), f]);
  }
  const claimResults: ClaimResult[] = [];
  const rejections: ArmScore['rejections'] = [];
  const stats: PageStats[] = [];
  let userToAssistant = 0;
  for (const s of world.sessions) {
    const fs = onPage.get(s.slug) ?? [];
    const claims = idx.byPage.get(s.slug) ?? [];
    const rejs = world.rejections.filter(r => r.page === s.slug);
    const aside = world.asides.find(a => a.page === s.slug);
    const st: PageStats = { page: s.slug, claims: claims.length, recalled: 0, facts: fs.length, supported: 0, wrong: 0, unmatched: 0, attribution_cases: 0, attribution_correct: 0, correction_cases: 0, correction_correct: 0 };
    const leaks = new Map<string, number[]>();
    for (const r of rejs) {
      const leaked = fs.filter(f => names(idx, f, r.entity) && word(f.fact.toLowerCase(), r.attr === 'employer' ? r.value.split(' ')[0] : r.value) && !byAssistant(f) && !NEGATION.test(f.fact));
      leaks.set(r.id, leaked.map(f => f.id));
      rejections.push({ id: r.id, page: s.slug, leaked_fact_ids: leaked.map(f => f.id) });
      st.attribution_cases++;
      if (!leaked.length) st.attribution_correct++;
    }
    for (const c of claims) {
      let hit = fs.filter(f => matches(idx, f, c));
      // Amendment 2: gbrain keeps one copy of a repeated fact, so a claim an earlier page already stated
      // (same entity, attribute and value) is recalled when that page's facts carry it.
      if (!hit.length && (c.type === 'user' || c.type === 'assistant')) {
        const earlier = world.claims.filter(o => o.page < s.slug && o.entity === c.entity && o.attr === c.attr && o.value === c.value).map(o => o.page);
        hit = earlier.flatMap(p => (onPage.get(p) ?? []).filter(f => matches(idx, f, c)));
      }
      const r: ClaimResult = { id: c.id, type: c.type, page: s.slug, recalled: hit.length > 0, fact_ids: hit.map(f => f.id) };
      if (r.recalled) st.recalled++;
      if (c.type === 'user' && hit.length && hit.every(f => f.attributed_to === 'assistant')) userToAssistant++;
      if ((c.type === 'assistant' || c.type === 'third') && r.recalled) {
        // Amendment 3: a recommendation is attributed right when a fact gives it to the assistant and no fact presents
        // it as the user's own choice; the user's true reply ("User will look into Villa Serra") is not an error.
        r.attribution_ok = c.type === 'assistant'
          ? hit.some(byAssistant) && !hit.some(f => !byAssistant(f) && USER_CHOICE.test(f.fact) && !HEDGE.test(f.fact))
          : hit.every(f => word(f.fact.toLowerCase(), c.source!.toLowerCase()));
        st.attribution_cases++;
        if (r.attribution_ok) st.attribution_correct++;
      }
      if (c.type === 'self-fix' || c.type === 'metric-fix') {
        r.correction_ok = r.recalled && !fs.some(f => restatesRetracted(idx, f, c));
        st.correction_cases++;
        if (r.correction_ok) st.correction_correct++;
      }
      claimResults.push(r);
    }
    for (const f of fs) {
      const text = f.fact.toLowerCase();
      const hits = claims.filter(c => matches(idx, f, c)).map(c => c.id);
      const retracted = claims.find(c => restatesRetracted(idx, f, c));
      const leaked = [...leaks.entries()].find(([, ids]) => ids.includes(f.id));
      let cls: FactResult['class'];
      let reason: string | undefined;
      if (retracted) { cls = 'wrong'; reason = `restates the retracted value of ${retracted.id}`; }
      else if (leaked) { cls = 'wrong'; reason = `states rejected suggestion ${leaked[0]} as fact`; }
      else if (hits.length) cls = 'supported';
      else if (aside && word(text, aside.token)) cls = 'supported';
      else if (ASSISTANT_NOISE_KEYS.some(k => k.test(f.fact))) {
        if (byAssistant(f)) cls = 'supported';
        else { cls = 'wrong'; reason = 'gives the assistant\'s advice as the user\'s'; }
      }
      else if (MEETING_LEAD.test(f.fact) && world.entities.some(e => names(idx, f, e.id))) cls = 'supported';
      else if (rejs.some(r => names(idx, f, r.entity) && word(text, r.attr === 'employer' ? r.value.split(' ')[0] : r.value))) cls = 'supported';
      else {
        const named = world.entities.filter(e => names(idx, f, e.id)).map(e => e.id);
        const foreignToken = idx.tokens.find(t => word(text, t));
        const foreignAmount = [...amountsIn(f.fact), ...(f.claim_value !== null ? [f.claim_value] : [])].find(a => idx.amounts.has(a));
        if (named.length && (foreignToken || foreignAmount !== undefined)) { cls = 'wrong'; reason = `pairs ${named.join(',')} with ${foreignToken ?? foreignAmount}, which no claim on its page gives them`; }
        else cls = 'unmatched';
      }
      st[cls]++;
      factResults.push({ id: f.id, page: s.slug, class: cls, ...(reason ? { reason } : {}), claims: hits });
    }
    stats.push(st);
  }
  return { pages: stats, claims: claimResults, rejections, facts: factResults, user_claims_attributed_to_assistant: userToAssistant, facts_without_page: withoutPage, totals: totals(stats) };
}

const ratio = (n: number, d: number) => (d ? n / d : 0);

export function totals(pages: readonly PageStats[]) {
  const sum = (k: keyof Omit<PageStats, 'page'>) => pages.reduce((a, p) => a + p[k], 0);
  const t = { claims: sum('claims'), recalled: sum('recalled'), facts: sum('facts'), supported: sum('supported'), wrong: sum('wrong'), unmatched: sum('unmatched'), attribution_cases: sum('attribution_cases'), attribution_correct: sum('attribution_correct'), correction_cases: sum('correction_cases'), correction_correct: sum('correction_correct') };
  return {
    ...t,
    recall: ratio(t.recalled, t.claims),
    precision: ratio(t.supported, t.supported + t.wrong),
    attribution: ratio(t.attribution_correct, t.attribution_cases),
    correction: ratio(t.correction_correct, t.correction_cases),
    unmatched_rate: ratio(t.unmatched, t.facts),
  };
}

export type Metric = 'recall' | 'precision' | 'attribution' | 'correction';
export const METRICS: readonly Metric[] = ['recall', 'precision', 'attribution', 'correction'];

/** Paired difference candidate minus baseline, resampling pages with replacement; 95% percentile interval. */
export function pairedDiff(base: readonly PageStats[], cand: readonly PageStats[], metric: Metric, reps = 4000, seed = 2): { diff: number; lo: number; hi: number } {
  const byPage = new Map(cand.map(p => [p.page, p]));
  const pairs = base.map(b => [b, byPage.get(b.page)] as const).filter((x): x is readonly [PageStats, PageStats] => !!x[1]);
  const value = (ps: readonly PageStats[]) => totals(ps)[metric];
  const diff = value(pairs.map(p => p[1])) - value(pairs.map(p => p[0]));
  const rng = new Rng(seed);
  const ds: number[] = [];
  for (let r = 0; r < reps; r++) {
    const pick = pairs.map(() => pairs[rng.int(0, pairs.length - 1)]);
    ds.push(value(pick.map(p => p[1])) - value(pick.map(p => p[0])));
  }
  ds.sort((a, b) => a - b);
  return { diff, lo: ds[Math.floor(0.025 * reps)], hi: ds[Math.ceil(0.975 * reps) - 1] };
}

/** The preregistered decision rule (docs/benchmarks/2026-10-08-facts-extraction-model.md, "Decision rule"). */
export const RULE = {
  /** Recall and precision: the paired 95% interval's lower bound must stay above minus this margin. */
  noninferiority_margin: 0.05,
  /** Attribution and correction handling ("no worse"): the point difference must be at least minus this, and the paired interval must not lie wholly below zero. */
  no_worse_tolerance: 0.02,
} as const;

export interface ArmValidity {
  /** Unhandled parse failures: unparseable model output consumed with no failure record. */
  unhandled_parse_failures: number;
  /** Every facts-absorb model call resolved to the requested model. */
  resolved_model_matches: boolean;
  /** Facts the jobs reported inserted that a fresh process could not read. */
  unreadable_after_restart: number;
  /** Jobs still queued, failed or dead after the drain. */
  jobs_not_completed: number;
}

export interface Verdict { pass: boolean; checks: Array<{ name: string; pass: boolean; detail: string }> }

export function decide(base: ArmScore, cand: ArmScore, validity: ArmValidity): Verdict {
  const checks: Verdict['checks'] = [];
  for (const m of ['recall', 'precision'] as const) {
    const d = pairedDiff(base.pages, cand.pages, m);
    checks.push({ name: `${m} non-inferior`, pass: d.lo > -RULE.noninferiority_margin, detail: `${pp(d.diff)} [${pp(d.lo)}, ${pp(d.hi)}] vs margin -${pp(RULE.noninferiority_margin)}` });
  }
  for (const m of ['attribution', 'correction'] as const) {
    const d = pairedDiff(base.pages, cand.pages, m);
    checks.push({ name: `${m} no worse`, pass: d.diff >= -RULE.no_worse_tolerance && d.hi >= 0, detail: `${pp(d.diff)} [${pp(d.lo)}, ${pp(d.hi)}] vs tolerance -${pp(RULE.no_worse_tolerance)}` });
  }
  checks.push({ name: 'zero unhandled parse failures', pass: validity.unhandled_parse_failures === 0, detail: String(validity.unhandled_parse_failures) });
  checks.push({ name: 'resolved model at the facts invocation is the requested model', pass: validity.resolved_model_matches, detail: String(validity.resolved_model_matches) });
  checks.push({ name: 'every inserted fact readable after restart', pass: validity.unreadable_after_restart === 0, detail: String(validity.unreadable_after_restart) });
  checks.push({ name: 'every facts-absorb job completed', pass: validity.jobs_not_completed === 0, detail: String(validity.jobs_not_completed) });
  return { pass: checks.every(c => c.pass), checks };
}

const pp = (x: number) => `${(x * 100).toFixed(1)} pts`;
