/**
 * P8 withdrawal-review families: for each family, a withdrawn (forgotten)
 * claim about a fictional person and the active facts on the same entity the
 * review lane would judge against it. Only restatements may be withdrawn.
 *
 *   restates     the same claim in other words (model-written, two per family)  label duplicate
 *   corrected    the same attribute with a different value                      label supersede
 *   negation     the claim denied                                               label supersede
 *   temporal     the claim placed in a past period                              label supersede
 *   compound     the claim plus an unrelated second claim in one sentence       label independent
 *   independent  another attribute of the same person                           label independent
 *
 * About 30% of candidates are restatements. Output is the `facts-fixtures`
 * JSONL `gbrain decide dataset --slot conflict` reads (fact = the withdrawn
 * claim, candidate = the active fact). Families split calibrate/eval inside
 * gbrain by a hash of the family id. Dev uses seed 1 (seed A); the sealed set
 * uses another seed with disjoint names and attribute values and is produced
 * by the custodian only.
 *
 * Usage: bun eval/generators/p8-withdraw-review-gen.ts --seed 1 --families 150 --out <file.jsonl>
 *   [--model gpt-6.1-sol]   (paraphrases and natural wording; OPENAI_API_KEY)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Rng } from './seeded.ts';

export const P8_WITHDRAW_GEN_VERSION = 'p8-withdraw-review-gen@1';

const FIRST = ['Dana', 'Ravi', 'Mira', 'Tomas', 'Ines', 'Kofi', 'Lena', 'Arjun', 'Sofia', 'Malik', 'Yuki', 'Bram', 'Nadia', 'Felix', 'Amara', 'Jonas', 'Priya', 'Omar', 'Elsa', 'Theo', 'Zara', 'Hugo', 'Leila', 'Marco'];
const LAST = ['Okafor', 'Lindqvist', 'Haddad', 'Moreau', 'Varga', 'Castillo', 'Nakamura', 'Brennan', 'Osei', 'Petrov', 'Delacroix', 'Iyer', 'Kowalski', 'Ferreira', 'Abara', 'Holm', 'Tanaka', 'Quinn', 'Rossi', 'Mbeki'];

interface Attr { key: string; values: string[]; say: (who: string, v: string) => string }
const ATTRS: Attr[] = [
  { key: 'employer', values: ['Brightwell Labs', 'Northgate Freight', 'Copperline Health', 'Larkspur Analytics', 'Tidewater Energy', 'Quillon Robotics'], say: (w, v) => `${w} works at ${v}.` },
  { key: 'city', values: ['Lisbon', 'Porto', 'Rotterdam', 'Montreal', 'Osaka', 'Nairobi', 'Denver', 'Tallinn'], say: (w, v) => `${w} lives in ${v}.` },
  { key: 'role', values: ['head of finance', 'staff engineer', 'product designer', 'chief of staff', 'sales director', 'research scientist'], say: (w, v) => `${w} is the ${v} on the team.` },
  { key: 'drink', values: ['green tea', 'black coffee', 'oat-milk lattes', 'sparkling water', 'chai'], say: (w, v) => `${w} prefers ${v} in meetings.` },
  { key: 'investment', values: ['Fernway Robotics', 'Halcyon Bio', 'Mosaic Grid', 'Pinecrest Foods', 'Orbital Paper'], say: (w, v) => `${w} invested in ${v}.` },
  { key: 'language', values: ['Portuguese', 'Japanese', 'Swahili', 'Dutch', 'Korean', 'Polish'], say: (w, v) => `${w} speaks ${v} fluently.` },
  { key: 'hobby', values: ['rock climbing', 'competitive chess', 'sailing', 'pottery', 'trail running', 'birdwatching'], say: (w, v) => `${w} spends weekends on ${v}.` },
  { key: 'school', values: ['the University of Edinburgh', 'Kyoto University', 'McGill', 'TU Delft', 'the University of Cape Town'], say: (w, v) => `${w} studied at ${v}.` },
  { key: 'diet', values: ['vegetarian', 'vegan', 'pescatarian', 'gluten-free'], say: (w, v) => `${w} keeps a ${v} diet.` },
  { key: 'board', values: ['Riverbend Credit Union', 'the Harbor Arts Council', 'Greenleaf Schools', 'Summit Youth League'], say: (w, v) => `${w} sits on the board of ${v}.` },
  { key: 'pet', values: ['a border collie', 'two cats', 'a parrot', 'a rescue greyhound'], say: (w, v) => `${w} has ${v}.` },
  { key: 'commute', values: ['by bicycle', 'by train', 'on foot', 'by ferry'], say: (w, v) => `${w} commutes ${v}.` },
];

export interface PairRow { id: string; family: string; fact: string; candidate: string; label: 'duplicate' | 'supersede' | 'independent'; slice: string }

async function chat(model: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` },
    body: JSON.stringify({ model, input: prompt, max_output_tokens: 2000 }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json() as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };
  return (j.output ?? []).filter(o => o.type === 'message').flatMap(o => o.content ?? []).map(c => c.text ?? '').join('');
}

async function wordings(model: string, claim: string, who: string, extra: string): Promise<Record<string, string>> {
  const prompt = `Write short memory notes about a fictional person. Reply with one JSON object only, no prose.
Base claim: "${claim}"
Keys:
- "restate1": the base claim in clearly different words, same meaning, nothing added or removed (may use "${who.split(' ')[0]}" or a pronoun-free rewording).
- "restate2": another different wording of the same meaning (different structure from restate1).
- "negation": a note saying the base claim is not true, naturally worded.
- "temporal": a note saying the base claim was true in the past but no longer (give a past year).
- "compound": one sentence stating the base claim AND this separate fact: "${extra}".`;
  const text = await chat(model, prompt);
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const out = JSON.parse(json) as Record<string, string>;
  for (const k of ['restate1', 'restate2', 'negation', 'temporal', 'compound']) if (typeof out[k] !== 'string' || !out[k].trim()) throw new Error(`missing ${k}`);
  return out;
}

export async function generate(seed: number, n: number, model: string, log = (s: string) => process.stderr.write(s + '\n')): Promise<PairRow[]> {
  const rng = new Rng(seed);
  const rows: PairRow[] = [];
  const used = new Set<string>();
  for (let f = 0; f < n; f++) {
    let who: string;
    do { who = `${rng.pick(FIRST)} ${rng.pick(LAST)}`; } while (used.has(who) && used.size < FIRST.length * LAST.length);
    used.add(who);
    const [a, b] = rng.shuffle(ATTRS);
    const v = rng.pick(a!.values);
    const corrected = rng.pick(a!.values.filter(x => x !== v));
    const other = b!.say(who, rng.pick(b!.values));
    const claim = a!.say(who, v);
    const family = `s${seed}-f${String(f).padStart(3, '0')}-${a!.key}`;
    let w: Record<string, string> | null = null;
    for (let attempt = 0; attempt < 3 && !w; attempt++) {
      try { w = await wordings(model, claim, who, other); } catch (e) { log(`${family}: ${(e as Error).message}`); }
    }
    if (!w) continue;
    const add = (slice: string, candidate: string, label: PairRow['label']) => rows.push({ id: `${family}-${slice}`, family, fact: claim, candidate, label, slice });
    add('restates1', w.restate1!, 'duplicate');
    add('restates2', w.restate2!, 'duplicate');
    add('corrected', a!.say(who, corrected), 'supersede');
    add('negation', w.negation!, 'supersede');
    add('temporal', w.temporal!, 'supersede');
    add('compound', w.compound!, 'independent');
    add('independent', other, 'independent');
    if ((f + 1) % 25 === 0) log(`${f + 1}/${n} families`);
  }
  return rows;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = flag('--out');
  if (!out) throw new Error('usage: --seed <n> --families <n> --out <file.jsonl> [--model gpt-6.1-sol]');
  if (existsSync(out) && !argv.includes('--force')) { process.stderr.write(`${out} exists (${readFileSync(out, 'utf8').split('\n').filter(Boolean).length} rows); pass --force to regenerate\n`); process.exit(0); }
  const rows = await generate(Number(flag('--seed') ?? 1), Number(flag('--families') ?? 150), flag('--model') ?? 'gpt-6.1-sol');
  writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  process.stderr.write(`wrote ${rows.length} pairs in ${new Set(rows.map(r => r.family)).size} families to ${out} (${P8_WITHDRAW_GEN_VERSION})\n`);
}
