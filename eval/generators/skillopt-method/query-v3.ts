/**
 * query task set for skillopt-method-v3 (GBEV-30, plan section 2), over
 * world-v3. Trained families (train, sel, gate, test):
 *
 *   as-of             an account's term as of a date, where the record chain
 *                     sets a trap: a renewal signed but not yet in force, a
 *                     rescission that reinstated an earlier value, an
 *                     amendment's window before its rescission, a superseded
 *                     value, or a later change not yet made
 *   two-hop           GST-955's template, "Who founded the company that P
 *                     works with?": P's current company, then its founder
 *   lookalike         a near-name person (Maren Holte beside Maren Holt) or a
 *                     company sharing a stem (Corvane Robotics beside Corvane
 *                     Analytics), resolvable by the exact name; or two people
 *                     with one name, which the answer must call ambiguous,
 *                     naming each one's company
 *   absent            an entity no page carries, built from a real one (an
 *                     account's stem with another suffix, a person's first
 *                     name with another person's surname), so its near-miss
 *                     pages hold values a careless answer gives
 *
 * Held-out families (gate and test only):
 *
 *   three-hop         the founder of the company that acquired (or the venture
 *                     firm that alone backed) the company P works with
 *   role-on-date      who held a company's chief executive or chief technology
 *                     officer role on a date, when the role changed hands
 *   note-contradicts  an account's term as of a date after an informal note
 *                     stated another value the signed records do not hold
 *
 * Usage: generated through eval/generators/skillopt-method/gen.ts.
 */
import { Rng } from '../seeded.ts';
import {
  absentFromWorld, acquirerFromText, assembleV3, founderFromText, goldOf, loadWorldV3, nameValue, possessive, roleHolderFromText, soleInvestorFromText,
  stintFromText, uniqueValues, valueFromText, type DraftV3, type SkillGenerationV3, type WorldCorpus,
} from './common-v3.ts';
import {
  addDays, ATTR_IDS, ATTRS, chainEnd, currentStint, daysBetween, DEFAULT_V3_KNOBS, longDate, stintAt, valueAt, WORLD_NOW, type AttrId, type Contract, type Org, type Person, type V3Knobs,
} from './world-v3.ts';
import { ACCOUNT_SUFFIXES, COMPANY_KINDS } from './world-v3-banks.ts';
import type { GoldValue } from '../../runner/skillopt-method/score.ts';

export const QUERY_V3_SEED = 30_011;
export const QUERY_V3_QUOTAS = {
  'as-of': [7, 7, 5, 14],
  'two-hop': [6, 6, 5, 12],
  lookalike: [6, 6, 4, 12],
  absent: [5, 5, 4, 10],
  'three-hop': [0, 0, 6, 16],
  'role-on-date': [0, 0, 6, 16],
  'note-contradicts': [0, 0, 6, 16],
} as const;
export const QUERY_V3_HELD_OUT = ['three-hop', 'role-on-date', 'note-contradicts'] as const;

const show = (attr: AttrId, v: number | string) => ATTRS[attr].cell(v);
const cite = (slugs: readonly string[]) => slugs.map(s => `[Source: ${s}]`).join(' ');

