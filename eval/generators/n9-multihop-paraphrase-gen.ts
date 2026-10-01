/**
 * N9 multi-hop paraphrase grammar (eval-category wave, amendment 9).
 *
 * Composed two- and three-hop questions over world-v1, with gold derived
 * from the generator-written `_facts` metadata (never from gbrain). Each
 * question walks a chain of typed relations, for example
 *
 *   investor --invested_in--> company --founded_by--> founder
 *   "Who founded the companies that Alice Example invested in?"
 *
 * Every family has one canonical frame (plain relation verbs, the
 * `composed-template` split) and three paraphrase frames, of which a seeded
 * generator picks one per question (the `composed-paraphrase` split). The
 * frames were written as ordinary questions before any scoring run and
 * without being tested against gbrain's relational parser. This file and its
 * output are committed, with the output's SHA-256, before the first scoring
 * run; the runner refuses a questions file that differs from this generator.
 * The 2026-09-29 one-hop paraphrase split is development data; this grammar
 * is new and separate from it.
 *
 * Gold per question:
 *   answers           the entities at the end of every chain from the anchor;
 *   support           the pages whose `_facts` state each edge on those
 *                     chains (company pages hold founders, investors and
 *                     advisors; meeting pages hold attendees and topic);
 *   required          support plus answers: strict all-hit@k needs every one
 *                     of them in the first k results;
 *   bridge_entities   intermediate entities (reported, not required).
 *
 * Structural design rules, applied at generation and never from results:
 * anchors are fictional people, startups and meetings (no venture firm or
 * acquirer, which carry real company names); every chain stays inside the
 * corpus; a question needs at least one bridge and one answer, and at most
 * MAX_REQUIRED required pages so it is solvable at the preregistered k.
 *
 * Controls recorded per question (reported, never used to drop a question):
 *   edges_stated      every required edge is stated in the holder page's text
 *                     (link or name), so the chain is recoverable from text;
 *   single_page_shortcut  some one page mentions the anchor and every answer,
 *                     so a retriever could hit the answers without composing.
 *
 * Deterministic: same corpus + same seed = byte-identical output.
 *
 *   bun eval/generators/n9-multihop-paraphrase-gen.ts          # writes the file
 *   bun eval/generators/n9-multihop-paraphrase-gen.ts --check  # exits 1 on drift
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadWorldCorpus, type RichPage } from '../runner/queries/relational.ts';

export const N9_SEED = 20261001;
export const N9_GRAMMAR_VERSION = 'n9-multihop-paraphrase-v1';
export const N9_QUESTIONS_PATH = join(import.meta.dir, '../data/n9-multihop-paraphrase-v1/questions.json');
/** Preregistered k for strict all-hit (result chunk rows per arm). */
export const N9_K = 10;
/** A question needs required pages <= this, so all-hit@k is reachable. */
export const MAX_REQUIRED = N9_K;

export type Relation = 'invested_in' | 'founded_by' | 'advises' | 'has_investor' | 'topic' | 'attended';

export type N9Family =
  | 'investor_founders'
  | 'advisor_founders'
  | 'founder_investors'
  | 'coinvestors'
  | 'meeting_investors'
  | 'founder_portfolio_peers'
  | 'investor_founder_meetings';

/** Canonical frame first, then three paraphrase frames. `{A}` is the anchor name. */
export const N9_FRAMES: Record<N9Family, readonly [string, string, string, string]> = {
  investor_founders: [
    'Who founded the companies that {A} invested in?',
    'Which founders have {A} as an investor in their company?',
    '{A} put money into some startups. Who started them?',
    'Name the people who started the companies in the portfolio of {A}.',
  ],
  advisor_founders: [
    'Who founded the companies that {A} advises?',
    'Which founders count {A} among the advisors of their company?',
    '{A} is an advisor to a few startups. Who started those startups?',
    'Name the people behind the companies {A} gives advice to.',
  ],
  founder_investors: [
    'Who invested in the company that {A} founded?',
    'Which investors backed the startup {A} started?',
    '{A} started a company. Who put money into it?',
    'Name the people holding a stake in the company started by {A}.',
  ],
  coinvestors: [
    'Who else invested in the companies that {A} invested in?',
    'Which other investors share portfolio companies with {A}?',
    '{A} has backed some startups. Who were the other backers?',
    'Name the people who co-invested alongside {A}.',
  ],
  meeting_investors: [
    'Who invested in the company discussed at {A}?',
    'Which investors are behind the company that was the subject of {A}?',
    '{A} was about one company. Who has put money into that company?',
    'Name the backers of the company covered in {A}.',
  ],
  founder_portfolio_peers: [
    'Which other companies did the investors in the company {A} founded invest in?',
    'Where else have the backers of the startup {A} founded put their money?',
    '{A} started a company with outside investors. What other startups do those investors hold stakes in?',
    'Name the other portfolio companies of the people who invested in the company started by {A}.',
  ],
  investor_founder_meetings: [
    'Which meetings did the founders of the companies {A} invested in attend?',
    'What meetings were the founders of the portfolio companies of {A} present at?',
    '{A} backed some startups. Which meetings did the people who started them take part in?',
    'List the meetings attended by founders of startups that {A} has a stake in.',
  ],
};

