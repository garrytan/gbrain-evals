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
 * gbrain by a hash of the family id. Dev uses seed 1 (seed A) and the name and
 * attribute pools below; the sealed set uses another seed with disjoint names,
 * attribute values and hand-written paraphrase pairs, all from the custodian.
 *
 * Usage (dev): bun eval/generators/p8-withdraw-review-gen.ts --seed 1 --families 150 --out <file.jsonl>
 *   [--model gpt-6.1-sol]   (paraphrases and natural wording; OPENAI_API_KEY)
 *
 * Custodian (held-out) mode:
 *   bun eval/generators/p8-withdraw-review-gen.ts --pools-file <custody json> --decision-id <id> --purpose <text>
 *     --seed <held-out seed, not 1> --families <n> --out <file.jsonl outside the repository>
 *     [--min-paraphrase-pairs 50] [--model gpt-6.1-sol]
 * The pools file lives outside the repository. Its bytes are hashed and a line
 * goes to access-log.jsonl beside it before they are parsed. Beside the output
 * the generator writes <out>.meta.json with counts and the pools file's SHA-256
 * only, never its path or text.
 *
 * Pools file format (JSON):
 *   {
 *     "first": ["...", ...],                 first names, at least 10, none in the dev FIRST or LAST pools
 *     "last":  ["...", ...],                 last names, at least 10, none in the dev pools;
 *                                            first x last must allow at least 200 distinct people
 *     "attributes": {                        exactly the dev attribute keys (employer, city, role, drink,
 *       "<key>": {                           investment, language, hobby, school, diet, board, pet, commute)
 *         "values": ["...", ...],            at least 2 distinct values, none equal (case-insensitive) to any
 *                                            dev attribute value
 *         "say": "{who} works at {value}."   optional: overrides the dev sentence template; must contain
 *       }, ...                               {who} and {value}
 *     },
 *     "paraphrase_pairs": [                  optional, hand-written restatements; each pair is one family
 *       { "who": "First Last",               a person no other pair uses; no name token from the dev pools
 *         "attribute": "<key>",              one of the attribute keys
 *         "value": "...",                    one of that attribute's values (corrected draws another)
 *         "restatement": "...",              the claim in other words: same meaning, nothing added or removed
 *         "claim": "..." }                   optional; defaults to the say template filled with who and value
 *     ]
 *   }
 * Pair families come first (in file order) and carry the hand-written
 * restatement as slice `restates_human` beside one model restatement
 * (`restates1`), so each family still has two restatements of seven
 * candidates. The rest of --families are drawn from the pools as in dev. The
 * generator refuses fewer than --min-paraphrase-pairs pairs (default 50, the
 * preregistered minimum).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { assertOutsideRepository, openCustodyFile } from '../runner/sealed-confirmation-lib.ts';
import { Rng } from './seeded.ts';

export const P8_WITHDRAW_GEN_VERSION = 'p8-withdraw-review-gen@2';
export const DEV_SEED = 1;
export const MIN_PARAPHRASE_PAIRS = 50;
export const MIN_ACTIONABLE_FAMILIES = 200;

const FIRST = ['Dana', 'Ravi', 'Mira', 'Tomas', 'Ines', 'Kofi', 'Lena', 'Arjun', 'Sofia', 'Malik', 'Yuki', 'Bram', 'Nadia', 'Felix', 'Amara', 'Jonas', 'Priya', 'Omar', 'Elsa', 'Theo', 'Zara', 'Hugo', 'Leila', 'Marco'];
const LAST = ['Okafor', 'Lindqvist', 'Haddad', 'Moreau', 'Varga', 'Castillo', 'Nakamura', 'Brennan', 'Osei', 'Petrov', 'Delacroix', 'Iyer', 'Kowalski', 'Ferreira', 'Abara', 'Holm', 'Tanaka', 'Quinn', 'Rossi', 'Mbeki'];

export interface Attr { key: string; values: string[]; say: (who: string, v: string) => string }
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

export interface ParaphrasePair { who: string; attribute: string; value: string; restatement: string; claim?: string }
export interface Pools { first: readonly string[]; last: readonly string[]; attrs: readonly Attr[]; pairs: readonly ParaphrasePair[] }
export const DEV_POOLS: Pools = { first: FIRST, last: LAST, attrs: ATTRS, pairs: [] };
export type Wordings = (claim: string, who: string, extra: string) => Promise<Record<string, string>>;

const norm = (x: string) => x.trim().toLowerCase();

