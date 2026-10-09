/**
 * Development career-chronicle corpus for the Q2 write-then-answer pilot (dev seeds 1-3 only).
 *
 * A seeded ledger of people and invented companies: sequential jobs with gaps and rejoins, a concurrent part-time
 * role, advisory and angel-investor relations, and people mentioned without any employer. It is rendered as raw
 * documents an investor's inbox and notes would hold: announcement emails, meeting notes, short bios and an
 * intro thread. Questions come in pairs per person (relational: current employer, advisor or investor; temporal:
 * where did they work on date D), with unanswerable items the documents never settle (UNKNOWN is the correct answer).
 *
 * This is the implementer's own development material, written without sight of the custodian's career corpus or
 * its ledger. The custodian's held-out corpus never lives in this repository.
 */
import { createHash } from 'node:crypto';
import { Rng } from './seeded.ts';

export const CAREER_DEV_SEEDS: readonly number[] = [1, 2, 3];
export const CAREER_DEV_VERSION = 'career-chronicle-dev-v1';
export const CAREER_TODAY = '2026-04-19';

export interface CareerStint { company: string; from: string; until: string | null; role: string; part_time?: true }
export interface CareerPerson { slug: string; name: string; stints: CareerStint[]; advises: Array<{ company: string; from: string }>; invested_in: Array<{ company: string; on: string }>; mentioned_only?: true }
export interface CareerDoc { path: string; content: string }
export interface CareerQuestion { id: string; pair: string; corpus: 'career'; type: 'relational' | 'temporal'; answerable: boolean; question: string; answer: string }
export interface CareerWorld { seed: number; people: CareerPerson[]; companies: string[]; docs: CareerDoc[]; questions: CareerQuestion[]; fingerprint: string }

const FIRST = ['Avery', 'Blake', 'Casey', 'Devon', 'Emery', 'Finley', 'Harper', 'Jordan', 'Kendall', 'Logan', 'Morgan', 'Parker', 'Quinn', 'Reese', 'Rowan', 'Sawyer', 'Taylor', 'Wren'];
const LAST = ['Example', 'Sample', 'Placeholder', 'Demo', 'Testcase', 'Fixture'];
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Hooli', 'Vandelay', 'Wonka', 'Tyrell', 'Cyberdyne', 'Soylent', 'Umbrella', 'Stark', 'Oscorp'];
const ROLES = ['staff engineer', 'head of product', 'VP sales', 'designer', 'CFO', 'data lead', 'COO', 'engineering manager'];
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const LIMIT = Date.parse('2026-01-31');

const JOIN = [
  (n: string, c: string, r: string) => `Subject: News from ${n}\n\nHi all,\n\nI'm excited to share that I've joined ${c} as ${r}. Looking forward to catching up.\n\n${n}`,
  (n: string, c: string, r: string) => `Subject: Re: intro\n\nQuick update: ${n} signed on with ${c} as ${r} last week, so route anything for them there.`,
  (n: string, c: string, r: string) => `Subject: Starting something new\n\nAfter a short break I'm starting at ${c}. I'll be the ${r}.\n\n— ${n}`,
];
const LEAVE = [
  (n: string, c: string) => `Subject: Moving on\n\nToday was my last day at ${c}. Thank you all.\n\n${n}`,
  (n: string, c: string) => `Subject: fyi\n\nHeard ${n} has left ${c}; they wrapped up there this month.`,
];