export const N9_FAMILY_RELATIONS: Record<N9Family, readonly Relation[]> = {
  investor_founders: ['invested_in', 'founded_by'],
  advisor_founders: ['advises', 'founded_by'],
  founder_investors: ['founded_by', 'has_investor'],
  coinvestors: ['invested_in', 'has_investor'],
  meeting_investors: ['topic', 'has_investor'],
  founder_portfolio_peers: ['founded_by', 'has_investor', 'invested_in'],
  investor_founder_meetings: ['invested_in', 'founded_by', 'attended'],
};

export interface Edge { from: string; relation: Relation; to: string; holder: string }

export interface N9Question {
  id: string;
  family: N9Family;
  hops: number;
  relations: Relation[];
  anchor: string;
  anchor_name: string;
  template_text: string;
  paraphrase_frame: number;
  paraphrase_text: string;
  answers: string[];
  support: string[];
  required: string[];
  bridge_entities: string[];
  edges: Edge[];
  controls: { edges_stated: boolean; unstated_edges: number; single_page_shortcut: boolean };
}

export interface N9QuestionFile {
  grammar_version: string;
  seed: number;
  k: number;
  frames_sha256: string;
  corpus_facts_sha256: string;
  questions: N9Question[];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** Typed world-v1 graph from `_facts`, restricted to pages in the corpus. */
export class WorldGraph {
  readonly bySlug: Map<string, RichPage>;
  constructor(readonly pages: readonly RichPage[]) {
    this.bySlug = new Map(pages.map(p => [p.slug, p]));
  }
  private present = (xs: readonly string[] | undefined) => (xs ?? []).filter(s => this.bySlug.has(s));
  type = (slug: string) => this.bySlug.get(slug)!._facts.type;
  name = (slug: string) => String((this.bySlug.get(slug)!._facts as { name?: string }).name ?? this.bySlug.get(slug)!.title);
  /** Fictional startups only: venture firms and acquirers carry real company names. */
  isStartup = (slug: string) => this.type(slug) === 'company' && (this.bySlug.get(slug)!._facts as { category?: string }).category === 'startup';
  companies = () => this.pages.filter(p => this.isStartup(p.slug)).map(p => p.slug);
  meetings = () => this.pages.filter(p => p._facts.type === 'meeting').map(p => p.slug);
  founders = (company: string) => this.present(this.bySlug.get(company)!._facts.founders);
  investors = (company: string) => this.present(this.bySlug.get(company)!._facts.investors);
  advisors = (company: string) => this.present(this.bySlug.get(company)!._facts.advisors);
  attendees = (meeting: string) => this.present(this.bySlug.get(meeting)!._facts.attendees);
  topic = (meeting: string) => {
    const t = (this.bySlug.get(meeting)!._facts as { topic_company?: string }).topic_company;
    return t && this.bySlug.has(t) && this.isStartup(t) ? t : null;
  };
  /** One step along a relation: [next entity, edge]. */
  step(from: string, relation: Relation): Edge[] {
    switch (relation) {
      case 'invested_in': return this.companies().filter(c => this.investors(c).includes(from)).map(c => ({ from, relation, to: c, holder: c }));
      case 'advises': return this.companies().filter(c => this.advisors(c).includes(from)).map(c => ({ from, relation, to: c, holder: c }));
      case 'founded_by':
        return this.type(from) === 'company'
          ? this.founders(from).map(f => ({ from, relation, to: f, holder: from }))
          : this.companies().filter(c => this.founders(c).includes(from)).map(c => ({ from, relation, to: c, holder: c }));
      case 'has_investor': return this.investors(from).map(i => ({ from, relation, to: i, holder: from }));
      case 'topic': { const t = this.topic(from); return t ? [{ from, relation, to: t, holder: from }] : []; }
      case 'attended': return this.meetings().filter(m => this.attendees(m).includes(from)).map(m => ({ from, relation, to: m, holder: m }));
    }
  }
  text(slug: string): string {
    const p = this.bySlug.get(slug)!;
    return `${p.title}\n${p.compiled_truth}\n${p.timeline}`;
  }
  mentions(holder: string, entity: string): boolean {
    const text = this.text(holder);
    return text.includes(`(${entity})`) || text.includes(this.name(entity));
  }
}

/** Every chain from the anchor along the family's relations; "other"/"else" families exclude revisits. */
function walk(g: WorldGraph, anchor: string, relations: readonly Relation[]): Edge[][] {
  let paths: Edge[][] = [[]];
  for (const relation of relations) {
    const next: Edge[][] = [];
    for (const path of paths) {
      const at = path.length ? path[path.length - 1]!.to : anchor;
      const visited = new Set([anchor, ...path.map(e => e.to)]);
      for (const edge of g.step(at, relation)) if (!visited.has(edge.to)) next.push([...path, edge]);
    }
    paths = next;
  }
  return paths;
}

function anchorsFor(g: WorldGraph, family: N9Family): string[] {
  const people = (pred: (p: string) => boolean) => g.pages.filter(p => p._facts.type === 'person' && pred(p.slug)).map(p => p.slug);
  switch (family) {
    case 'investor_founders':
    case 'coinvestors':
    case 'investor_founder_meetings':
      return people(p => g.step(p, 'invested_in').length > 0);
    case 'advisor_founders':
      return people(p => g.step(p, 'advises').length > 0);
    case 'founder_investors':
    case 'founder_portfolio_peers':
      return people(p => g.step(p, 'founded_by').length > 0);
    case 'meeting_investors':
      return g.meetings().filter(m => g.topic(m) !== null);
  }
}

export function buildN9Questions(pages: readonly RichPage[], seed = N9_SEED): N9QuestionFile {
  const g = new WorldGraph(pages);
  const next = mulberry32(seed);
  const questions: N9Question[] = [];
  for (const family of Object.keys(N9_FRAMES) as N9Family[]) {
    const relations = N9_FAMILY_RELATIONS[family];
    for (const anchor of anchorsFor(g, family)) {
      const paths = walk(g, anchor, relations);
      const edges = paths.flat();
      const answers = sorted(paths.map(p => p[p.length - 1]!.to));
      const support = sorted(edges.map(e => e.holder));
      const required = sorted([...support, ...answers]);
      const bridges = sorted(paths.flatMap(p => p.slice(0, -1).map(e => e.to)));
      if (!answers.length || !bridges.length || required.length > MAX_REQUIRED) continue;
      const frames = N9_FRAMES[family];
      const frame = 1 + Math.floor(next() * (frames.length - 1));
      const name = g.name(anchor);
      const uniqueEdges = [...new Map(edges.map(e => [`${e.from}|${e.relation}|${e.to}`, e])).values()];
      const unstated = uniqueEdges.filter(e => !g.mentions(e.holder, e.holder === e.to ? e.from : e.to)).length;
      const shortcut = pages.some(p => g.mentions(p.slug, anchor) && answers.every(a => p.slug === a || g.mentions(p.slug, a)));
      questions.push({
        id: `n9-${String(questions.length + 1).padStart(4, '0')}`,
        family, hops: relations.length, relations: [...relations], anchor, anchor_name: name,
        template_text: frames[0].replace('{A}', name),
        paraphrase_frame: frame,
        paraphrase_text: frames[frame]!.replace('{A}', name),
        answers, support, required, bridge_entities: bridges, edges: uniqueEdges,
        controls: { edges_stated: unstated === 0, unstated_edges: unstated, single_page_shortcut: shortcut },
      });
    }
  }
  return {
    grammar_version: N9_GRAMMAR_VERSION,
    seed,
    k: N9_K,
    frames_sha256: sha256(JSON.stringify({ frames: N9_FRAMES, relations: N9_FAMILY_RELATIONS, max_required: MAX_REQUIRED })),
    corpus_facts_sha256: sha256(JSON.stringify(pages.map(p => [p.slug, p._facts]))),
    questions,
  };
}

export function renderN9QuestionFile(corpusDir = join(import.meta.dir, '../data/world-v1')): string {
  return JSON.stringify(buildN9Questions(loadWorldCorpus(corpusDir)), null, 2) + '\n';
}

export function n9QuestionFileSha256(): string {
  return sha256(readFileSync(N9_QUESTIONS_PATH, 'utf8'));
}

if (import.meta.main) {
  const rendered = renderN9QuestionFile();
  if (process.argv.includes('--check')) {
    const committed = readFileSync(N9_QUESTIONS_PATH, 'utf8');
    if (committed !== rendered) { console.error(`[n9-gen] ${N9_QUESTIONS_PATH} differs from the generator output`); process.exit(1); }
    console.log(`[n9-gen] committed questions match the generator (sha256 ${sha256(committed)})`);
  } else {
    mkdirSync(dirname(N9_QUESTIONS_PATH), { recursive: true });
    writeFileSync(N9_QUESTIONS_PATH, rendered);
    console.log(`[n9-gen] wrote ${N9_QUESTIONS_PATH} (sha256 ${sha256(rendered)})`);
  }
}