/** Parse and check a custodian pools file (format in the header). Throws with every problem found; never echoes pool text. */
export function validatePools(raw: unknown, o: { minPairs?: number } = {}): Pools {
  const problems: string[] = [];
  const f = raw as { first?: unknown; last?: unknown; attributes?: Record<string, { values?: unknown; say?: unknown }>; paraphrase_pairs?: unknown };
  const strings = (x: unknown, where: string): string[] => {
    if (!Array.isArray(x) || !x.every(v => typeof v === 'string' && v.trim())) { problems.push(`${where} must be an array of non-empty strings`); return []; }
    if (new Set(x.map(norm)).size !== x.length) problems.push(`${where} has duplicates`);
    return x as string[];
  };
  const devNames = new Set([...FIRST, ...LAST].map(norm));
  const devValues = new Set(ATTRS.flatMap(a => a.values).map(norm));
  const first = strings(f?.first, 'first');
  const last = strings(f?.last, 'last');
  for (const [where, names] of [['first', first], ['last', last]] as const) {
    if (names.length < 10) problems.push(`${where} needs at least 10 names (has ${names.length})`);
    const clash = names.filter(n => devNames.has(norm(n))).length;
    if (clash) problems.push(`${where}: ${clash} name(s) also in the dev pools`);
  }
  if (first.length * last.length < MIN_ACTIONABLE_FAMILIES) problems.push(`first x last allows ${first.length * last.length} people; at least ${MIN_ACTIONABLE_FAMILIES} actionable families need as many distinct people`);
  const keys = Object.keys(f?.attributes ?? {});
  const devKeys = ATTRS.map(a => a.key);
  if (keys.slice().sort().join() !== devKeys.slice().sort().join()) problems.push(`attributes must have exactly the dev keys ${devKeys.join(', ')}`);
  const attrs: Attr[] = [];
  for (const dev of ATTRS) {
    const a = f?.attributes?.[dev.key];
    if (!a) continue;
    const values = strings(a.values, `attributes.${dev.key}.values`);
    if (values.length < 2) problems.push(`attributes.${dev.key} needs at least 2 values`);
    const clash = values.filter(v => devValues.has(norm(v))).length;
    if (clash) problems.push(`attributes.${dev.key}: ${clash} value(s) also in the dev pools`);
    let say = dev.say;
    if (a.say !== undefined) {
      const t = a.say;
      if (typeof t !== 'string' || !t.includes('{who}') || !t.includes('{value}')) problems.push(`attributes.${dev.key}.say must be a string containing {who} and {value}`);
      else say = (w, v) => t.replaceAll('{who}', w).replaceAll('{value}', v);
    }
    attrs.push({ key: dev.key, values, say });
  }
  const pairs: ParaphrasePair[] = [];
  const rawPairs = f?.paraphrase_pairs ?? [];
  if (!Array.isArray(rawPairs)) problems.push('paraphrase_pairs must be an array');
  else {
    const whos = new Set<string>();
    rawPairs.forEach((p: Record<string, unknown>, i) => {
      const where = `paraphrase_pairs[${i}]`;
      const str = (k: string) => typeof p?.[k] === 'string' && (p[k] as string).trim() ? p[k] as string : null;
      const who = str('who'), attribute = str('attribute'), value = str('value'), restatement = str('restatement');
      if (!who || !attribute || !value || !restatement) { problems.push(`${where} needs non-empty who, attribute, value and restatement`); return; }
      if (p.claim !== undefined && !str('claim')) problems.push(`${where}.claim must be a non-empty string when given`);
      if (whos.has(norm(who))) problems.push(`${where}: who is used by an earlier pair`);
      whos.add(norm(who));
      if (who.split(/\s+/).some(t => devNames.has(norm(t)))) problems.push(`${where}: who uses a name from the dev pools`);
      const attr = attrs.find(a => a.key === attribute);
      if (!attr) { problems.push(`${where}: unknown attribute`); return; }
      if (!attr.values.some(v => norm(v) === norm(value))) problems.push(`${where}: value is not one of attributes.${attribute}.values`);
      const claim = str('claim') ?? attr.say(who, value);
      if (norm(restatement) === norm(claim)) problems.push(`${where}: restatement repeats the claim`);
      pairs.push({ who, attribute, value: attr.values.find(v => norm(v) === norm(value)) ?? value, restatement, ...(str('claim') ? { claim: str('claim')! } : {}) });
    });
  }
  const minPairs = o.minPairs ?? MIN_PARAPHRASE_PAIRS;
  if (pairs.length < minPairs) problems.push(`paraphrase_pairs has ${pairs.length}; at least ${minPairs} hand-written pairs are required`);
  if (problems.length) throw new Error(`pools file rejected:\n${problems.join('\n')}`);
  return { first, last, attrs, pairs };
}

