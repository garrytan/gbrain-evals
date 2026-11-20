#!/usr/bin/env bun
/**
 * Batch 3's synthetic side (GBEV-55, predictive-measures preregistration): one
 * synthetic brain and a questions-batch3-shaped file, built from G1's freshness
 * worlds (freshness-world-gen.ts) and G4's entity worlds (entity-agent-gen.ts),
 * for the live-recall runner under --protocol batch3.
 *
 *   bun eval/generators/batch3-synthetic-gen.ts --out <dir> [--seed N] [--per-type N] [--paraphrases <file.jsonl>]
 *   bun eval/runner/live-recall/run.ts run --synthetic <dir> --protocol batch3 --out <run dir>
 *
 * It writes <dir>/pages/**.md, <dir>/questions.jsonl and <dir>/manifest.json
 * (schema live-recall-b3-synthetic/v1, seeds, counts, digest), which
 * eval/runner/live-recall/synthetic.ts reads. Its contrasts are the synthetic
 * side of G2's batch-3 layer and of the retrieval layers of G1 and G4.
 *
 * The worlds are imported as their generators make them, never edited. G1 runs
 * at --seed and G4 at --seed + 1 (their own defaults, 20261110 and 20261111),
 * each over a fixed pool, and worlds are taken in pool order until each type
 * has --per-type questions:
 *   - freshness: a G1 world whose stale value sits on a page other than the
 *     fresh page. Gold is the fresh page and stale is every other page holding
 *     a stale spelling. summary_vs_timeline and shared_vs_published keep both
 *     values on one page, so they give no batch-3 question (batch 3 needs a
 *     stale page that is not the gold).
 *   - entity: a G4 world; gold is its gold page id.
 * All worlds share one brain, so a world is skipped when one of its page slugs
 * is already taken or its question repeats an earlier one (two worlds asking
 * the same thing about different pages would have two right answers). The
 * manifest counts the skips by pattern and reason.
 *
 * Exact forms are written in the gold page's own words, the way live recall's
 * exact forms are (batch 3's fixture asks "Where does Ines Varga work now?" of
 * the page that says so): each is a template per pattern filled from the gold
 * page's text, so every content word of the exact form is on its gold page and
 * gbrain's keyword arm can match it. Paraphrases are deterministic templates
 * per pattern filled from the world's own question (G1's "Today is <date>."
 * and "Reply with the value only." wrapping dropped), a keyless control. A counted run passes
 * --paraphrases (JSONL {id, paraphrase}, written by
 * eval/runner/live-recall/paraphrase-opus.ts, which is paid and refuses
 * without --paid and a budget run). Either way every paraphrase follows live
 * batch 2's rule: it shares no identifier-like token (identifierTokens in
 * run.ts) with its exact form, and a file that breaks it is refused by id.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseQuestions, type Question } from '../runner/live-recall/run.ts';
import { ConditionsRecallError, DEFAULT_KNOBS, applyParaphrases, paraphraseRuleBreaks, type ConditionsKnobs, type Page } from './conditions-recall-gen.ts';
import { G1_DEFAULT_SEED, freshnessDigest, generateFreshnessTasks, type FreshnessTask } from './freshness-world-gen.ts';
import { entityTasksDigest, generateEntityTasks, type EntityTask } from './entity-agent-gen.ts';
import { fingerprint } from './seeded.ts';

export const B3_SCHEMA = 'live-recall-b3-synthetic/v1';
export const B3_DEFAULT_PER_TYPE = 20;
export const G1_POOL = 250;
export const G4_POOL = 200;

export interface Batch3Manifest {
  schema: typeof B3_SCHEMA;
  protocol: 'batch3';
  seed: number;
  per_type: number;
  knobs: ConditionsKnobs;
  sources: Record<'g1' | 'g4', { generator: string; seed: number; pool: number; digest: string }>;
  counts: { pages: number; questions: number; by_type: Record<string, number>; by_pattern: Record<string, number> };
  skipped: Record<string, Record<string, number>>;
  paraphrase_source: 'template' | 'file';
  paraphrases_sha256: string | null;
  questions_sha256: string;
  digest: string;
}

export interface Batch3Generated { pages: Page[]; questions: Question[]; questionsText: string; manifest: Batch3Manifest }

export class Batch3SyntheticError extends Error {
  constructor(message: string) { super(message); this.name = 'Batch3SyntheticError'; }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const escape = (s: string) => s.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');

/** Identity of a generated batch-3 directory. synthetic.ts recomputes it before building. */
export function batch3Digest(knobs: ConditionsKnobs, pages: Page[], questionsText: string): string {
  return fingerprint({ schema: B3_SCHEMA, knobs, pages: [...pages].sort((a, b) => a.slug.localeCompare(b.slug)), questions: questionsText });
}

