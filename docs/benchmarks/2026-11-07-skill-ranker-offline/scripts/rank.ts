/**
 * The ranker prototype under test (not product code): catalog views, the
 * config-only listings, BM25F, today's scoreSkillMatch (vendored), embedding
 * fusion, the per-turn block and the normalized gate. Generalizes the pilot's
 * BM25 + embedding scripts to fields, sizes and a gate.
 */
import { TIERS } from './build-catalog.ts';
import { tokens } from './lib.ts';

export interface Skill { id: string; name: string; source: string; description: string; triggers: string[]; routing: string[]; body: string; tier: keyof typeof TIERS }
export type Variant = 'D' | 'T';
export type Size = 250 | 750 | 1500;
export const SIZES: Size[] = [250, 750, 1500];
export const K = 5;
export const B = 200;
export const CUT_RATIO = 0.11;
export const HINT_CHARS = 120;

const TIER_MAX: Record<Size, (keyof typeof TIERS)[]> = { 250: ['core'], 750: ['core', 'pad750'], 1500: ['core', 'pad750', 'pad1500'] };

/** The catalog at a size, in a variant: D drops triggers and routing rows. */
export function view(all: Skill[], size: Size, variant: Variant): Skill[] {
  return all.filter(s => TIER_MAX[size].includes(s.tier)).map(s => (variant === 'D' ? { ...s, triggers: [], routing: [] } : s));
}

