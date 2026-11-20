/**
 * G1 world generator: freshness across pages, with time reasoning and memory not consulted folded in (GBEV-55, gap
 * ranks 1, 7 and 9).
 *
 * Wintermute ranks a stale fact used in a draft as its costliest failure, and says that in about 70% of stale cases the
 * newer fact sat on a page it did not open. Each task here is a small fictional founder brain where the answer depends
 * on reading the newer page, or the part of a page below a stale summary, and on reading dates in the right clock:
 *
 *   entity_lag           a person page says one company; a later meeting page says she moved.
 *   summary_vs_timeline  a compiled summary at the top of a company page contradicts the dated timeline beneath it.
 *   decision_reversed    a decision in one thread is reversed two weeks later in another thread.
 *   shared_vs_published  a media page's date is the day it was shared, not the day it was published.
 *   last_week_tz         "last week" read in Pacific time versus UTC across a Sunday-night meeting.
 *
 * Every task has one answer value and three disjoint gold readings: fresh (correct), stale (the older value) and
 * time_shifted (the value a wrong clock or a future-dated plan gives). Variant 0 of the first three patterns is
 * Wintermute's own fictional template (Priya Rao leaving Halcyon for Brightwell, Brightwell's $8M versus $12M round,
 * vendor A reversed); every other variant draws invented names, values and dates from the seed.
 */
import { Rng, addDays, fingerprint } from './seeded.ts';

export const G1_PATTERNS = ['entity_lag', 'summary_vs_timeline', 'decision_reversed', 'shared_vs_published', 'last_week_tz'] as const;
export type G1Pattern = typeof G1_PATTERNS[number];
export const G1_DEFAULT_SEED = 20261110;
export const G1_DEFAULT_TASKS = 120;
/** The newest as-of date, a Monday; variants step back whole weeks. */
export const G1_BASE_AS_OF = '2026-11-09';
export const READINGS = ['fresh', 'stale', 'time_shifted'] as const;
export type Reading = typeof READINGS[number];

export interface FreshnessTask {
  id: string;
  pattern: G1Pattern;
  variant: number;
  as_of: string;
  pages: Array<{ slug: string; markdown: string }>;
  question: string;
  /** The same question under time pressure, the memory_not_consulted probe. */
  pressured_question: string;
  /** Accepted spellings of each reading; no spelling appears under two readings. */
  gold: Record<Reading, string[]>;
  /** The page holding the fresh value; a stale answer without opening it is gold_unopened. */
  fresh_page: string;
}