/** Exact forms per pattern: a pattern over the gold page's text, and the question built from what it captures. */
const EXACT: Record<string, [RegExp, (...m: string[]) => string]> = {
  entity_lag: [/^(.+) said she left .+ and is now VP Engineering at .+\.$/m, who => 'Where is ' + who + ' now VP Engineering?'],
  decision_reversed: [/^Reversing the earlier call on the (.+): we are going with /m, topic => 'Which ' + topic + ' are we going with instead?'],
  last_week_tz: [/ \(UTC\)\. (.+) approved plan \S+\.$/m, who => 'Which plan has ' + who + ' approved at the meeting?'],
  moved_namesake: [/^(.+) worked at .+ until March, then moved to (.+)\.$/m, (name, dest) => 'Which ' + name + ' moved to ' + dest + ' in March?'],
  family_surname: [/^\S+ (\S+) is a parent in the \S+ family\.$/m, last => 'Who is the parent in the ' + last + ' family?'],
  company_handle: [/, known online as @(\S+), founded (.+)\. Age \d+\.$/m, (handle, co) => 'Who founded ' + co + ' and is known online as @' + handle + '?'],
  father_son: [/^(.+), born \d+, son of .+; studied at (.+)\.$/m, (name, school) => 'Which ' + name + ' studied at ' + school + '?'],
};

function exactFor(pattern: string, goldPage: string): string {
  const [re, make] = EXACT[pattern] ?? [];
  const m = re && goldPage.match(re);
  if (!m) throw new Batch3SyntheticError('no exact-form template matches a ' + pattern + ' gold page; the world generator\'s wording changed');
  return make!(...m.slice(1));
}

