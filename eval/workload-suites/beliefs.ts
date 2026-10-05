/**
 * B4 beliefs: who holds a view, how sure they are and whether their
 * predictions came true, reported by the user in ordinary chat.
 *
 * Each history has five people and ten propositions about fictional events
 * ("the Harbor Line extension will open before June"). Over its sessions the
 * user mentions who thinks what, who disagrees or is undecided, people's
 * stated confidence and how it changes, and predictions that later resolve
 * one way or the other or stay open. Six questions per history:
 *
 *   holder (2)          "Who thinks the Harbor Line extension will open
 *                       before June?" Gold: everyone stated to hold the view;
 *                       people who doubt it or are undecided are distractors.
 *   weight change (2)   "How did Dana's confidence that ... change?" Gold:
 *                       the first and the last stated percentage. Another
 *                       person's numbers on the same proposition are
 *                       distractors.
 *   resolved set (1)    "Which of Dana's predictions came true?" Gold: the
 *                       predictions that resolved true; ones that resolved
 *                       false or are still open must not be named.
 *   resolved one (1)    "Did Raj's prediction that ... come true?" Gold:
 *                       yes, no or not yet.
 *
 * Deterministic and template based; no model is called.
 */
import { Rng, addDays } from '../generators/seeded.ts';
import { STUB_ABSTAIN, contextBlocks, containsValue, escapeRegex, isAbstention, isoAt, makeDocument, opaqueId, scoreGold } from './common.ts';
import { fillerSession } from './filler.ts';
import type { ChatMessage, HarnessDocument, HarnessQuery, ScoreResult, ScorerLabel, SuiteBundle, SuiteDefinition } from './types.ts';

export const BELIEFS_VERSION = 'beliefs-v1';
export const BELIEFS_SEED = 20261008;
export const BELIEFS_SIZES = { full: { histories: 25 }, smoke: { histories: 3 } } as const;

export interface Proposition { key: string; clause: string; yes: string; no: string }

/**
 * `clause` follows "thinks"; `yes`/`no` are past-tense outcomes. `key` is the
 * short name a set answer is matched on; it occurs in the clause and in both
 * outcomes, so any faithful paraphrase of the prediction names it.
 */
export const PROPOSITIONS: readonly Proposition[] = [
  { key: 'Harbor Line', clause: 'the Harbor Line extension will open before June', yes: 'the Harbor Line extension opened before June', no: 'the Harbor Line extension missed its June opening' },
  { key: 'Nimbus Labs', clause: 'Nimbus Labs will close its Series B this year', yes: 'Nimbus Labs closed its Series B', no: 'Nimbus Labs failed to close its Series B' },
  { key: 'bike lane', clause: 'the city council will approve the bike lane plan', yes: 'the city council approved the bike lane plan', no: 'the city council rejected the bike lane plan' },
  { key: 'Atlas release', clause: 'the Atlas release will ship by the end of the quarter', yes: 'the Atlas release shipped by the end of the quarter', no: 'the Atlas release slipped past the end of the quarter' },
  { key: 'Orchard Street bakery', clause: 'the Orchard Street bakery will reopen this spring', yes: 'the Orchard Street bakery reopened this spring', no: 'the Orchard Street bakery stayed closed this spring' },
  { key: 'Reykjavik', clause: 'Kestrel Air will add a direct route to Reykjavik', yes: 'Kestrel Air added a direct route to Reykjavik', no: 'Kestrel Air dropped its plans for a Reykjavik route' },
  { key: 'Millbrook', clause: 'the two Millbrook hospitals will merge', yes: 'the two Millbrook hospitals merged', no: 'the Millbrook hospital merger fell apart' },
  { key: 'Pinecrest', clause: 'the Pinecrest stadium renovation will finish on time', yes: 'the Pinecrest stadium renovation finished on time', no: 'the Pinecrest stadium renovation ran late' },
  { key: 'Lumen Tablet', clause: 'the Lumen Tablet will launch under three hundred dollars', yes: 'the Lumen Tablet launched under three hundred dollars', no: 'the Lumen Tablet launched above three hundred dollars' },
  { key: 'river cleanup', clause: 'the river cleanup will get its state grant', yes: 'the river cleanup got its state grant', no: 'the river cleanup was denied its state grant' },
  { key: 'Halverson', clause: 'Mayor Halverson will win reelection', yes: 'Mayor Halverson won reelection', no: 'Mayor Halverson lost the reelection' },
  { key: 'Copperfield', clause: 'Copperfield will move its office downtown', yes: 'Copperfield moved its office downtown', no: 'Copperfield decided against moving downtown' },
  { key: 'Lantern Prize', clause: "Tobias Wrenfield's novel will win the Lantern Prize", yes: "Tobias Wrenfield's novel won the Lantern Prize", no: "Tobias Wrenfield's novel lost the Lantern Prize" },
  { key: 'farmers market', clause: 'the Saturday farmers market will expand to Sundays', yes: 'the farmers market expanded to Sundays', no: 'the farmers market stayed Saturday-only' },
  { key: 'Ferrovia', clause: 'the Ferrovia rail strike will end within a month', yes: 'the Ferrovia rail strike ended within a month', no: 'the Ferrovia rail strike dragged on past a month' },
  { key: 'Quarry Hill', clause: 'the Quarry Hill rezoning will pass', yes: 'the Quarry Hill rezoning passed', no: 'the Quarry Hill rezoning failed' },
];