/** Change points of one attribute on an account's chain, each with the trap a date near it sets. */
function asOfDates(chain: readonly Contract[], attr: AttrId, rng: Rng): Array<{ date: string; trap: string; priority: number }> {
  const out: Array<{ date: string; trap: string; priority: number }> = [];
  const last = [addDays(WORLD_NOW, -2), chainEnd(chain)].sort()[0]!;
  const changes = [...new Set(chain.flatMap(c => [c.effective, c.signed]))].sort();
  const clear = (d: string) => d >= addDays(chain[0]!.effective, 5) && d <= last && changes.every(x => Math.abs(daysBetween(x, d)) >= 3);
  const add = (d: string, trap: string, priority: number) => { if (clear(d)) out.push({ date: d, trap, priority }); };
  chain.forEach((c, i) => {
    if (c.kind === 'renewal' && attr in c.sets && daysBetween(c.signed, c.effective) > 8) add(addDays(c.signed, rng.int(4, daysBetween(c.signed, c.effective) - 4)), 'pending', 4);
    if (c.kind === 'rescission') {
      const t = chain.find(x => x.slug === c.rescinds)!;
      if (attr in t.sets) {
        add(addDays(c.effective, rng.int(5, 40)), 'rescinded', 4);
        if (daysBetween(t.effective, c.effective) > 10) add(addDays(t.effective, rng.int(4, daysBetween(t.effective, c.effective) - 4)), 'rescinded-window', 3);
      }
    }
    if (i > 0 && c.kind !== 'rescission' && attr in c.sets) {
      add(addDays(c.effective, rng.int(10, 60)), 'superseded', 2);
      add(addDays(c.effective, -rng.int(10, 50)), 'before-change', 1);
    }
  });
  return out;
}

