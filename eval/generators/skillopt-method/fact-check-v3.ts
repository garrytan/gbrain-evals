/**
 * fact-check task set for skillopt-method-v3 (GBEV-30, plan section 2), over
 * world-v3. Each task is one data-derived claim. Trained families (train,
 * sel, gate, test):
 *
 *   superseded         an account's term as of a date, stated with a value
 *                      another record holds (superseded, signed but not yet in
 *                      force, or rescinded), contradicted; or stated with the
 *                      value in force on the date while a later record holds
 *                      another, supported (about half the family)
 *   compound           two or three terms of one account as of one date, each
 *                      part right or wrong; the report gives a status per part
 *                      (or one for the whole claim) and the value the brain
 *                      holds for each wrong part
 *   not-founder        per company, "P founded C" where P only works or
 *                      worked at C (a later chief executive when there is one,
 *                      else an officer or a team member), contradicted, with
 *                      the real founder; and the real founder's claim,
 *                      supported, except for a company with a look-alike
 *                      name, where lookalike-founder makes that claim
 *   absent             a claim about an entity no page carries, built from a
 *                      real one; the brain cannot support it
 *
 * Held-out families (gate and test only):
 *
 *   role-on-date       "On D, P was C's chief executive" (or chief technology
 *                      officer), right or wrong, when the role changed hands
 *   three-hop          "X founded the company that acquired (or alone
 *                      backed) the company P works with", right or naming the
 *                      second hop's founder
 *   lookalike-founder  a founding claim about a company that shares a stem
 *                      with another, or naming a near-name person
 *
 * Usage: generated through eval/generators/skillopt-method/gen.ts.
 */
import { Rng } from '../seeded.ts';
import {
  absentFromWorld, acquirerFromText, assembleV3, careerFromText, founderFromText, goldOf, loadWorldV3, nameValue, possessive, roleHolderFromText, soleInvestorFromText,
  stintFromText, valueFromText, type CandidateV3, type DraftV3, type SkillGenerationV3, type WorldCorpus,
} from './common-v3.ts';
import {
  addDays, ATTR_IDS, ATTRS, chainEnd, currentStint, daysBetween, DEFAULT_V3_KNOBS, longDate, valueAt, WORLD_NOW, type AttrId, type AttrValue, type Org, type V3Knobs,
} from './world-v3.ts';
import { ACCOUNT_SUFFIXES, COMPANY_KINDS } from './world-v3-banks.ts';
import type { PartKey, PartSpec } from '../../runner/skillopt-method/score-v3.ts';
import type { GoldValue, StatusClass } from '../../runner/skillopt-method/score.ts';

export const FACT_CHECK_V3_SEED = 30_013;
export const FACT_CHECK_V3_QUOTAS = {
  superseded: [6, 6, 5, 12],
  compound: [6, 6, 5, 12],
  'not-founder': [6, 6, 4, 12],
  absent: [6, 6, 4, 12],
  'role-on-date': [0, 0, 6, 16],
  'three-hop': [0, 0, 6, 16],
  'lookalike-founder': [0, 0, 6, 16],
} as const;
export const FACT_CHECK_V3_HELD_OUT = ['role-on-date', 'three-hop', 'lookalike-founder'] as const;
const COMPOUND_ATTRS: readonly (AttrId & PartKey)[] = ['seats', 'price', 'discount', 'notice', 'payment', 'tier'];

export const taskTextV3 = (claim: string) => `Fact-check this claim before it ships. A gbrain pipeline produced it from the brain, so it is a data-derived claim.\n\nCLAIM: ${claim}`;

const LABEL: Readonly<Record<StatusClass, string>> = { supported: '✅ VERIFIED', contradicted: '❌ FALSE', 'not-supported': '🤷 UNVERIFIED' };