const PARAPHRASES: Record<string, [RegExp, (...m: string[]) => string]> = {
  entity_lag: [/^Which company does (.+) work at right now\?$/, who => 'Who is ' + who + ' working for these days?'],
  decision_reversed: [/^Which (.+) did the team decide to go with\?$/, topic => 'Who did we end up picking as our ' + topic + '?'],
  last_week_tz: [/^I am in Pacific time\. Which plan did (.+) approve at our meeting last week \(Monday to Sunday, Pacific time\)\?$/, who => 'What plan got the go-ahead from ' + who + ' in our sync over the past seven days?'],
  moved_namesake: [/^Give the page id of the (.+) I met at (.+)\.$/, (name, event) => 'Which ' + name + ' was the one I ran into at ' + event + '?'],
  family_surname: [/^Which (\S+) runs (.+)\? Give the page id\.$/, (last, shop) => 'Who in the ' + last + ' family owns ' + shop + '?'],
  company_handle: [/^I want the age of (.+)'s founder, who posts as @\S+\. /, co => 'How old is the person who started ' + co + '?'],
  father_son: [/^Which (.+) is the son, the one I asked about at (.+)\? Give the page id\.$/, (name, school) => 'Which ' + name + ' is the younger one who went to ' + school + '?'],
};

function paraphraseFor(pattern: string, question: string): string {
  const [re, make] = PARAPHRASES[pattern] ?? [];
  const m = re && question.match(re);
  if (!m) throw new Batch3SyntheticError('no paraphrase template matches a ' + pattern + ' question; the world generator\'s wording changed');
  return make!(...m.slice(1));
}

function freshnessStem(question: string): string {
  const m = question.match(/^Today is \d{4}-\d{2}-\d{2}\. (.+) Reply with the value only\.$/);
  if (!m) throw new Batch3SyntheticError('a G1 question lacks its "Today is" and "Reply with the value only." wrapping');
  return m[1]!;
}

/** Pages other than the fresh page that hold a stale spelling as a whole word. */
function stalePages(task: FreshnessTask): string[] {
  const res = task.gold.stale.map(s => new RegExp('(^|[^A-Za-z0-9$])' + escape(s) + '($|[^A-Za-z0-9])'));
  return task.pages.filter(p => p.slug !== task.fresh_page && res.some(re => re.test(p.markdown))).map(p => p.slug);
}

export function generateBatch3Synthetic(opts: { seed?: number; perType?: number; paraphrasesText?: string } = {}): Batch3Generated {
  const seed = opts.seed ?? G1_DEFAULT_SEED;
  const perType = opts.perType ?? B3_DEFAULT_PER_TYPE;
  if (!Number.isInteger(seed)) throw new Batch3SyntheticError('--seed must be an integer');
  if (!Number.isInteger(perType) || perType < 1) throw new Batch3SyntheticError('--per-type must be a positive integer');
  const g1 = generateFreshnessTasks({ seed, n: G1_POOL });
  const g4 = generateEntityTasks({ seed: seed + 1, n: G4_POOL });

  const pages: Page[] = [];
  const slugs = new Set<string>();
  const asked = new Set<string>();
  const skipped: Record<string, Record<string, number>> = {};
  const byPattern: Record<string, number> = {};
  const questions: Question[] = [];
  const skip = (pattern: string, reason: string) => { (skipped[pattern] ??= {})[reason] = (skipped[pattern]![reason] ?? 0) + 1; };

  const take = (type: 'freshness' | 'entity', worlds: Array<FreshnessTask | EntityTask>) => {
    let taken = 0;
    for (const w of worlds) {
      if (taken === perType) return;
      const stale = type === 'freshness' ? stalePages(w as FreshnessTask) : [];
      if (type === 'freshness' && stale.length === 0) { skip(w.pattern, 'stale_on_gold_page'); continue; }
      if (w.pages.some(p => slugs.has(p.slug))) { skip(w.pattern, 'slug_taken'); continue; }
      const gold = type === 'freshness' ? (w as FreshnessTask).fresh_page : (w as EntityTask).gold;
      const exact = exactFor(w.pattern, w.pages.find(p => p.slug === gold)!.markdown);
      const paraphrase = paraphraseFor(w.pattern, type === 'freshness' ? freshnessStem(w.question) : w.question);
      if (asked.has(exact.toLowerCase()) || asked.has(paraphrase.toLowerCase())) { skip(w.pattern, 'repeated_question'); continue; }
      asked.add(exact.toLowerCase());
      asked.add(paraphrase.toLowerCase());
      for (const p of w.pages) { slugs.add(p.slug); pages.push({ slug: p.slug, body: p.markdown }); }
      questions.push({ id: w.id, type, forms: { exact, paraphrase }, gold: [{ slug: gold }], ...(stale.length ? { stale: stale.map(slug => ({ slug })) } : {}), gold_found_by: 'page_first' });
      byPattern[w.pattern] = (byPattern[w.pattern] ?? 0) + 1;
      taken++;
    }
    if (taken < perType) throw new Batch3SyntheticError('--per-type ' + perType + ' asks for more ' + type + ' questions than the ' + taken + ' distinct worlds the pool gives');
  };
  take('freshness', g1);
  take('entity', g4);

  const final = opts.paraphrasesText === undefined ? questions : applyParaphrases(questions, opts.paraphrasesText);
  const breaks = paraphraseRuleBreaks(final);
  if (breaks.length) throw new Batch3SyntheticError('paraphrase for id ' + breaks[0] + ' shares an identifier-like token with its exact form');
  const questionsText = final.map(q => JSON.stringify(q)).join('\n') + '\n';
  parseQuestions(questionsText, 'batch3');

  const knobs = { ...DEFAULT_KNOBS };
  const manifest: Batch3Manifest = {
    schema: B3_SCHEMA,
    protocol: 'batch3',
    seed,
    per_type: perType,
    knobs,
    sources: {
      g1: { generator: 'eval/generators/freshness-world-gen.ts', seed, pool: G1_POOL, digest: freshnessDigest(g1) },
      g4: { generator: 'eval/generators/entity-agent-gen.ts', seed: seed + 1, pool: G4_POOL, digest: entityTasksDigest(g4) },
    },
    counts: { pages: pages.length, questions: final.length, by_type: { freshness: perType, entity: perType }, by_pattern: byPattern },
    skipped,
    paraphrase_source: opts.paraphrasesText === undefined ? 'template' : 'file',
    paraphrases_sha256: opts.paraphrasesText === undefined ? null : sha256(opts.paraphrasesText),
    questions_sha256: sha256(questionsText),
    digest: batch3Digest(knobs, pages, questionsText),
  };
  return { pages, questions: final, questionsText, manifest };
}

export function writeBatch3Synthetic(dir: string, generated: Batch3Generated): void {
  if (existsSync(join(dir, 'pages')) || existsSync(join(dir, 'manifest.json'))) throw new Batch3SyntheticError(dir + ' already holds a generated set; choose an empty --out');
  for (const page of generated.pages) {
    const path = join(dir, 'pages', page.slug + '.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, page.body);
  }
  writeFileSync(join(dir, 'questions.jsonl'), generated.questionsText);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(generated.manifest, null, 2) + '\n');
}

function main(argv: string[]): number {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = flag('--out');
  if (!out) {
    console.error('usage: bun eval/generators/batch3-synthetic-gen.ts --out <dir> [--seed N] [--per-type N] [--paraphrases <file.jsonl>]');
    return 2;
  }
  const num = (name: string) => (flag(name) === undefined ? undefined : Number(flag(name)));
  const paraphrases = flag('--paraphrases');
  try {
    const generated = generateBatch3Synthetic({ seed: num('--seed'), perType: num('--per-type'), paraphrasesText: paraphrases === undefined ? undefined : readFileSync(paraphrases, 'utf8') });
    writeBatch3Synthetic(out, generated);
    const m = generated.manifest;
    console.log('batch3-synthetic: ' + out + ' (' + m.counts.questions + ' questions, ' + m.counts.pages + ' pages, paraphrases ' + m.paraphrase_source + ', digest ' + m.digest.slice(0, 12) + ')');
    return 0;
  } catch (error) {
    if (!(error instanceof Batch3SyntheticError) && !(error instanceof ConditionsRecallError)) throw error;
    console.error('batch3-synthetic: refused: ' + error.message);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
