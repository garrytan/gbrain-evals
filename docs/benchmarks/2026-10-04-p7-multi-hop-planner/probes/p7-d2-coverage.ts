// P7 D2 probe (non-shipping): how much plan coverage does the fixed grammar leave on the table
// versus an LLM that emits typed plans over the same vocabulary? Paraphrases are written by a model,
// not by the grammar's author. world-v1 gold. Budget cap $2 (stops on estimate).
// Run from gbrain-evals: bun docs/benchmarks/2026-10-04-p7-multi-hop-planner/probes/p7-d2-coverage.ts <gbrain checkout> > d2.json  (SEED=99 for the check set)
const EVALS = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
import { loadWorldCorpus } from '../../../../eval/runner/queries/relational.ts';
const ROOT = process.argv[2] ?? '../gbrain';
const { parseRelationalPlan } = await import(ROOT + '/src/core/search/relational-plan.ts');
const { validateChainHops, linkFamily } = await import(ROOT + '/src/core/search/relational-chain.ts');
const MODEL = 'claude-sonnet-5-5';
const PRICE_IN = 3 / 1e6, PRICE_OUT = 15 / 1e6, CAP = 2;
let spent = 0;
async function claude(system: string, user: string, maxTokens = 600): Promise<string> {
  if (spent > CAP * 0.9) throw new Error(`budget cap reached ($${spent.toFixed(3)})`);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300));
  spent += j.usage.input_tokens * PRICE_IN + j.usage.output_tokens * PRICE_OUT;
  return j.content.map((c: any) => c.text ?? '').join('');
}

const pages = loadWorldCorpus(EVALS + '/eval/data/world-v1');
const facts = new Map<string, any>(pages.map((p: any) => [p.slug, p._facts]));
const people = pages.filter((p: any) => p._facts.type === 'person').map((p: any) => p.slug);
const companies = pages.filter((p: any) => p._facts.type === 'company').map((p: any) => p._facts);
const REL: Record<string, string> = { founded: 'founders', invested_in: 'investors', advises: 'advisors' };
const has = (rel: string, person: string) => companies.some((c: any) => (c[REL[rel]] ?? []).includes(person));
type H = [string, 'object' | 'subject'];
const FAMS: Array<{ name: string; hops: H[]; excl: boolean; canon: string; ok: (a: string) => boolean }> = [
  { name: 'investor->founders', hops: [['invested_in', 'object'], ['founded', 'subject']], excl: false, canon: 'Who founded the companies that {A} invested in?', ok: a => has('invested_in', a) },
  { name: 'advisor->founders', hops: [['advises', 'object'], ['founded', 'subject']], excl: false, canon: 'Who founded the companies {A} advises?', ok: a => has('advises', a) },
  { name: 'founder->investors', hops: [['founded', 'object'], ['invested_in', 'subject']], excl: false, canon: 'Who invested in the companies founded by {A}?', ok: a => has('founded', a) },
  { name: 'co-investors', hops: [['invested_in', 'object'], ['invested_in', 'subject']], excl: true, canon: 'Who else invested in the companies {A} invested in?', ok: a => has('invested_in', a) },
  { name: 'founder->other-portfolio', hops: [['founded', 'object'], ['invested_in', 'subject'], ['invested_in', 'object']], excl: true, canon: 'What other companies did the investors in the companies {A} founded invest in?', ok: a => has('founded', a) },
];
let seed = Number(process.env.SEED ?? 7); const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const items: Array<{ fam: string; anchor: string; text: string; hops: H[]; excl: boolean }> = [];
for (const f of FAMS) {
  const pool = people.filter(f.ok);
  for (let k = 0; k < 4; k++) {
    const a = pool[Math.floor(rand() * pool.length)];
    const canon = f.canon.replace('{A}', facts.get(a).name);
    const out = await claude('You rewrite questions the way different people would naturally type them to a personal knowledge assistant. Keep the exact meaning and the person name. Vary wording, word order and register (casual, terse, formal). Output one rewrite per line, no numbering, nothing else.',
      `Write 3 different rewrites of: ${canon}`, 300);
    for (const line of out.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 3)) items.push({ fam: f.name, anchor: facts.get(a).name, text: line, hops: f.hops, excl: f.excl });
  }
}

const same = (a: Array<{ linkTypes: string[]; toward: string }>, b: H[]) =>
  a.length === b.length && a.every((h, i) => h.toward === b[i][1] && h.linkTypes.includes(b[i][0]));
const SYS = `Turn a question into a typed graph plan, or answer NONE. Relations (subject -> object): founded (person -> company), invested_in (person or company -> company), advises (person -> company), works_at (person -> company), attended (person -> meeting).
A plan starts at one named entity and walks 1-3 hops outward. Each hop is {"link_type": <relation>, "toward": "object" | "subject"}: "object" moves from the subject to the object, "subject" moves from the object back to the subject.
Example: "Who founded the companies Alice invested in?" -> {"anchor":"Alice","hops":[{"link_type":"invested_in","toward":"object"},{"link_type":"founded","toward":"subject"}],"exclude_anchor":false}
Set exclude_anchor true when the question asks for others besides the named entity. Output only the JSON or NONE.`;
const rows: any[] = [];
for (const it of items) {
  const g = parseRelationalPlan(it.text);
  const grammar = g.kind === 'plan' ? (same(g.plan.hops, it.hops) && g.plan.excludeAnchor === it.excl && g.plan.anchor.toLowerCase().includes(it.anchor.split(' ')[0].toLowerCase()) ? 'correct' : 'wrong') : g.kind;
  let llm = 'none';
  try {
    const raw = (await claude(SYS, it.text, 200)).trim();
    if (raw !== 'NONE') {
      const j = JSON.parse(raw.replace(/^```(json)?|```$/g, ''));
      const v = validateChainHops(j.hops);
      llm = v.ok && same(v.hops, it.hops) && !!j.exclude_anchor === it.excl
        && String(j.anchor).toLowerCase().includes(it.anchor.split(' ')[0].toLowerCase()) ? 'correct' : 'wrong';
    }
  } catch (e) { llm = 'error:' + String(e).slice(0, 80); }
  rows.push({ fam: it.fam, text: it.text, grammar, grammar_reason: g.kind === 'unsupported' ? g.reason : undefined, llm });
}
const count = (k: 'grammar' | 'llm', v: string) => rows.filter(r => r[k] === v).length;
const summary = {
  model: MODEL, n: rows.length, spent_usd: +spent.toFixed(4),
  grammar: { correct: count('grammar', 'correct'), wrong: count('grammar', 'wrong'), unsupported: count('grammar', 'unsupported'), not_applicable: count('grammar', 'not_applicable') },
  llm: { correct: count('llm', 'correct'), wrong: count('llm', 'wrong'), none: count('llm', 'none') },
  llm_only_correct: rows.filter(r => r.llm === 'correct' && r.grammar !== 'correct').length,
  grammar_only_correct: rows.filter(r => r.grammar === 'correct' && r.llm !== 'correct').length,
  by_family: Object.fromEntries(FAMS.map(f => [f.name, { n: rows.filter(r => r.fam === f.name).length, grammar: rows.filter(r => r.fam === f.name && r.grammar === 'correct').length, llm: rows.filter(r => r.fam === f.name && r.llm === 'correct').length }])),
};
console.log(JSON.stringify({ summary, rows }, null, 2));