const PEOPLE = ['Dana', 'Raj', 'Marisol', 'Theo', 'Ingrid', 'Kofi', 'Beatrix', 'Hiroshi', 'Lucia', 'Omar', 'Petra', 'Silas', 'Yusuf', 'Greta', 'Anika', 'Desmond', 'Fiona', 'Joaquin', 'Nadia', 'Wesley'];

const FOR = '{P} thinks {C}.';
const AGAINST = "{P} doesn't believe {C}.";
const UNSURE = '{P} is undecided on whether {C}.';
const CONF = "{P} puts the odds that {C} at {N} percent.";
const PREDICT = '{P} predicted that {C}.';
const RESOLVED = 'It is settled now: {O}.';

type BeliefSpec =
  | { kind: 'holder'; clause: string }
  | { kind: 'weight'; person: string; clause: string }
  | { kind: 'resolved_set'; person: string; candidates: Array<{ key: string; clause: string; yes: string; no: string }> }
  | { kind: 'resolved_one'; person: string; clause: string; yes: string; no: string };

const fillT = (t: string, b: Record<string, string>) => t.replace(/\{(\w)\}/g, (_, k: string) => b[k]!);

export function generateBeliefs(opts: { seed?: number; smoke?: boolean; histories?: number } = {}): SuiteBundle {
  const seed = opts.seed ?? BELIEFS_SEED;
  const smoke = opts.smoke ?? false;
  const histories = opts.histories ?? (smoke ? BELIEFS_SIZES.smoke.histories : BELIEFS_SIZES.full.histories);
  const rng = new Rng(seed);
  const documents: HarnessDocument[] = [];
  const queries: HarnessQuery[] = [];
  const labels: ScorerLabel[] = [];
  for (const p of PROPOSITIONS) {
    if (![p.clause, p.yes, p.no].every(t => containsValue(t, p.key))) throw new Error(`beliefs: key "${p.key}" must occur in the clause and both outcomes`);
  }

  for (let h = 0; h < histories; h++) {
    const user = opaqueId('blu', seed, h);
    const cast = rng.shuffle(PEOPLE).slice(0, 5);
    const props = rng.shuffle(PROPOSITIONS).slice(0, 10);
    // Statements are (session index, sentence); sessions are filled later.
    const nSessions = smoke ? 16 : 48;
    const stmts: Array<{ session: number; text: string; tag: string }> = [];
    const at = (lo: number, hi: number) => rng.int(lo, hi);
    const qs: Array<{ category: string; query: string; spec: BeliefSpec; gold: ScorerLabel['gold']; tags: string[]; distractors: string[] }> = [];

    // Holder questions: props[0], props[1].
    for (const p of props.slice(0, 2)) {
      const people = rng.shuffle(cast);
      const nFor = rng.int(1, 2);
      const holders = people.slice(0, nFor);
      const against = people.slice(nFor, nFor + rng.int(1, 2));
      const unsure = people.slice(nFor + against.length, nFor + against.length + 1);
      const tags: string[] = [];
      for (const x of holders) { const tag = `hold:${p.key}:${x}`; stmts.push({ session: at(0, nSessions - 1), text: fillT(FOR, { P: x, C: p.clause }), tag }); tags.push(tag); }
      for (const x of against) { const tag = `against:${p.key}:${x}`; stmts.push({ session: at(0, nSessions - 1), text: fillT(AGAINST, { P: x, C: p.clause }), tag }); tags.push(tag); }
      for (const x of unsure) { const tag = `unsure:${p.key}:${x}`; stmts.push({ session: at(0, nSessions - 1), text: fillT(UNSURE, { P: x, C: p.clause }), tag }); tags.push(tag); }
      qs.push({ category: 'holder', query: `Who thinks ${p.clause}?`, spec: { kind: 'holder', clause: p.clause }, gold: { kind: 'set', values: [...holders].sort(), universe: cast }, tags, distractors: [...against, ...unsure] });
    }
    // Weight-change questions: props[2], props[3].
    for (const p of props.slice(2, 4)) {
      const [who, other] = rng.shuffle(cast);
      const steps = rng.int(2, 3);
      const used = new Set<number>();
      const pct = () => { for (;;) { const v = 5 * rng.int(2, 19); if (!used.has(v)) { used.add(v); return v; } } };
      const mine = Array.from({ length: steps }, pct);
      const theirs = [pct()];
      const sessions = rng.shuffle(Array.from({ length: nSessions }, (_, i) => i)).slice(0, steps).sort((a, b) => a - b);
      const tags: string[] = [];
      mine.forEach((v, i) => { const tag = `conf:${p.key}:${who}:${i}`; stmts.push({ session: sessions[i]!, text: fillT(CONF, { P: who!, C: p.clause, N: String(v) }), tag }); tags.push(tag); });
      const otherTag = `conf:${p.key}:${other}:0`;
      stmts.push({ session: at(0, nSessions - 1), text: fillT(CONF, { P: other!, C: p.clause, N: String(theirs[0]) }), tag: otherTag });
      tags.push(otherTag);
      qs.push({
        category: 'weight_change', query: `How did ${who}'s confidence that ${p.clause} change over time?`,
        spec: { kind: 'weight', person: who!, clause: p.clause },
        gold: { kind: 'change', from: String(mine[0]), to: String(mine[mine.length - 1]) }, tags, distractors: theirs.map(String),
      });
    }
    // Resolved-set question: one person's predictions on props[4..6], plus another person's true prediction on props[7].
    {
      const [who, other] = rng.shuffle(cast);
      const outcomes = rng.shuffle(['true', rng.float() < 0.5 ? 'true' : 'false', rng.float() < 0.5 ? 'false' : 'open'] as const);
      const tags: string[] = [];
      const trueKeys: string[] = [];
      props.slice(4, 7).forEach((p, i) => {
        const s = at(0, nSessions - 4);
        const tag = `pred:${p.key}:${who}`;
        stmts.push({ session: s, text: fillT(PREDICT, { P: who!, C: p.clause }), tag });
        tags.push(tag);
        const o = outcomes[i]!;
        if (o !== 'open') { const rtag = `res:${p.key}`; stmts.push({ session: at(s + 1, nSessions - 1), text: fillT(RESOLVED, { O: o === 'true' ? p.yes : p.no }), tag: rtag }); tags.push(rtag); }
        if (o === 'true') trueKeys.push(p.key);
      });
      const p7 = props[7]!;
      const s7 = at(0, nSessions - 4);
      stmts.push({ session: s7, text: fillT(PREDICT, { P: other!, C: p7.clause }), tag: `pred:${p7.key}:${other}` });
      stmts.push({ session: at(s7 + 1, nSessions - 1), text: fillT(RESOLVED, { O: p7.yes }), tag: `res:${p7.key}` });
      qs.push({
        category: 'resolved_set', query: `Which of ${who}'s predictions came true?`,
        spec: { kind: 'resolved_set', person: who!, candidates: props.slice(4, 8).map(p => ({ key: p.key, clause: p.clause, yes: p.yes, no: p.no })) },
        gold: { kind: 'set', values: trueKeys.sort(), universe: props.slice(4, 8).map(p => p.key) },
        tags, distractors: props.slice(4, 8).map(p => p.key).filter(k => !trueKeys.includes(k)),
      });
    }
    // Resolved-one question: props[8], with props[9] as a resolved prediction by someone else.
    {
      const [who, other] = rng.shuffle(cast);
      const p = props[8]!;
      const o = rng.pick(['yes', 'no', 'not yet'] as const);
      const s = at(0, nSessions - 4);
      const tags = [`pred:${p.key}:${who}`];
      stmts.push({ session: s, text: fillT(PREDICT, { P: who!, C: p.clause }), tag: tags[0]! });
      if (o !== 'not yet') { stmts.push({ session: at(s + 1, nSessions - 1), text: fillT(RESOLVED, { O: o === 'yes' ? p.yes : p.no }), tag: `res:${p.key}` }); tags.push(`res:${p.key}`); }
      const p9 = props[9]!;
      const s9 = at(0, nSessions - 4);
      stmts.push({ session: s9, text: fillT(PREDICT, { P: other!, C: p9.clause }), tag: `pred:${p9.key}:${other}` });
      stmts.push({ session: at(s9 + 1, nSessions - 1), text: fillT(RESOLVED, { O: rng.float() < 0.5 ? p9.yes : p9.no }), tag: `res:${p9.key}` });
      qs.push({
        category: 'resolved_one', query: `Did ${who}'s prediction that ${p.clause} come true?`,
        spec: { kind: 'resolved_one', person: who!, clause: p.clause, yes: p.yes, no: p.no },
        gold: { kind: 'verdict', verdict: o }, tags, distractors: [],
      });
    }

    // Build sessions: filler plus the statements placed in each, one statement per user turn.
    let day = `2025-${String(rng.int(1, 4)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
    const docIds: string[] = [];
    const tagDoc = new Map<string, string>();
    const tagText = new Map<string, string>();
    for (let s = 0; s < nSessions; s++) {
      const mine = stmts.filter(x => x.session === s);
      const messages: ChatMessage[] = fillerSession(rng, rng.int(4, 7), rng.int(1, 2));
      for (const st of mine) {
        const intro = rng.pick(['Catching up on people:', 'Something from the group chat:', 'Overheard at lunch today:', 'Talked to friends earlier.', 'News roundup:']);
        const at2 = 2 * rng.int(1, messages.length / 2);
        messages.splice(at2, 0, { role: 'user', content: `${intro} ${st.text}` }, { role: 'assistant', content: 'Interesting, thanks for sharing.' });
      }
      const id = opaqueId('bld', seed, h, s);
      docIds.push(id);
      for (const st of mine) { tagDoc.set(st.tag, id); tagText.set(st.tag, st.text); }
      documents.push(makeDocument(id, user, isoAt(day, rng.int(8 * 60, 21 * 60)), messages));
      day = addDays(day, rng.int(1, 5));
    }
    const queryTs = isoAt(addDays(day, 2), 12 * 60);
    for (const q of qs) {
      const qid = opaqueId('blq', seed, h, q.category, q.query);
      const oracle = [...new Set(q.tags.map(t => tagDoc.get(t)!))];
      const goldAnswer = q.gold.kind === 'set' ? q.gold.values.join('; ') : q.gold.kind === 'change' ? `from ${q.gold.from} percent to ${q.gold.to} percent` : q.gold.kind === 'verdict' ? q.gold.verdict : '';
      queries.push({ id: qid, query: q.query, gold_ids: oracle, gold_answers: [goldAnswer], user_id: user, meta: { query_timestamp: queryTs, category: q.category } });
      labels.push({
        query_id: qid, suite: 'beliefs', category: q.category, spec: q.spec as unknown as Record<string, unknown>, gold: q.gold,
        oracle_doc_ids: oracle,
        needles: q.tags.map(t => ({ doc_id: tagDoc.get(t)!, text: tagText.get(t)!, value: tagText.get(t)! })),
        distractors: q.distractors.map(v => ({ doc_id: '', value: v, kind: q.category })),
        negative: false,
      });
    }
  }
  return {
    suite: 'beliefs', version: BELIEFS_VERSION, seed, smoke, documents, queries, labels, extra: {},
    timestamp_provenance: 'observed_session_time: each conversation carries the time it happened; the order of confidence statements and resolutions is the order of those times.',
  };
}

// ─── Offline reader and scorer ────────────────────────────────────────────

function sortedBlocks(context: string) {
  return contextBlocks(context).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

export function beliefsStubAnswer(label: ScorerLabel, context: string): string {
  const spec = label.spec as unknown as BeliefSpec;
  const text = sortedBlocks(context).map(b => b.text).join('\n');
  switch (spec.kind) {
    case 'holder': {
      const names = [...text.matchAll(new RegExp(`([A-Z][a-z]+) thinks ${escapeRegex(spec.clause)}\\.`, 'g'))].map(m => m[1]!);
      return names.length ? [...new Set(names)].sort().join('; ') : STUB_ABSTAIN;
    }
    case 'weight': {
      const nums = [...text.matchAll(new RegExp(`${spec.person} puts the odds that ${escapeRegex(spec.clause)} at (\\d+) percent`, 'g'))].map(m => m[1]!);
      if (!nums.length) return STUB_ABSTAIN;
      return nums.length === 1 ? `${nums[0]} percent, no change recorded` : `from ${nums[0]} percent to ${nums[nums.length - 1]} percent`;
    }
    case 'resolved_set': {
      const hits = spec.candidates.filter(c => text.includes(`${spec.person} predicted that ${c.clause}.`) && text.includes(`It is settled now: ${c.yes}.`)).map(c => c.key);
      const predicted = spec.candidates.some(c => text.includes(`${spec.person} predicted that ${c.clause}.`));
      return hits.length ? hits.join('; ') : predicted ? 'None of them so far' : STUB_ABSTAIN;
    }
    case 'resolved_one': {
      if (!text.includes(`${spec.person} predicted that ${spec.clause}.`)) return STUB_ABSTAIN;
      if (text.includes(`It is settled now: ${spec.yes}.`)) return 'yes';
      if (text.includes(`It is settled now: ${spec.no}.`)) return 'no';
      return 'not yet';
    }
  }
}

const NOT_YET = /\b(not yet|unresolved|still open|hasn'?t (?:been )?(?:settled|resolved)|too early|pending|remains open)\b/i;
const NO = /\b(no|did not|didn'?t|was wrong|false|failed|did not come true)\b/i;
const YES = /\b(yes|came true|was right|correct|it did)\b/i;

export function verdictOf(answer: string): 'yes' | 'no' | 'not yet' | null {
  if (NOT_YET.test(answer)) return 'not yet';
  if (NO.test(answer)) return 'no';
  if (YES.test(answer)) return 'yes';
  return null;
}

export function scoreBelief(label: ScorerLabel, answer: string): ScoreResult {
  const g = label.gold;
  if (g.kind === 'change') {
    const hasFrom = containsValue(answer, g.from);
    const hasTo = containsValue(answer, g.to);
    const wrong = label.distractors.map(d => d.value).filter(v => containsValue(answer, v));
    if (hasFrom && hasTo && !wrong.length) return { outcome: 'correct', matched: [g.from, g.to] };
    if (wrong.length) return { outcome: 'distractor', matched: wrong };
    return { outcome: isAbstention(answer) ? 'abstain' : 'wrong', matched: [g.from, g.to].filter(v => containsValue(answer, v)) };
  }
  if (g.kind === 'verdict') {
    if (isAbstention(answer) && !NOT_YET.test(answer)) return { outcome: 'abstain', matched: [] };
    const v = verdictOf(answer);
    return { outcome: v === g.verdict ? 'correct' : 'wrong', matched: v ? [v] : [] };
  }
  return scoreGold(g, answer, label.distractors.map(d => d.value));
}

export const beliefs: SuiteDefinition = {
  id: 'beliefs',
  version: BELIEFS_VERSION,
  defaultSeed: BELIEFS_SEED,
  describe: 'B4: who holds a view, how their stated confidence changed, and which predictions came true.',
  generate: ({ seed, smoke }) => generateBeliefs({ seed, smoke }),
  stubAnswer: beliefsStubAnswer,
  score: scoreBelief,
};