interface Block { claim: string; status: StatusClass; source: string; correct?: string }
/** The seed's report: Corrections Applied, then one [N] CLAIM: block per part, each with one STATUS: line. */
function report(blocks: readonly Block[]): string {
  const corrections = blocks.filter(b => b.correct).map((b, i) => `${i + 1}. ${b.claim} — was: as claimed, now: ${b.correct}, source: ${b.source}`);
  return [
    '# Fact-Check Report: data-derived claim', '',
    ...(corrections.length ? ['## Corrections Applied', ...corrections, ''] : []),
    '## Full Claim-by-Claim Report',
    ...blocks.map((b, i) => [`[${i + 1}] CLAIM: ${b.claim}`, 'LANE: data-derived', `STATUS: ${LABEL[b.status]}`, `SOURCE: ${b.source}`, `NOTES: ${b.correct ? `Correct value: ${b.correct}.` : b.status === 'not-supported' ? 'The brain has no page for what the claim names.' : 'The page in force confirms it.'}`, ''].join('\n')),
  ].join('\n').trim();
}

export function factCheckV3Drafts(corpus: WorldCorpus, rng: Rng): DraftV3[] {
  const { world: w, pages } = corpus;
  const drafts: DraftV3[] = [];
  const org = (s: string) => w.orgs.get(s)!;
  const person = (s: string) => w.people.get(s)!;
  const accounts = [...w.orgs.values()].filter(o => o.kind === 'account');
  const companies = [...w.orgs.values()].filter(o => o.kind === 'company');
  const ok = (candidate: CandidateV3, priority = 0) => drafts.push({ ok: true, candidate, priority });
  const single = (status: StatusClass, correct?: GoldValue): PartSpec[] => [{ key: null, status, ...(correct ? { correct } : {}) }];

  /** A date in each value interval of a term, with the trap it sets. */
  const datesOf = (a: Org, attr: AttrId) => {
    const chain = w.chains.get(a.slug)!;
    const last = [addDays(WORLD_NOW, -2), chainEnd(chain)].sort()[0]!;
    const changes = [...new Set(chain.flatMap(c => [c.effective, c.signed]))].sort();
    const out: string[] = [];
    for (const c of chain) {
      const d = addDays(c.kind === 'renewal' && c.signed < c.effective && daysBetween(c.signed, c.effective) > 8 && rng.float() < 0.5 ? c.signed : c.effective, rng.int(4, 40));
      if (d <= last && changes.every(x => Math.abs(daysBetween(x, d)) >= 3)) out.push(d);
    }
    return [...new Set(out)].sort();
  };
  const decide = (a: Org, attr: AttrId, date: string) => {
    const chain = w.chains.get(a.slug)!;
    const g = valueAt(chain, attr, date)!;
    const o = valueFromText(pages, a.slug, attr, date);
    if (!o || String(o.value) !== String(g.value) || o.slug !== g.record.slug) return null;
    return { value: g.value, slugs: [g.record.slug, ...(o.rescission ? [o.rescission] : [])], evidence: o.evidence, others: [...new Set(chain.flatMap(c => (attr in c.sets ? [String(c.sets[attr]!)] : [])))].filter(v => v !== String(g.value)) };
  };
  const fromString = (attr: AttrId, s: string): AttrValue => (attr === 'renewal_date' || attr === 'tier' ? s : Number(s));

  // superseded
  for (const a of accounts) for (const attr of ATTR_IDS) for (const date of datesOf(a, attr)) {
    const anchor = `claim:${a.slug}:${attr}@${date}`;
    const d = decide(a, attr, date);
    if (!d) { drafts.push({ ok: false, family: 'superseded', anchor, reason: 'oracle: the contract pages disagree with the chain' }); continue; }
    if (!d.others.length) continue;
    const later = w.chains.get(a.slug)!.filter(c => c.effective > date && attr in c.sets && String(c.sets[attr]) !== String(d.value));
    const right = later.length > 0 && rng.float() < 0.7;
    const claimed = right ? d.value : fromString(attr, rng.pick(d.others));
    if (attr === 'renewal_date' && (claimed === date || d.value === date)) continue;
    const claim = `As of ${longDate(date)}, ${possessive(a.name)} ${ATTRS[attr].phrase} was ${ATTRS[attr].cell(claimed)}.`;
    const correct = goldOf(attr, d.value);
    const status: StatusClass = right ? 'supported' : 'contradicted';
    ok({
      family: 'superseded', task: taskTextV3(claim), anchor: { kind: 'claim', id: anchor },
      fact_keys: [`val:${a.slug}:${attr}@${d.slugs[0]}`], answerable: true,
      gold: { values: right ? [] : [correct], slugs: d.slugs, cite: [d.slugs], status, spec: { kind: 'fact-check', status, parts: single(status, right ? undefined : correct), cite: [d.slugs] } },
      distractors: { slugs: w.chains.get(a.slug)!.filter(c => !d.slugs.includes(c.slug) && attr in c.sets).map(c => c.slug), values: right ? [] : [goldOf(attr, claimed)] },
      source: `world-v3 ${a.slug} contract chain, ${attr} on ${date}`,
      oracle: right
        ? { path: 'the contract pages the account lists: the latest record in force on the date that sets the term, rescinded records dropped; a later record sets another value', evidence: `${d.evidence}\nLater: ${later.map(c => `${c.title}, effective ${longDate(c.effective)}: ${ATTRS[attr].cell(c.sets[attr]!)}`).join('; ')}` }
        : { path: 'the contract pages the account lists: the latest record in force that sets the term, rescinded records dropped', evidence: d.evidence },
      oracle_answer: report([{ claim, status, source: d.slugs.join(', '), ...(right ? {} : { correct: ATTRS[attr].cell(d.value) }) }]),
    }, 1);
  }

  // compound: two or three terms on one date, each part right or wrong.
  for (const a of accounts) {
    const chain = w.chains.get(a.slug)!;
    const varied = COMPOUND_ATTRS.filter(x => new Set(chain.flatMap(c => (x in c.sets ? [String(c.sets[x])] : []))).size > 1);
    for (const date of datesOf(a, 'seats')) {
      const n = rng.int(2, 3);
      const attrs = [...rng.shuffle(varied).slice(0, n), ...rng.shuffle(COMPOUND_ATTRS.filter(x => !varied.includes(x)))].slice(0, n).sort((x, y) => ATTR_IDS.indexOf(x) - ATTR_IDS.indexOf(y));
      const anchor = `compound:${a.slug}@${date}`;
      const parts = attrs.map(attr => ({ attr, d: decide(a, attr, date) }));
      if (parts.some(p => !p.d)) { drafts.push({ ok: false, family: 'compound', anchor, reason: 'oracle: the contract pages disagree with the chain' }); continue; }
      const allRight = rng.float() < 0.35;
      const wrongCount = allRight ? 0 : rng.int(1, Math.min(2, parts.length));
      const wrongAttrs = new Set(rng.shuffle(parts.filter(p => p.d!.others.length).map(p => p.attr)).slice(0, wrongCount));
      if (wrongAttrs.size !== wrongCount) continue;
      const claimed = parts.map(p => (wrongAttrs.has(p.attr) ? fromString(p.attr, rng.pick(p.d!.others)) : p.d!.value));
      const said = parts.map((p, i) => `${ATTRS[p.attr].phrase} was ${ATTRS[p.attr].cell(claimed[i]!)}`);
      const claim = `As of ${longDate(date)}, ${possessive(a.name)} ${said.slice(0, -1).join(', its ')} and its ${said.at(-1)}.`;
      const status: StatusClass = wrongCount ? 'contradicted' : 'supported';
      const groups = [...new Map(parts.map(p => [p.d!.slugs.join('|'), p.d!.slugs])).values()];
      const specParts: PartSpec[] = parts.map(p => ({ key: p.attr as PartKey, status: wrongAttrs.has(p.attr) ? 'contradicted' : 'supported', ...(wrongAttrs.has(p.attr) ? { correct: goldOf(p.attr, p.d!.value) } : {}) }));
      ok({
        family: 'compound', task: taskTextV3(claim), anchor: { kind: 'claim', id: anchor },
        fact_keys: parts.map(p => `val:${a.slug}:${p.attr}@${p.d!.slugs[0]}`), answerable: true,
        gold: { values: specParts.flatMap(p => (p.correct ? [p.correct] : [])), slugs: [...new Set(groups.flat())], cite: groups, status, spec: { kind: 'fact-check', status, parts: specParts, cite: groups } },
        distractors: { slugs: [], values: parts.flatMap((p, i) => (wrongAttrs.has(p.attr) ? [goldOf(p.attr, claimed[i]!)] : [])) },
        source: `world-v3 ${a.slug} contract chain, ${attrs.join(', ')} on ${date}`,
        oracle: { path: 'for each part, the contract pages the account lists: the latest record in force that sets the term, rescinded records dropped', evidence: parts.map(p => p.d!.evidence).join('\n') },
        oracle_answer: report(parts.map((p, i) => ({ claim: `As of ${longDate(date)}, ${possessive(a.name)} ${said[i]}.`, status: wrongAttrs.has(p.attr) ? 'contradicted' : 'supported', source: p.d!.slugs.join(', '), ...(wrongAttrs.has(p.attr) ? { correct: ATTRS[p.attr].cell(p.d!.value) } : {}) }))),
      }, groups.length + wrongCount);
    }
  }

  // not-founder: per company, the real founder's claim (left to lookalike-founder for a look-alike company), and one person who works or worked there claimed as its founder.
  const lookalikeCompanies = new Set(w.lookalikes.companies.flat());
  for (const c of companies) {
    if (!c.founder) continue;
    const f = founderFromText(pages, c.slug);
    const founderAnchor = `claim:founder:${c.slug}:${c.founder}`;
    if ('reason' in f || f.slug !== c.founder) { drafts.push({ ok: false, family: 'not-founder', anchor: founderAnchor, reason: 'reason' in f ? f.reason : 'the founding line names another person' }); continue; }
    const others = [...w.people.values()].filter(x => x.slug !== c.founder && x.stints.some(s => s.org === c.slug));
    const slugs = [c.slug, f.slug];
    const right = `${f.name} founded ${c.name}.`;
    if (!lookalikeCompanies.has(c.slug)) ok({
      family: 'not-founder', task: taskTextV3(right), anchor: { kind: 'claim', id: founderAnchor },
      fact_keys: [`founder:${c.slug}`], answerable: true,
      gold: { values: [], slugs, cite: [slugs], status: 'supported', spec: { kind: 'fact-check', status: 'supported', parts: single('supported'), cite: [slugs] } },
      distractors: { slugs: others.map(x => x.slug), values: [] },
      source: `world-v3 ${c.slug} founder`,
      oracle: { path: "the company's founding line, confirmed by the founder's page", evidence: f.evidence },
      oracle_answer: report([{ claim: right, status: 'supported', source: slugs.join(', ') }]),
    }, 1);
    if (!others.length) continue;
    const ceos = others.filter(x => c.ceo.some(t => t.person === x.slug));
    const p = rng.pick(ceos.length ? ceos : others);
    const anchor = `claim:founder:${c.slug}:${p.slug}`;
    if (!careerFromText(pages, p.slug).some(s => s.org === c.slug)) { drafts.push({ ok: false, family: 'not-founder', anchor, reason: `${p.slug}'s career list does not name ${c.slug}` }); continue; }
    const claim = `${p.name} founded ${c.name}.`;
    const correct = nameValue(f.name);
    ok({
      family: 'not-founder', task: taskTextV3(claim), anchor: { kind: 'claim', id: anchor },
      fact_keys: [`founder:${c.slug}`, `assoc:${p.slug}@${c.slug}`], answerable: true,
      gold: { values: [correct], slugs, cite: [slugs], status: 'contradicted', spec: { kind: 'fact-check', status: 'contradicted', parts: single('contradicted', correct), cite: [slugs] } },
      distractors: { slugs: [p.slug], values: [nameValue(p.name)] },
      source: `world-v3 ${c.slug} founder and ${p.slug}'s career`,
      oracle: { path: "the company's founding line, confirmed by the founder's page; the claimed person's career list names the company in another role", evidence: f.evidence },
      oracle_answer: report([{ claim, status: 'contradicted', source: slugs.join(', '), correct: f.name }]),
    }, ceos.length ? 2 : 1);
  }

  // absent
  const absent = (name: string, claim: string, nearMiss: string[], evidence: string) => {
    const anchor = `claim:absent:${name}`;
    if (!absentFromWorld(corpus, name) || [...w.orgs.values(), ...w.people.values()].some(e => e.name === name)) return drafts.push({ ok: false, family: 'absent', anchor, reason: `${name} occurs on a page` });
    return ok({
      family: 'absent', task: taskTextV3(claim), anchor: { kind: 'claim', id: anchor }, fact_keys: [`name:${name.toLowerCase()}`], answerable: false,
      gold: { values: [], slugs: [], subject: name, status: 'not-supported', spec: { kind: 'fact-check', status: 'not-supported', parts: single('not-supported'), cite: [] } },
      distractors: { slugs: nearMiss, values: [] },
      source: 'world-v3 absent name built from a real one', oracle: { path: 'absence of the full name from every page', evidence },
      oracle_answer: report([{ claim, status: 'not-supported', source: `no page for ${name}; nearest: ${nearMiss.join(', ')}` }]),
      near_miss: nearMiss,
    });
  };
  for (const a of rng.shuffle(accounts)) {
    const name = `${a.stem} ${rng.pick(ACCOUNT_SUFFIXES.filter(s => s !== a.suffix))}`;
    const chain = w.chains.get(a.slug)!;
    const date = addDays(chain[0]!.effective, rng.int(40, 300));
    const v = valueAt(chain, 'seats', date)!;
    absent(name, `As of ${longDate(date)}, ${possessive(name)} ${ATTRS.seats.phrase} was ${ATTRS.seats.cell(v.value)}.`, [a.slug, v.record.slug], `"${name}" occurs on no page; ${a.name} does`);
  }
  for (const [ca, cb] of w.lookalikes.companies) {
    const oa = org(ca), ob = org(cb);
    const kind = COMPANY_KINDS.find(k => k.suffix !== oa.suffix && k.suffix !== ob.suffix && absentFromWorld(corpus, `${oa.stem} ${k.suffix}`))!;
    const name = `${oa.stem} ${kind.suffix}`;
    absent(name, `${name} was founded by ${person(oa.founder!).name}.`, [ca, cb, oa.founder!], `"${name}" occurs on no page; ${oa.name} and ${ob.name} do`);
  }
  const lookalike = new Set([...w.lookalikes.homonyms.flat(), ...w.lookalikes.near.flat()]);
  const pool = rng.shuffle([...w.people.values()].filter(p => !lookalike.has(p.slug) && currentStint(p) && currentStint(p)!.role !== 'vendor'));
  for (let i = 0; i + 2 < pool.length && i < 90; i += 3) {
    const pa = pool[i]!, pb = pool[i + 1]!, c = org(currentStint(pool[i + 2]!)!.org);
    const name = `${pa.first} ${pb.last}`;
    absent(name, `${name} is the ${currentStint(pool[i + 2]!)!.title} at ${c.name}.`, [pa.slug, pb.slug, c.slug], `"${name}" occurs on no page; ${pa.name}, ${pb.name} and ${c.name} do`);
  }

  // role-on-date (held out)
  for (const c of companies) {
    for (const [label, key, tenures] of [['Chief executive', 'chief executive', c.ceo], ['Chief technology officer', 'chief technology officer', c.cto]] as const) {
      if (tenures.length < 2) continue;
      tenures.forEach((t, i) => {
        const end = t.end ?? addDays(WORLD_NOW, -2);
        if (daysBetween(t.start, end) < 60) return;
        const date = addDays(t.start, rng.int(20, daysBetween(t.start, end) - 20));
        const anchor = `claim:role:${c.slug}:${key}@${date}`;
        const o = roleHolderFromText(pages, c.slug, label, date);
        if ('reason' in o || o.slug !== t.person) return drafts.push({ ok: false, family: 'role-on-date', anchor, reason: 'reason' in o ? o.reason : 'the page names another holder' });
        const wrong = rng.float() < 0.5 ? tenures.find(x => x !== t) : undefined;
        const named = wrong ? person(wrong.person) : person(t.person);
        const claim = `On ${longDate(date)}, ${named.name} was ${possessive(c.name)} ${key}.`;
        const status: StatusClass = wrong ? 'contradicted' : 'supported';
        const correct = nameValue(o.name);
        const slugs = [c.slug, t.person];
        return ok({
          family: 'role-on-date', task: taskTextV3(claim), anchor: { kind: 'claim', id: anchor },
          fact_keys: [`role:${c.slug}:${key}:${t.person}`], answerable: true,
          gold: { values: wrong ? [correct] : [], slugs, cite: [slugs], status, spec: { kind: 'fact-check', status, parts: single(status, wrong ? correct : undefined), cite: [slugs] } },
          distractors: { slugs: wrong ? [wrong.person] : [], values: wrong ? [nameValue(named.name)] : [] },
          source: `world-v3 ${c.slug} ${key} tenures`,
          oracle: { path: "the company page's leadership line, read for the tenure covering the date, confirmed by the holder's career list", evidence: o.evidence },
          oracle_answer: report([{ claim, status, source: slugs.join(', '), ...(wrong ? { correct: o.name } : {}) }]),
        }, wrong ? 2 : 1);
      });
    }
  }

  // three-hop (held out)
  for (const p of w.people.values()) {
    const cur = currentStint(p);
    if (!cur || lookalike.has(p.slug)) continue;
    const c = org(cur.org);
    if (c.kind !== 'company' || c.founder === p.slug || !c.founder) continue;
    const hops: Array<{ target: Org; phrase: string; key: string; evidence: string }> = [];
    if (c.acquiredBy) { const acq = acquirerFromText(pages, c.slug); if (!('reason' in acq) && acq.slug === c.acquiredBy.org) hops.push({ target: org(acq.slug), phrase: 'the company that acquired', key: `acq:${c.slug}`, evidence: acq.evidence }); }
    if (c.investors.length === 1) { const inv = soleInvestorFromText(pages, c.slug); if (!('reason' in inv)) hops.push({ target: org(inv.slug), phrase: 'the venture firm that invested in', key: `inv:${c.slug}`, evidence: inv.evidence }); }
    for (const h of hops) {
      const anchor = `claim:three-hop:${p.slug}:${h.target.slug}`;
      const first = stintFromText(pages, p.slug, WORLD_NOW);
      const f = founderFromText(pages, h.target.slug);
      if ('reason' in first || 'reason' in f || first.org !== c.slug) { drafts.push({ ok: false, family: 'three-hop', anchor, reason: 'a hop does not read out of the pages' }); continue; }
      const wrong = rng.float() < 0.55;
      const named = wrong ? person(c.founder).name : f.name;
      const claim = `${named} founded ${h.phrase} the company ${p.name} works with.`;
      const status: StatusClass = wrong ? 'contradicted' : 'supported';
      const correct = nameValue(f.name);
      const slugs = [h.target.slug, f.slug];
      ok({
        family: 'three-hop', task: taskTextV3(claim), anchor: { kind: 'claim', id: anchor },
        fact_keys: [`founder:${h.target.slug}`, h.key, `works:${p.slug}@${c.slug}`], answerable: true,
        gold: { values: wrong ? [correct] : [], slugs, cite: [slugs], status, spec: { kind: 'fact-check', status, parts: single(status, wrong ? correct : undefined), cite: [slugs] } },
        distractors: { slugs: [c.slug, c.founder], values: wrong ? [nameValue(named)] : [] },
        source: `world-v3 ${p.slug} current stint, then ${h.target.slug}`,
        oracle: { path: "the person's career list (confirmed by the company page), the company's acquirer or only investor, and that firm's founding line confirmed by the founder's page", evidence: `${first.line}\n${h.evidence}\n${f.evidence}` },
        oracle_answer: report([{ claim, status, source: slugs.join(', '), ...(wrong ? { correct: f.name } : {}) }]),
      }, wrong ? 2 : 1);
    }
  }

  // lookalike-founder (held out): a near-name person, or a company sharing a stem.
  for (const [x, y] of w.lookalikes.near.flatMap(([a, b]) => [[a, b], [b, a]] as const)) {
    const founded = [...w.orgs.values()].find(o => o.founder === y);
    if (!founded) continue;
    const anchor = `claim:lookalike:${x}:${founded.slug}`;
    const f = founderFromText(pages, founded.slug);
    if ('reason' in f || f.slug !== y) { drafts.push({ ok: false, family: 'lookalike-founder', anchor, reason: 'the founding line does not read out of the pages' }); continue; }
    const claim = `${person(x).name} founded ${founded.name}.`;
    const correct = nameValue(f.name);
    const slugs = [founded.slug, y];
    ok({
      family: 'lookalike-founder', task: taskTextV3(claim), anchor: { kind: 'claim', id: anchor },
      fact_keys: [`founder:${founded.slug}`, `name:${person(x).name.toLowerCase()}`], answerable: true,
      gold: { values: [correct], slugs, cite: [slugs], status: 'contradicted', spec: { kind: 'fact-check', status: 'contradicted', parts: single('contradicted', correct), cite: [slugs] } },
      distractors: { slugs: [x], values: [nameValue(person(x).name)] },
      source: `world-v3 near-name pair ${x} / ${y}`,
      oracle: { path: "the company's founding line, confirmed by the founder's page", evidence: f.evidence },
      oracle_answer: report([{ claim, status: 'contradicted', source: slugs.join(', '), correct: f.name }]),
      near_miss: [x],
    }, 2);
  }
  for (const [ca, cb] of w.lookalikes.companies) for (const [x, y] of [[ca, cb], [cb, ca]] as const) {
    const ox = org(x), oy = org(y);
    const anchor = `claim:lookalike:${ox.slug}`;
    const f = founderFromText(pages, ox.slug);
    if ('reason' in f || f.slug !== ox.founder || !oy.founder) { drafts.push({ ok: false, family: 'lookalike-founder', anchor, reason: 'the founding line does not read out of the pages' }); continue; }
    const wrong = rng.float() < 0.6;
    const named = wrong ? person(oy.founder).name : f.name;
    const claim = `${named} founded ${ox.name}.`;
    const status: StatusClass = wrong ? 'contradicted' : 'supported';
    const correct = nameValue(f.name);
    const slugs = [ox.slug, f.slug];
    ok({
      family: 'lookalike-founder', task: taskTextV3(claim), anchor: { kind: 'claim', id: anchor },
      fact_keys: [`founder:${ox.slug}`], answerable: true,
      gold: { values: wrong ? [correct] : [], slugs, cite: [slugs], status, spec: { kind: 'fact-check', status, parts: single(status, wrong ? correct : undefined), cite: [slugs] } },
      distractors: { slugs: [oy.slug, oy.founder], values: wrong ? [nameValue(named)] : [] },
      source: `world-v3 companies sharing a stem: ${ox.slug} / ${oy.slug}`,
      oracle: { path: "the company's founding line, confirmed by the founder's page", evidence: f.evidence },
      oracle_answer: report([{ claim, status, source: slugs.join(', '), ...(wrong ? { correct: f.name } : {}) }]),
      near_miss: [oy.slug],
    }, wrong ? 2 : 1);
  }
  return drafts;
}

export function generateFactCheckV3(knobs: V3Knobs = DEFAULT_V3_KNOBS): SkillGenerationV3 {
  return assembleV3('fact-check', FACT_CHECK_V3_SEED, knobs, factCheckV3Drafts(loadWorldV3(knobs), new Rng(FACT_CHECK_V3_SEED)), FACT_CHECK_V3_QUOTAS, { heldOut: FACT_CHECK_V3_HELD_OUT });
}