const byName = (a: Skill, b: Skill) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function hint(description: string): string {
  if (description.length <= HINT_CHARS) return description;
  const cut = description.slice(0, HINT_CHARS);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, '')}…`;
}
export const line = (s: Skill) => `- ${s.name}: ${hint(s.description)}`;
export const blockText = (skills: Skill[]) => (skills.length ? `<relevant_skills>\n${skills.map(line).join('\n')}\n</relevant_skills>` : '');

/** Fill a static listing with whole lines up to the token budget. */
function fill<T>(items: T[], render: (t: T) => string, budget: number): { items: T[]; text: string } {
  const out: T[] = [];
  let text = '';
  for (const it of items) {
    const next = text ? `${text}\n${render(it)}` : render(it);
    if (tokens(next) > budget) break;
    out.push(it);
    text = next;
  }
  return { items: out, text };
}

export interface Listing { arm: string; mode: 'matched' | 'natural'; ids: Set<string>; tokens: number; count: number }

/** Config-only arms at one size. usage: dev frequency per id; spring: the spring block's skill lines in order. */
export function listings(cat: Skill[], usage: Map<string, number>, springLines: { name: string; text: string }[]): Listing[] {
  const alpha = [...cat].sort(byName);
  const n = Math.round(CUT_RATIO * cat.length);
  const mk = (arm: string, mode: Listing['mode'], skills: Skill[], text: string): Listing => ({ arm, mode, ids: new Set(skills.map(s => s.id)), tokens: tokens(text), count: skills.length });
  const a0n = alpha.slice(0, n);
  const a0m = fill(alpha, line, B);
  const a1m = fill(alpha, s => s.name, B);
  const usageOrder = [...cat].sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) || byName(a, b));
  const a1um = fill(usageOrder, line, B);
  const inCat = new Map(cat.map(s => [s.id, s]));
  const spring = springLines.filter(l => inCat.has(`gbrain:${l.name}`));
  const a1sm = fill(spring, l => l.text, B);
  const sk = (ls: { name: string }[]) => ls.map(l => inCat.get(`gbrain:${l.name}`)!);
  return [
    mk('A0', 'natural', a0n, a0n.map(s => `- ${s.name}: ${s.description}`).join('\n')),
    mk('A0', 'matched', a0m.items, a0m.text),
    mk('A1', 'natural', alpha, alpha.map(s => s.name).join('\n')),
    mk('A1', 'matched', a1m.items, a1m.text),
    mk('A1u', 'matched', a1um.items, a1um.text),
    mk('A1s', 'natural', sk(spring), spring.map(l => l.text).join('\n')),
    mk('A1s', 'matched', sk(a1sm.items), a1sm.text),
  ];
}

// ---------------------------------------------------------------------------
// Lexical
// ---------------------------------------------------------------------------

export const STOPWORDS = new Set(('a an the and or of to for in on at by with my me is it be this that from as are was were i you your we our us can could ' +
  'would should will do does did have has had not no so if then than but about into over up out what which who how when where why please just also any all ' +
  'some them they their there here its').split(' '));

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}
export const lex = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2 && !STOPWORDS.has(t)).map(stem);

export const FIELDS = ['name', 'description', 'triggers', 'routing', 'body'] as const;
export type Field = (typeof FIELDS)[number];
export interface Bm25Params { k1: number; b: number; w: Record<Field, number> }

export interface Bm25Index { n: number; df: Map<string, number>; postings: Map<string, { doc: number; tf: number[] }[]>; len: number[][]; avg: number[] }

const fieldText = (s: Skill, f: Field) => (f === 'name' ? s.name.replace(/[-_:]/g, ' ') : f === 'description' ? s.description : f === 'triggers' ? s.triggers.join(' . ') : f === 'routing' ? s.routing.join(' . ') : s.body);

export function bm25Index(cat: Skill[], fields: Field[]): Bm25Index {
  const df = new Map<string, number>();
  const postings = new Map<string, { doc: number; tf: number[] }[]>();
  const len: number[][] = [];
  cat.forEach((s, doc) => {
    const per = new Map<string, number[]>();
    const lens = FIELDS.map(f => {
      if (!fields.includes(f)) return 0;
      const toks = lex(fieldText(s, f));
      for (const t of toks) {
        const v = per.get(t) ?? FIELDS.map(() => 0);
        v[FIELDS.indexOf(f)]++;
        per.set(t, v);
      }
      return toks.length;
    });
    len.push(lens);
    for (const [t, tf] of per) {
      df.set(t, (df.get(t) ?? 0) + 1);
      const p = postings.get(t) ?? [];
      p.push({ doc, tf });
      postings.set(t, p);
    }
  });
  const avg = FIELDS.map((_, i) => Math.max(1e-9, len.reduce((a, l) => a + l[i], 0) / cat.length));
  return { n: cat.length, df, postings, len, avg };
}

/** BM25F scores for every doc, plus the normalizer (sum of idf over query terms present). */
export function bm25(ix: Bm25Index, query: string, p: Bm25Params): { scores: Float64Array; norm: number } {
  const scores = new Float64Array(ix.n);
  let norm = 0;
  for (const q of new Set(lex(query))) {
    const df = ix.df.get(q);
    if (!df) continue;
    const idf = Math.log(1 + (ix.n - df + 0.5) / (df + 0.5));
    norm += idf;
    for (const { doc, tf } of ix.postings.get(q)!) {
      let t = 0;
      for (let f = 0; f < FIELDS.length; f++) {
        if (!tf[f]) continue;
        t += (p.w[FIELDS[f]] * tf[f]) / (1 - p.b + (p.b * ix.len[doc][f]) / ix.avg[f]);
      }
      scores[doc] += (idf * t) / (p.k1 + t);
    }
  }
  return { scores, norm };
}

// ---------------------------------------------------------------------------
// Today's ranker: scoreSkillMatch, vendored verbatim from gbrain
// src/core/skill-catalog.ts at ff11cb911c74 (check-a2.ts proves equivalence).
// ---------------------------------------------------------------------------

const QUERY_STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'my', 'me', 'is', 'it', 'be', 'this', 'that', 'from', 'as']);
export function queryTokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2 && !QUERY_STOPWORDS.has(t));
}
export function scoreSkillMatch(entry: { name: string; description: string; triggers: string[] }, query: string): { score: number; matched_on: string } | null {
  const queryWords = queryTokens(query);
  if (queryWords.length === 0) return null;
  const inQuery = new Set(queryWords);
  const queryText = ` ${queryWords.join(' ')} `;
  const overlap = (text: string): number => new Set(queryTokens(text).filter(t => inQuery.has(t))).size;
  let trigger = 0;
  for (const phrase of entry.triggers) {
    const words = queryTokens(phrase);
    if (words.length === 0) continue;
    trigger += queryText.includes(` ${words.join(' ')} `) ? 4 * words.length : 2 * overlap(phrase);
  }
  const name = 3 * overlap(entry.name);
  const description = overlap(entry.description);
  const score = trigger + name + description;
  if (score === 0) return null;
  const matched_on = trigger >= name && trigger >= description ? 'trigger' : name >= description ? 'name' : 'description';
  return { score, matched_on };
}

// ---------------------------------------------------------------------------
// Ranking a turn
// ---------------------------------------------------------------------------

/** top: the preregistered normalized gate feature; raw: the arm's unnormalized top score; ratio: top score over the mean of ranks 2 to 10 (zero-filled), a length-free distinctiveness feature (Amendment 2). */
export interface Ranked { order: number[]; top: number; raw: number; ratio: number }

export function ratioOf(scores: ArrayLike<number>, o: number[]): number {
  if (!o.length) return 0;
  let rest = 0;
  for (let i = 1; i < 10; i++) rest += i < o.length ? scores[o[i]] : 0;
  return Math.min(1e6, scores[o[0]] / Math.max(rest / 9, 1e-9));
}

/** Order docs by score (desc), ties by name then id; zero scores dropped. */
export function order(cat: Skill[], scores: ArrayLike<number>, limit = 10): number[] {
  const idx: number[] = [];
  for (let i = 0; i < cat.length; i++) if (scores[i] > 0) idx.push(i);
  idx.sort((a, b) => scores[b] - scores[a] || byName(cat[a], cat[b]));
  return idx.slice(0, limit);
}

export function rankA2(cat: Skill[], query: string): Ranked {
  const scores = cat.map(s => scoreSkillMatch(s, query)?.score ?? 0);
  const o = order(cat, scores);
  const q = new Set(queryTokens(query)).size;
  return { order: o, top: o.length && q ? scores[o[0]] / q : 0, raw: o.length ? scores[o[0]] : 0, ratio: ratioOf(scores, o) };
}

export function rankBm25(cat: Skill[], ix: Bm25Index, query: string, p: Bm25Params): Ranked & { norm: Float64Array } {
  const { scores, norm } = bm25(ix, query, p);
  const n = new Float64Array(scores.length);
  if (norm > 0) for (let i = 0; i < scores.length; i++) n[i] = scores[i] / norm;
  const o = order(cat, n);
  return { order: o, top: o.length ? n[o[0]] : 0, raw: o.length ? scores[o[0]] : 0, ratio: ratioOf(n, o), norm: n };
}

export const cosine = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Fusion: w * bm25n + (1 - w) * cosine (vectors are unit length). */
export function rankHybrid(cat: Skill[], bm25n: Float64Array, skillVecs: Float32Array[], qv: Float32Array, w: number): Ranked {
  const s = new Float64Array(cat.length);
  for (let i = 0; i < cat.length; i++) s[i] = w * bm25n[i] + (1 - w) * Math.max(0, cosine(skillVecs[i], qv));
  const o = order(cat, s);
  return { order: o, top: o.length ? s[o[0]] : 0, raw: o.length ? s[o[0]] : 0, ratio: ratioOf(s, o) };
}