export function generateCareerDevWorld(seed: number, o: { people?: number } = {}): CareerWorld {
  if (!CAREER_DEV_SEEDS.includes(seed)) throw new Error(`the development career corpus uses dev seeds ${CAREER_DEV_SEEDS.join(', ')}; the held-out corpus comes from the custodian`);
  const rng = new Rng(seed * 104_723 + 11);
  const companies = rng.shuffle(COMPANIES).slice(0, 8);
  const people: CareerPerson[] = [];
  const nPeople = o.people ?? 12;
  for (let i = 0; i < nPeople; i++) {
    const name = `${FIRST[(i * 5 + seed) % FIRST.length]} ${LAST[(i + seed) % LAST.length]}`;
    const slug = name.toLowerCase().replace(/ /g, '-') + `-${i}`;
    const stints: CareerStint[] = [];
    let day = Date.UTC(rng.int(2012, 2018), rng.int(0, 11), rng.int(1, 28));
    const n = rng.int(1, 3);
    for (let k = 0; k < n; k++) {
      const pool = companies.filter(c => c !== stints[stints.length - 1]?.company);
      const company = k === 2 && rng.float() < 0.3 ? stints[0].company : rng.pick(pool);
      const end = day + rng.int(400, 1400) * DAY;
      const last = k === n - 1 || end >= LIMIT;
      stints.push({ company, from: iso(day), until: last ? (rng.float() < 0.85 ? null : iso(Math.min(end, LIMIT - 40 * DAY))) : iso(end), role: rng.pick(ROLES) });
      if (last) break;
      day = end + (rng.float() < 0.5 ? 0 : rng.int(30, 300) * DAY);
      if (day >= LIMIT) break;
    }
    const current = stints.find(s => s.until === null);
    if (current && rng.float() < 0.2) {
      const other = companies.filter(c => !stints.some(s => s.company === c));
      stints.push({ company: rng.pick(other), from: iso(Date.parse(current.from) + rng.int(90, 500) * DAY), until: null, role: 'part-time advisor-in-residence', part_time: true });
    }
    const free = companies.filter(c => !stints.some(s => s.company === c));
    people.push({ slug, name, stints,
      advises: rng.float() < 0.3 ? [{ company: rng.pick(free), from: iso(Date.UTC(rng.int(2020, 2025), rng.int(0, 11), 5)) }] : [],
      invested_in: rng.float() < 0.25 ? [{ company: rng.pick(free), on: iso(Date.UTC(rng.int(2019, 2025), rng.int(0, 11), 12)) }] : [] });
  }
  for (let i = 0; i < 3; i++) people.push({ slug: `mentioned-${i}`, name: `${FIRST[(i * 7 + seed + 3) % FIRST.length]} Mention${i}`, stints: [], advises: [], invested_in: [], mentioned_only: true });

  const docs: CareerDoc[] = [];
  let n = 0;
  const doc = (kind: string, date: string, body: string) => docs.push({ path: `${kind}/${date}-${String(++n).padStart(3, '0')}.md`, content: `Date: ${date}\n\n${body}\n` });
  for (const p of people.filter(x => !x.mentioned_only)) {
    p.stints.forEach((s, k) => {
      const prev = p.stints[k - 1];
      if (s.part_time) doc('notes', s.from, `Call notes. ${p.name} mentioned they took on a part-time role at ${s.company} (${s.role}) while keeping the day job.`);
      else if (prev && prev.until === s.from) doc('email', s.from, `Subject: Big move\n\n${p.name} here. I'm leaving ${prev.company} to join ${s.company} as ${s.role}. My last day at ${prev.company} is today.`);
      else doc('email', s.from, JOIN[(k + p.name.length) % JOIN.length](p.name, s.company, s.role));
      const next = p.stints[k + 1];
      if (s.until && !(next && next.from === s.until && !next.part_time)) doc('email', s.until, LEAVE[k % LEAVE.length](p.name, s.company));
    });
    for (const a of p.advises) doc('notes', a.from, `Meeting notes with ${a.company}. ${p.name} has agreed to advise ${a.company} on go-to-market; not an employee.`);
    for (const v of p.invested_in) doc('email', v.on, `Subject: Closing\n\n${p.name} wired an angel check into ${v.company}'s seed round today.`);
    const cur = p.stints.filter(s => s.until === null && !s.part_time);
    if (cur.length && rng.float() < 0.5) doc('bios', CAREER_TODAY, `${p.name} is ${cur[0].role} at ${cur[0].company}. Previously: ${p.stints.filter(s => s.until).map(s => s.company).join(', ') || 'none listed'}.`);
  }
  for (const m of people.filter(x => x.mentioned_only)) doc('notes', iso(Date.UTC(2025, rng.int(0, 11), 20)), `Conference recap. Ran into ${m.name} at the hallway track; talked about hiring markets. Did not ask where they work now.`);
  docs.sort((a, b) => a.path.localeCompare(b.path));

  const employersAt = (p: CareerPerson, d: string) => p.stints.filter(s => s.from <= d && (s.until === null || d < s.until)).map(s => s.company);
  const questions: CareerQuestion[] = [];
  people.forEach((p, i) => {
    const pair = `career-dev${seed}-p${String(i + 1).padStart(2, '0')}`;
    const q = (type: CareerQuestion['type'], question: string, answer: string | null): CareerQuestion => ({ id: `${pair}-${type === 'relational' ? 'rel' : 'tmp'}`, pair, corpus: 'career', type, answerable: answer !== null, question, answer: answer ?? 'UNKNOWN (the documents never say)' });
    if (p.mentioned_only) {
      questions.push(q('relational', `Where does ${p.name} work now?`, null), q('temporal', `Where did ${p.name} work on 2024-06-01?`, null));
      return;
    }
    const cur = p.stints.filter(s => s.until === null).map(s => s.company);
    const rel = p.advises.length ? q('relational', `Which company does ${p.name} advise?`, p.advises.map(a => a.company).join(', '))
      : p.invested_in.length ? q('relational', `Which company has ${p.name} invested in as an angel?`, p.invested_in.map(a => a.company).join(', '))
      : q('relational', `Where does ${p.name} work now? Name every current employer.`, cur.length ? cur.join(', ') : 'nowhere (no current employer)');
    const first = Date.parse(p.stints[0].from);
    const unanswerableDate = rng.float() < 0.2;
    const d = unanswerableDate ? iso(first - rng.int(400, 1500) * DAY) : iso(first + rng.int(30, Math.max(31, Math.floor((LIMIT - first) / DAY) - 30)) * DAY);
    const at = employersAt(p, d);
    const tmp = q('temporal', `Where did ${p.name} work on ${d}?`, unanswerableDate ? null : at.length ? at.join(', ') : 'nowhere (between jobs)');
    questions.push(rel, tmp);
  });
  const fingerprint = createHash('sha256').update(JSON.stringify({ v: CAREER_DEV_VERSION, seed, people, docs, questions })).digest('hex');
  return { seed, people, companies, docs, questions, fingerprint };
}
