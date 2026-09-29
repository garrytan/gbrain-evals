/**
 * Fixed, seeded paraphrase grammar for the four world-v1 relational
 * templates (audit B-RAB-01, coverage audit F8, issue #24 finding 6).
 *
 * The relational queries ("Who attended X?", "Who works at X?", "Who
 * invested in X?", "Who advises X?") use exactly the verbs of gbrain's
 * relational-intent parser, so the relational-ab lift is an in-grammar upper
 * bound. This generator rewrites every template query with one of four
 * frames per template, chosen by a seeded generator, keeping the query id
 * and gold unchanged. The frames were written as ordinary questions a person
 * might ask, not tuned against the parser, and the output is committed and
 * hash-checked BEFORE any scoring run, so the wording cannot be adjusted
 * after seeing results.
 *
 * Deterministic: same corpus + same seed = byte-identical output.
 *
 *   bun eval/generators/relational-paraphrase-gen.ts        # writes the file
 *   bun eval/generators/relational-paraphrase-gen.ts --check  # exits 1 on drift
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRelationalQueries, loadWorldCorpus } from '../runner/queries/relational.ts';

export const PARAPHRASE_SEED = 20260929;
export const PARAPHRASE_GRAMMAR_VERSION = 'relational-paraphrase-v1';
export const PARAPHRASE_PATH = join(import.meta.dir, '../data/relational-paraphrase-v1/paraphrases.json');

export type RelationalTemplate = 'attended' | 'works_at' | 'invested_in' | 'advises';

/** Template prefix of each world-v1 relational query, used to recover the seed title. */
export const TEMPLATE_PREFIX: Record<RelationalTemplate, string> = {
  attended: 'Who attended ',
  works_at: 'Who works at ',
  invested_in: 'Who invested in ',
  advises: 'Who advises ',
};

/** Four frames per template. `{X}` is the meeting or company title. */
export const PARAPHRASE_FRAMES: Record<RelationalTemplate, readonly string[]> = {
  attended: [
    'Which people were present at {X}?',
    'Who was in the room for {X}?',
    'Who took part in {X}?',
    'List the participants of {X}.',
  ],
  works_at: [
    'Who is employed by {X}?',
    'Which people are on the team at {X}?',
    'List the staff of {X}.',
    'Who is part of {X}?',
  ],
  invested_in: [
    'Which investors put money into {X}?',
    'Who holds a stake in {X}?',
    'List the investors in {X}.',
    'Who provided capital to {X}?',
  ],
  advises: [
    'Who serves as an advisor to {X}?',
    'Which people give advice to {X}?',
    'Who sits on the advisory board of {X}?',
    'List the advisors of {X}.',
  ],
};

export interface Paraphrase {
  query_id: string;
  template: RelationalTemplate;
  frame: number;
  text: string;
}

export interface ParaphraseFile {
  grammar_version: string;
  seed: number;
  frames_sha256: string;
  template_queries_sha256: string;
  paraphrases: Paraphrase[];
}

export function templateOfText(text: string): RelationalTemplate {
  for (const [template, prefix] of Object.entries(TEMPLATE_PREFIX) as Array<[RelationalTemplate, string]>) {
    if (text.startsWith(prefix)) return template;
  }
  throw new Error(`not a relational template query: ${text}`);
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

export function buildParaphrases(templateQueries: ReadonlyArray<{ id: string; text: string }>, seed = PARAPHRASE_SEED): ParaphraseFile {
  const next = mulberry32(seed);
  const paraphrases = templateQueries.map(q => {
    const template = templateOfText(q.text);
    const title = q.text.slice(TEMPLATE_PREFIX[template].length).replace(/\?$/, '');
    const frames = PARAPHRASE_FRAMES[template];
    const frame = Math.floor(next() * frames.length);
    return { query_id: q.id, template, frame, text: frames[frame]!.replace('{X}', title) };
  });
  return {
    grammar_version: PARAPHRASE_GRAMMAR_VERSION,
    seed,
    frames_sha256: sha256(JSON.stringify(PARAPHRASE_FRAMES)),
    template_queries_sha256: sha256(JSON.stringify(templateQueries.map(q => [q.id, q.text]))),
    paraphrases,
  };
}

export function renderParaphraseFile(corpusDir = join(import.meta.dir, '../data/world-v1')): string {
  return JSON.stringify(buildParaphrases(buildRelationalQueries(loadWorldCorpus(corpusDir))), null, 2) + '\n';
}

if (import.meta.main) {
  const rendered = renderParaphraseFile();
  if (process.argv.includes('--check')) {
    const committed = readFileSync(PARAPHRASE_PATH, 'utf8');
    if (committed !== rendered) { console.error(`[relational-paraphrase-gen] ${PARAPHRASE_PATH} differs from the generator output`); process.exit(1); }
    console.log('[relational-paraphrase-gen] committed paraphrases match the generator');
  } else {
    writeFileSync(PARAPHRASE_PATH, rendered);
    console.log(`[relational-paraphrase-gen] wrote ${PARAPHRASE_PATH}`);
  }
}