export async function generate(seed: number, n: number, model: string, log: (s: string) => void = s => process.stderr.write(s + '\n'), o: { pools?: Pools; wordings?: Wordings } = {}): Promise<PairRow[]> {
  const pools = o.pools ?? DEV_POOLS;
  const write = o.wordings ?? ((claim, who, extra) => wordings(model, claim, who, extra));
  if (n < pools.pairs.length) throw new Error(`--families ${n} is below the ${pools.pairs.length} paraphrase pairs; every pair is a family`);
  const rng = new Rng(seed);
  const rows: PairRow[] = [];
  const used = new Set<string>(pools.pairs.map(p => p.who));
  const capacity = pools.first.length * pools.last.length + pools.pairs.length;
  for (let f = 0; f < n; f++) {
    const pair = pools.pairs[f];
    let who: string;
    let a: Attr, b: Attr, v: string;
    if (pair) {
      who = pair.who;
      a = pools.attrs.find(x => x.key === pair.attribute)!;
      v = pair.value;
      b = rng.pick(pools.attrs.filter(x => x !== a));
    } else {
      do { who = `${rng.pick(pools.first)} ${rng.pick(pools.last)}`; } while (used.has(who) && used.size < capacity);
      used.add(who);
      [a, b] = rng.shuffle(pools.attrs) as [Attr, Attr];
      v = rng.pick(a.values);
    }
    const corrected = rng.pick(a.values.filter(x => x !== v));
    const other = b.say(who, rng.pick(b.values));
    const claim = pair?.claim ?? a.say(who, v);
    const family = `s${seed}-f${String(f).padStart(3, '0')}-${a.key}`;
    let w: Record<string, string> | null = null;
    for (let attempt = 0; attempt < 3 && !w; attempt++) {
      try { w = await write(claim, who, other); } catch (e) { log(`${family}: ${(e as Error).message}`); }
    }
    if (!w) continue;
    const add = (slice: string, candidate: string, label: PairRow['label']) => rows.push({ id: `${family}-${slice}`, family, fact: claim, candidate, label, slice });
    add('restates1', w.restate1!, 'duplicate');
    if (pair) add('restates_human', pair.restatement, 'duplicate');
    else add('restates2', w.restate2!, 'duplicate');
    add('corrected', a.say(who, corrected), 'supersede');
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
  if (!out) throw new Error('usage: --seed <n> --families <n> --out <file.jsonl> [--model gpt-6.1-sol]; custodian: add --pools-file <custody json> --decision-id <id> --purpose <text>');
  const seed = Number(flag('--seed') ?? DEV_SEED);
  const poolsFile = flag('--pools-file');
  if (poolsFile) {
    if (seed === DEV_SEED) throw new Error(`custodian mode needs a held-out seed; seed ${DEV_SEED} is the development seed`);
    assertOutsideRepository(out, '--out');
  } else {
    if (seed !== DEV_SEED) throw new Error(`only dev seed ${DEV_SEED} runs here; held-out seeds belong to the custodian (--pools-file with --decision-id and --purpose)`);
    if (argv.includes('--min-paraphrase-pairs')) throw new Error('--min-paraphrase-pairs is for custodian mode (--pools-file)');
  }
  if (existsSync(out) && !argv.includes('--force')) { process.stderr.write(`${out} exists (${readFileSync(out, 'utf8').split('\n').filter(Boolean).length} rows); pass --force to regenerate\n`); process.exit(0); }
  const custody = poolsFile ? openCustodyFile({ file: poolsFile, flag: '--pools-file', decisionId: flag('--decision-id'), purpose: flag('--purpose') }) : null;
  const pools = custody ? validatePools(JSON.parse(custody.bytes.toString('utf8')), { minPairs: Number(flag('--min-paraphrase-pairs') ?? MIN_PARAPHRASE_PAIRS) }) : DEV_POOLS;
  const model = flag('--model') ?? 'gpt-6.1-sol';
  const families = Number(flag('--families') ?? 150);
  const rows = await generate(seed, families, model, undefined, { pools });
  writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const written = new Set(rows.map(r => r.family)).size;
  if (custody) {
    writeFileSync(`${out}.meta.json`, JSON.stringify({
      generator: P8_WITHDRAW_GEN_VERSION, seed, model, families_requested: families, families_written: written, rows: rows.length,
      paraphrase_pair_families: new Set(rows.filter(r => r.slice === 'restates_human').map(r => r.family)).size,
      meets_min_actionable_families: written >= MIN_ACTIONABLE_FAMILIES, pools_sha256: custody.sha256,
    }, null, 2) + '\n');
  }
  process.stderr.write(`wrote ${rows.length} pairs in ${written} families to ${out} (${P8_WITHDRAW_GEN_VERSION})\n`);
}