const PEOPLE = ['Mara Quist', 'Tobin Hale', 'Sefa Lindqvist', 'Ilse Varga', 'Omar Petrakis', 'Juno Achebe', 'Wren Castellano', 'Arlo Mbeki', 'Noor Halvorsen', 'Cyrus Okonjo', 'Leda Fairweather', 'Paz Ferreira'];
const COMPANIES = ['Halvard', 'Pinecrest Robotics', 'Saltmarsh', 'Ostrava Health', 'Kitefin', 'Mossgrove', 'Tidewater AI', 'Emberly', 'Corvane', 'Bellwether Bio', 'Driftline', 'Quarry Labs'];
const VENDORS = ['Norvale', 'Quillon', 'Brask', 'Ottoline', 'Veridian Cloud', 'Harrow Data', 'Plinth', 'Sorrel Systems'];
const PLANS = ['Juniper', 'Saffron', 'Cobalt', 'Marigold', 'Basalt', 'Tamarind', 'Quartz', 'Larch', 'Heron', 'Fennel'];
const OUTLETS = ['The Ledger Weekly', 'Northwind Review', 'Signal & Noise', 'The Founders Gazette'];
const TOPICS = ['payroll provider', 'cloud host', 'design agency', 'security auditor', 'data warehouse'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const page = (type: string, title: string, date: string, body: string) => `---\ntype: ${type}\ntitle: ${title}\ndate: ${date}\n---\n\n${body}\n`;
const money = (m: number) => [`$${m}M`, `${m}M`, `$${m} million`, `${m} million`];
function dateAliases(iso: string): string[] {
  const [y, m, d] = iso.split('-').map(Number);
  const month = MONTHS[m - 1];
  return [iso, `${month} ${d}, ${y}`, `${month.slice(0, 3)} ${d}, ${y}`, `${d} ${month} ${y}`];
}
const PRESSURE = 'Quick one, I am walking into a meeting in a minute and need this now. Answer straight away if you already know it.';

function distinct<T>(rng: Rng, pool: readonly T[], n: number): T[] { return rng.shuffle(pool).slice(0, n); }

function makeTask(rng: Rng, pattern: G1Pattern, variant: number, index: number): FreshnessTask {
  const asOf = addDays(G1_BASE_AS_OF, -7 * Math.floor(variant / 2));
  const template = variant === 0;
  const id = `g1-${String(index + 1).padStart(3, '0')}-${pattern}`;
  const ask = (q: string) => ({ question: `Today is ${asOf}. ${q} Reply with the value only.`, pressured_question: `Today is ${asOf}. ${PRESSURE} ${q} Reply with the value only.` });
  switch (pattern) {
    case 'entity_lag': {
      const who = template ? 'Priya Rao' : rng.pick(PEOPLE);
      const [old, now, next] = template ? ['Halcyon', 'Brightwell', 'Corvane'] : distinct(rng, COMPANIES, 3);
      const p = `people/${slugify(who)}`;
      const meeting = `meetings/${addDays(asOf, -9)}-${slugify(who)}-catch-up`;
      const plans = `notes/${slugify(who)}-next-role`;
      return { id, pattern, variant, as_of: asOf, fresh_page: meeting, ...ask(`Which company does ${who} work at right now?`),
        pages: [
          page('person', who, addDays(asOf, -120), `${who} is CTO at ${old}. Met through the ${old} seed round.`),
          page('meeting', `Catch-up with ${who}`, addDays(asOf, -9), `${who} said she left ${old} last month and is now VP Engineering at ${now}.`),
          page('note', `${who} next role`, addDays(asOf, -5), `${who} mentioned an offer from ${next}: if she accepts, she would start there on ${addDays(asOf, 60)}.`),
        ].map((markdown, i) => ({ slug: [p, meeting, plans][i], markdown })),
        gold: { fresh: [now], stale: [old], time_shifted: [next] } };
    }
    case 'summary_vs_timeline': {
      const co = template ? 'Brightwell' : rng.pick(COMPANIES);
      const [a, b, c] = template ? [8, 12, 30] : (() => { const x = rng.int(3, 9); return [x, x + rng.int(2, 6), x + rng.int(15, 40)]; })();
      const slug = `companies/${slugify(co)}`;
      const body = [
        `**Summary:** ${co} raised a $${a}M seed round and is not raising.`, '',
        '## Timeline', '',
        `- ${addDays(asOf, -150)}: closed a $${a}M seed round.`,
        `- ${addDays(asOf, -20)}: extended the round; the current round now totals $${b}M.`,
        `- ${addDays(asOf, 45)} (planned): a $${c}M Series A is expected to close.`,
      ].join('\n');
      return { id, pattern, variant, as_of: asOf, fresh_page: slug, ...ask(`How much has ${co} raised in its current round so far?`),
        pages: [{ slug, markdown: page('company', co, addDays(asOf, -150), body) }, { slug: `people/${slugify(rng.pick(PEOPLE))}`, markdown: page('person', 'Board observer', addDays(asOf, -90), `Observer on the ${co} board.`) }],
        gold: { fresh: money(b), stale: money(a), time_shifted: money(c) } };
    }
    case 'decision_reversed': {
      const topic = rng.pick(TOPICS);
      const [va, vb, vc] = template ? ['Vendor A', 'Vendor B', 'Vendor C'] : distinct(rng, VENDORS, 3);
      const t1 = `threads/${slugify(topic)}-decision-${index + 1}`;
      const t2 = `threads/${slugify(topic)}-follow-up-${index + 1}`;
      const t3 = `notes/${slugify(topic)}-review-plan-${index + 1}`;
      return { id, pattern, variant, as_of: asOf, fresh_page: t2, ...ask(`Which ${topic} did the team decide to go with?`),
        pages: [
          { slug: t1, markdown: page('thread', `${topic} decision`, addDays(asOf, -30), `Decision: we will go with ${va} for the ${topic}.`) },
          { slug: t2, markdown: page('thread', `Re: ${topic}`, addDays(asOf, -16), `Reversing the earlier call on the ${topic}: we are going with ${vb} instead, because ${va} could not meet the security review.`) },
          { slug: t3, markdown: page('note', `${topic} review`, addDays(asOf, -3), `At the review on ${addDays(asOf, 90)} the team plans to evaluate a switch to ${vc}.`) },
        ],
        gold: { fresh: [vb], stale: [va], time_shifted: [vc] } };
    }
    case 'shared_vs_published': {
      const outlet = rng.pick(OUTLETS);
      const co = rng.pick(COMPANIES);
      const published = addDays(asOf, -rng.int(20, 60));
      const shared = addDays(published, rng.int(3, 12));
      const slug = `media/${slugify(co)}-profile-${index + 1}`;
      return { id, pattern, variant, as_of: asOf, fresh_page: slug, ...ask(`On what date (Pacific time) was the ${outlet} profile of ${co} originally published?`),
        pages: [{ slug, markdown: page('media', `${outlet} profile of ${co}`, shared, `Shared in the team channel. The ${outlet} profile of ${co} was published on ${published} at 22:30 Pacific time (${addDays(published, 1)} 05:30 UTC).`) }],
        gold: { fresh: dateAliases(published), stale: dateAliases(shared), time_shifted: dateAliases(addDays(published, 1)) } };
    }
    case 'last_week_tz': {
      const who = rng.pick(PEOPLE);
      const [fresh, shifted, stale] = distinct(rng, PLANS, 3);
      const m1 = `meetings/${asOf}-${slugify(who)}-weekly`;
      const m2 = `meetings/${addDays(asOf, -7)}-${slugify(who)}-weekly`;
      const m3 = `meetings/${addDays(asOf, -14)}-${slugify(who)}-weekly`;
      const mk = (slug: string, at: string, plan: string) => ({ slug, markdown: page('meeting', `Weekly with ${who}`, at, `Meeting at ${at} (UTC). ${who} approved plan ${plan}.`) });
      return { id, pattern, variant, as_of: asOf, fresh_page: m1, ...ask(`I am in Pacific time. Which plan did ${who} approve at our meeting last week (Monday to Sunday, Pacific time)?`),
        pages: [mk(m1, `${asOf}T05:00:00Z`, fresh), mk(m2, `${addDays(asOf, -7)}T03:00:00Z`, shifted), mk(m3, `${addDays(asOf, -14)}T18:00:00Z`, stale)],
        gold: { fresh: [fresh], stale: [stale], time_shifted: [shifted] } };
    }
  }
}

export function generateFreshnessTasks(opts: { seed?: number; n?: number } = {}): FreshnessTask[] {
  const rng = new Rng(opts.seed ?? G1_DEFAULT_SEED);
  const n = opts.n ?? G1_DEFAULT_TASKS;
  return Array.from({ length: n }, (_, i) => makeTask(rng, G1_PATTERNS[i % G1_PATTERNS.length], Math.floor(i / G1_PATTERNS.length), i));
}

export function freshnessDigest(tasks: readonly FreshnessTask[]): string { return fingerprint(tasks); }

if (import.meta.main) {
  const tasks = generateFreshnessTasks();
  console.log(JSON.stringify({ tasks: tasks.length, digest: freshnessDigest(tasks), first: tasks.slice(0, 3).map(t => ({ id: t.id, question: t.question, gold: t.gold })) }, null, 2));
}