export function queryV3Drafts(corpus: WorldCorpus, rng: Rng): DraftV3[] {
  const { world: w, pages } = corpus;
  const drafts: DraftV3[] = [];
  const org = (s: string) => w.orgs.get(s)!;
  const person = (s: string) => w.people.get(s)!;
  const founderName = (o: Org) => (o.founder ? person(o.founder).name : null);
  const accounts = [...w.orgs.values()].filter(o => o.kind === 'account');
  const companies = [...w.orgs.values()].filter(o => o.kind === 'company');
  const lookalikePeople = new Set([...w.lookalikes.homonyms.flat(), ...w.lookalikes.near.flat()]);

  // as-of and note-contradicts: one builder, the family set by whether an informal note stated a wrong value before the date.
  const asOf = (family: 'as-of' | 'note-contradicts', a: Org, attr: AttrId, date: string, trap: string, priority: number, notePage?: string) => {
    const chain = w.chains.get(a.slug)!;
    const anchor = `asof:${a.slug}:${attr}@${date}`;
    const g = valueAt(chain, attr, date);
    if (!g) return drafts.push({ ok: false, family, anchor, reason: 'no record sets the term on that date' });
    const rescission = chain.find(c => c.rescinds && c.effective <= date && (chain.find(x => x.slug === c.rescinds)!.sets[attr] !== undefined) && chain.find(x => x.slug === c.rescinds)!.effective >= g.record.effective);
    const slugs = [g.record.slug, ...(rescission ? [rescission.slug] : [])];
    const wrongMentions = w.mentions.filter(m => m.account === a.slug && m.attr === attr && !m.correct && m.date <= date);
    const others = [...chain.flatMap(c => (attr in c.sets ? [c.sets[attr]!] : [])), valueAt(chain, attr, WORLD_NOW)!.value, ...wrongMentions.map(m => m.value)];
    const answer = goldOf(attr, g.value);
    const distractors = uniqueValues(others.map(v => goldOf(attr, v)), [answer]);
    if (!distractors.length) return drafts.push({ ok: false, family, anchor, reason: 'the chain holds no other value for the term' });
    if (attr === 'renewal_date' && distractors.some(d => d.value === date)) return drafts.push({ ok: false, family, anchor, reason: 'the date asked equals a candidate value' });
    const o = valueFromText(pages, a.slug, attr, date);
    if (!o || String(o.value) !== String(g.value) || o.slug !== g.record.slug) return drafts.push({ ok: false, family, anchor, reason: `oracle: the contract pages give ${o ? `${o.value} on ${o.slug}` : 'no value'} for ${a.slug} ${attr} on ${date}, the chain ${g.value} on ${g.record.slug}` });
    const deciding = pages.get(g.record.slug)!.match(/^# (.+)$/m)![1]!;
    drafts.push({ ok: true, priority, candidate: {
      family,
      task: `As of ${longDate(date)}, what was ${possessive(a.name)} ${ATTRS[attr].phrase}?`,
      anchor: { kind: 'record', id: anchor },
      fact_keys: [`val:${a.slug}:${attr}@${g.record.slug}`],
      answerable: true,
      gold: { values: [answer], slugs, cite: [slugs], spec: { kind: 'value', answer, distractors, cite: [slugs] } },
      distractors: { slugs: [...new Set([...chain.filter(c => c.slug !== g.record.slug && attr in c.sets).map(c => c.slug), ...wrongMentions.map(m => m.page), a.slug])], values: distractors },
      source: `world-v3 ${a.slug} contract chain, ${attr} on ${date} (${trap}${notePage ? `; informal note ${notePage}` : ''})`,
      oracle: { path: 'the contract pages the account lists, read for their effective dates, the values they set and the records they rescind; the latest record in force that sets the term, rescinded records dropped', evidence: o.evidence + (o.rescission ? `; reinstated by ${o.rescission}` : '') },
      oracle_answer: `Answer: ${show(attr, g.value)}\n\nAs of ${longDate(date)}, the record in force is ${deciding} ${cite(slugs)}. ${o.evidence}`,
    } });
    return 0;
  };
  for (const a of accounts) {
    const chain = w.chains.get(a.slug)!;
    for (const attr of ATTR_IDS) {
      const noteClaims = w.mentions.filter(m => m.account === a.slug && m.attr === attr && m.kind === 'note-claim' && !m.correct);
      for (const d of asOfDates(chain, attr, rng)) {
        if (noteClaims.some(m => m.date <= d.date)) continue;
        asOf('as-of', a, attr, d.date, d.trap, d.priority);
      }
      for (const m of noteClaims) {
        const date = addDays(m.date, rng.int(5, 45));
        if (date > addDays(WORLD_NOW, -2) || date > chainEnd(chain)) continue;
        if (String(valueAt(chain, attr, date)!.value) === String(m.value)) continue;
        asOf('note-contradicts', a, attr, date, 'informal note', String(m.value) === String(valueAt(chain, attr, m.date)!.value) ? 0 : 2, m.page);
      }
    }
  }

  // two-hop and three-hop: the company P works with, from P's page and the company's page.
  for (const p of w.people.values()) {
    const cur = currentStint(p);
    if (!cur || lookalikePeople.has(p.slug)) continue;
    const c = org(cur.org);
    if (c.kind !== 'company' || c.founder === p.slug || !c.founder) continue;
    const first = stintFromText(pages, p.slug, WORLD_NOW);
    if ('reason' in first) { drafts.push({ ok: false, family: 'two-hop', anchor: `two-hop:${p.slug}`, reason: `first hop: ${first.reason}` }); continue; }
    if (first.org !== c.slug) { drafts.push({ ok: false, family: 'two-hop', anchor: `two-hop:${p.slug}`, reason: `first hop: the page gives ${first.org}, the world ${c.slug}` }); continue; }
    const prev = p.stints.filter(s => s.end).map(s => org(s.org)).filter(o => o.kind === 'company' && o.founder);
    const hop = (family: 'two-hop' | 'three-hop', target: Org, task: string, extraKeys: string[], extraEvidence: string, path: string, extraDistractors: GoldValue[]) => {
      const anchor = `${family}:${p.slug}:${target.slug}`;
      const f = founderFromText(pages, target.slug);
      if ('reason' in f) return drafts.push({ ok: false, family, anchor, reason: `last hop: ${f.reason}` });
      if (f.slug !== target.founder) return drafts.push({ ok: false, family, anchor, reason: `last hop: the page gives ${f.slug}, the world ${target.founder}` });
      const answer = nameValue(f.name);
      const ceo = target.ceo.at(-1)?.person;
      const backers = target.investors.map(i => org(i.org)).filter(o => o.founder).map(o => nameValue(founderName(o)!));
      const distractors = uniqueValues([...extraDistractors, ...(ceo && ceo !== f.slug ? [nameValue(person(ceo).name)] : []), ...prev.map(o => nameValue(founderName(o)!)), ...backers], [answer]).filter(v => v.value !== p.name);
      const slugs = [target.slug, f.slug];
      drafts.push({ ok: true, priority: distractors.length, candidate: {
        family, task, anchor: { kind: 'entity', id: anchor },
        fact_keys: [`founder:${target.slug}`, `works:${p.slug}@${c.slug}`, ...extraKeys],
        answerable: true,
        gold: { values: [answer], slugs, cite: [slugs], spec: { kind: 'value', answer, distractors, cite: [slugs] } },
        distractors: { slugs: [...new Set([p.slug, c.slug, ...prev.map(o => o.slug)])].filter(s => !slugs.includes(s)), values: distractors },
        source: `world-v3 ${p.slug} current stint, ${path}`,
        oracle: { path: `the career list on the person's page (confirmed by the company's page naming them); ${path}; the company's founding line, confirmed by the founder's page`, evidence: `${first.line}${extraEvidence}\n${f.evidence}` },
        oracle_answer: `Answer: ${f.name}\n\n${p.name} works with ${c.name}${extraEvidence ? `; ${extraEvidence.trim()}` : ''}. ${target.name} was founded by ${f.name} ${cite(slugs)}.`,
      } });
      return 0;
    };
    hop('two-hop', c, `Who founded the company that ${p.name} works with?`, [], '', 'then that company', []);
    if (c.acquiredBy) {
      const acq = acquirerFromText(pages, c.slug);
      if ('reason' in acq) drafts.push({ ok: false, family: 'three-hop', anchor: `three-hop:${p.slug}`, reason: `second hop: ${acq.reason}` });
      else if (acq.slug !== c.acquiredBy.org) drafts.push({ ok: false, family: 'three-hop', anchor: `three-hop:${p.slug}`, reason: 'second hop: the page names another acquirer' });
      else hop('three-hop', org(acq.slug), `Who founded the company that acquired the company ${p.name} works with?`, [`acq:${c.slug}`], ` ${acq.name} acquired ${c.name}`, `then its acquirer (${acq.evidence})`, [nameValue(founderName(c)!)]);
    }
    if (c.investors.length === 1) {
      const inv = soleInvestorFromText(pages, c.slug);
      if ('reason' in inv) drafts.push({ ok: false, family: 'three-hop', anchor: `three-hop:${p.slug}:inv`, reason: `second hop: ${inv.reason}` });
      else hop('three-hop', org(inv.slug), `Who founded the venture firm that invested in the company ${p.name} works with?`, [`inv:${c.slug}`], ` ${inv.name} is its only investor`, `then its only investor (${inv.evidence})`, [nameValue(founderName(c)!)]);
    }
  }

  // role-on-date: a role that changed hands, asked on a date inside one tenure.
  for (const c of companies) {
    for (const [label, key, tenures] of [['Chief executive', 'chief executive', c.ceo], ['Chief technology officer', 'chief technology officer', c.cto]] as const) {
      if (tenures.length < 2) continue;
      tenures.forEach((t, i) => {
        const end = t.end ?? addDays(WORLD_NOW, -2);
        if (daysBetween(t.start, end) < 60) return;
        const date = addDays(t.start, rng.int(20, daysBetween(t.start, end) - 20));
        const anchor = `role:${c.slug}:${key}@${date}`;
        const o = roleHolderFromText(pages, c.slug, label, date);
        if ('reason' in o) return drafts.push({ ok: false, family: 'role-on-date', anchor, reason: o.reason });
        if (o.slug !== t.person) return drafts.push({ ok: false, family: 'role-on-date', anchor, reason: `the page gives ${o.slug}, the world ${t.person}` });
        const answer = nameValue(o.name);
        const distractors = uniqueValues([...tenures.filter(x => x !== t).map(x => nameValue(person(x.person).name)), ...(c.founder && c.founder !== t.person ? [nameValue(person(c.founder).name)] : [])], [answer]);
        const announcement = w.announcements.find(x => x.kind === 'leadership' && x.org === c.slug && x.other === t.person && label === 'Chief executive');
        const slugs = [c.slug, t.person, ...(announcement ? [announcement.slug] : [])];
        drafts.push({ ok: true, priority: i < tenures.length - 1 ? 2 : 1, candidate: {
          family: 'role-on-date',
          task: `Who was ${possessive(c.name)} ${key} on ${longDate(date)}?`,
          anchor: { kind: 'entity', id: anchor },
          fact_keys: [`role:${c.slug}:${key}:${t.person}`],
          answerable: true,
          gold: { values: [answer], slugs, cite: [slugs], spec: { kind: 'value', answer, distractors, cite: [slugs] } },
          distractors: { slugs: tenures.filter(x => x !== t).map(x => x.person), values: distractors },
          source: `world-v3 ${c.slug} ${key} tenures`,
          oracle: { path: "the company page's leadership line, read for the tenure covering the date, confirmed by the holder's career list", evidence: o.evidence },
          oracle_answer: `Answer: ${o.name}\n\n${o.name} was ${possessive(c.name)} ${key} on ${longDate(date)} ${cite([c.slug, t.person])}.`,
        } });
        return 0;
      });
    }
  }

  // lookalike: near-name people, companies sharing a stem, and homonyms.
  for (const pair of w.lookalikes.near) for (const [x, y] of [pair, [pair[1], pair[0]]] as const) {
    const px = person(x!), py = person(y!);
    const cx = currentStint(px), cy = currentStint(py);
    if (!cx || !cy) continue;
    const ox = org(cx.org), oy = org(cy.org);
    const anchor = `lookalike:${px.slug}`;
    const first = stintFromText(pages, px.slug, WORLD_NOW);
    if ('reason' in first || first.org !== ox.slug) { drafts.push({ ok: false, family: 'lookalike', anchor, reason: `first hop: ${'reason' in first ? first.reason : 'another company'}` }); continue; }
    if (ox.kind === 'company' && ox.founder && ox.founder !== px.slug) {
      const f = founderFromText(pages, ox.slug);
      if ('reason' in f) { drafts.push({ ok: false, family: 'lookalike', anchor, reason: f.reason }); continue; }
      const answer = nameValue(f.name);
      const distractors = uniqueValues([...(oy.founder ? [nameValue(person(oy.founder).name)] : []), ...(oy.founder === py.slug ? [nameValue(py.name)] : [])], [answer]);
      const slugs = [ox.slug, f.slug];
      drafts.push({ ok: true, priority: distractors.length, candidate: {
        family: 'lookalike', task: `Who founded the company that ${px.name} works with?`, anchor: { kind: 'entity', id: anchor },
        fact_keys: [`founder:${ox.slug}`, `works:${px.slug}@${ox.slug}`, `name:${px.name.toLowerCase()}`], answerable: true,
        gold: { values: [answer], slugs, cite: [slugs], spec: { kind: 'value', answer, distractors, cite: [slugs] } },
        distractors: { slugs: [py.slug, oy.slug], values: distractors },
        source: `world-v3 near-name pair ${px.slug} / ${py.slug}`,
        oracle: { path: "the person's career list (confirmed by the company page), then the company's founding line confirmed by the founder's page", evidence: `${first.line}\n${f.evidence}` },
        oracle_answer: `Answer: ${f.name}\n\n${px.name} works with ${ox.name}, which ${f.name} founded ${cite(slugs)}.`,
        near_miss: [py.slug, oy.slug],
      } });
    } else {
      const answer = nameValue(ox.name);
      const distractors = uniqueValues([nameValue(oy.name)], [answer]);
      const slugs = [px.slug, ox.slug];
      drafts.push({ ok: true, priority: 0, candidate: {
        family: 'lookalike', task: `Which company does ${px.name} work with?`, anchor: { kind: 'entity', id: anchor },
        fact_keys: [`works:${px.slug}@${ox.slug}`, `name:${px.name.toLowerCase()}`], answerable: true,
        gold: { values: [answer], slugs, cite: [slugs], spec: { kind: 'value', answer, distractors, cite: [slugs] } },
        distractors: { slugs: [py.slug, oy.slug], values: distractors },
        source: `world-v3 near-name pair ${px.slug} / ${py.slug}`,
        oracle: { path: "the person's career list, confirmed by the organization's page naming them", evidence: first.line },
        oracle_answer: `Answer: ${ox.name}\n\n${px.name} is the ${first.title} at ${ox.name} ${cite(slugs)}.`,
        near_miss: [py.slug, oy.slug],
      } });
    }
  }
  for (const [ca, cb] of w.lookalikes.companies) for (const [x, y] of [[ca, cb], [cb, ca]] as const) {
    const ox = org(x), oy = org(y);
    const anchor = `lookalike:${ox.slug}`;
    const f = founderFromText(pages, ox.slug);
    if ('reason' in f || f.slug !== ox.founder) { drafts.push({ ok: false, family: 'lookalike', anchor, reason: 'reason' in f ? f.reason : 'another founder' }); continue; }
    const answer = nameValue(f.name);
    const distractors = uniqueValues(oy.founder ? [nameValue(person(oy.founder).name)] : [], [answer]);
    const slugs = [ox.slug, f.slug];
    drafts.push({ ok: true, priority: 1, candidate: {
      family: 'lookalike', task: `Who founded ${ox.name}?`, anchor: { kind: 'entity', id: anchor },
      fact_keys: [`founder:${ox.slug}`], answerable: true,
      gold: { values: [answer], slugs, cite: [slugs], spec: { kind: 'value', answer, distractors, cite: [slugs] } },
      distractors: { slugs: [oy.slug, ...(oy.founder ? [oy.founder] : [])], values: distractors },
      source: `world-v3 companies sharing a stem: ${ox.slug} / ${oy.slug}`,
      oracle: { path: "the company's founding line, confirmed by the founder's page", evidence: f.evidence },
      oracle_answer: `Answer: ${f.name}\n\n${ox.name} was founded by ${f.name} ${cite(slugs)}.`,
      near_miss: [oy.slug],
    } });
  }
  for (const [a, b] of w.lookalikes.homonyms) {
    const pa = person(a), pb = person(b);
    const sa = currentStint(pa), sb = currentStint(pb);
    const anchor = `ambiguous:${pa.name}`;
    if (!sa || !sb || sa.org === sb.org) { drafts.push({ ok: false, family: 'lookalike', anchor, reason: 'the two people do not work with two different organizations' }); continue; }
    const fa = stintFromText(pages, a, WORLD_NOW), fb = stintFromText(pages, b, WORLD_NOW);
    if ('reason' in fa || 'reason' in fb) { drafts.push({ ok: false, family: 'lookalike', anchor, reason: 'a career list does not confirm the current organization' }); continue; }
    const candidates = [nameValue(fa.orgName), nameValue(fb.orgName)];
    drafts.push({ ok: true, priority: 1, candidate: {
      family: 'lookalike', task: `Which company does ${pa.name} work with?`, anchor: { kind: 'entity', id: anchor },
      fact_keys: [`name:${pa.name.toLowerCase()}`], answerable: false,
      gold: { values: [], slugs: [], spec: { kind: 'ambiguous', name: pa.name, candidates } },
      distractors: { slugs: [a, b, sa.org, sb.org], values: candidates },
      source: `world-v3 homonym pair ${a} / ${b}`,
      oracle: { path: 'two person pages carry the name, and their career lists give two different current organizations', evidence: `${a}: ${fa.line}\n${b}: ${fb.line}` },
      oracle_answer: `ambiguous: two people named ${pa.name} have brain pages, one at ${fa.orgName} and one at ${fb.orgName} [Source: ${a}] [Source: ${b}].`,
      near_miss: [a, b, sa.org, sb.org],
    } });
  }

  // absent: an account stem with another suffix, a stem pair with a third suffix, a first name with another surname.
  const absent = (name: string, task: string, nearMiss: string[], distractors: GoldValue[], evidence: string) => {
    const anchor = `absent:${name}`;
    if (!absentFromWorld(corpus, name) || [...w.orgs.values(), ...w.people.values()].some(e => e.name === name)) return drafts.push({ ok: false, family: 'absent', anchor, reason: `${name} occurs on a page` });
    drafts.push({ ok: true, priority: distractors.length, candidate: {
      family: 'absent', task, anchor: { kind: 'entity', id: anchor }, fact_keys: [`name:${name.toLowerCase()}`], answerable: false,
      gold: { values: [], slugs: [], subject: name, spec: { kind: 'absent', name, distractors } },
      distractors: { slugs: nearMiss, values: distractors },
      source: 'world-v3 absent name built from a real one',
      oracle: { path: 'absence of the full name from every page', evidence },
      oracle_answer: `The brain doesn't have information on ${name}. The closest pages are about other entities [Source: ${nearMiss[0]}].`,
      near_miss: nearMiss,
    } });
    return 0;
  };
  for (const a of rng.shuffle(accounts)) {
    const suffix = rng.pick(ACCOUNT_SUFFIXES.filter(s => s !== a.suffix));
    const chain = w.chains.get(a.slug)!;
    const end = [addDays(WORLD_NOW, -10), chainEnd(chain)].sort()[0]!;
    const date = addDays(chain[0]!.effective, rng.int(30, Math.max(31, daysBetween(chain[0]!.effective, end))));
    const seats = valueAt(chain, 'seats', date)!;
    absent(`${a.stem} ${suffix}`, `As of ${longDate(date)}, what was ${possessive(`${a.stem} ${suffix}`)} ${ATTRS.seats.phrase}?`, [a.slug, seats.record.slug], [goldOf('seats', seats.value.toString())], `"${a.stem} ${suffix}" occurs on no page; ${a.name} (${a.slug}) does`);
  }
  for (const [ca, cb] of w.lookalikes.companies) {
    const oa = org(ca), ob = org(cb);
    const kind = COMPANY_KINDS.find(k => k.suffix !== oa.suffix && k.suffix !== ob.suffix && absentFromWorld(corpus, `${oa.stem} ${k.suffix}`))!;
    const name = `${oa.stem} ${kind.suffix}`;
    absent(name, `Who founded ${name}?`, [ca, cb], [oa, ob].flatMap(o => (o.founder ? [nameValue(person(o.founder).name)] : [])), `"${name}" occurs on no page; ${oa.name} and ${ob.name} do`);
  }
  const people = rng.shuffle([...w.people.values()].filter(p => !lookalikePeople.has(p.slug) && currentStint(p) && currentStint(p)!.role !== 'vendor'));
  for (let i = 0; i + 1 < people.length && i < 80; i += 2) {
    const pa = people[i]!, pb = people[i + 1]!;
    const name = `${pa.first} ${pb.last}`;
    absent(name, `Which company does ${name} work with?`, [pa.slug, pb.slug], [nameValue(org(currentStint(pa)!.org).name), nameValue(org(currentStint(pb)!.org).name)], `"${name}" occurs on no page; ${pa.name} and ${pb.name} do`);
  }
  return drafts;
}

export function generateQueryV3(knobs: V3Knobs = DEFAULT_V3_KNOBS): SkillGenerationV3 {
  return assembleV3('query', QUERY_V3_SEED, knobs, queryV3Drafts(loadWorldV3(knobs), new Rng(QUERY_V3_SEED)), QUERY_V3_QUOTAS, { heldOut: QUERY_V3_HELD_OUT });
}
