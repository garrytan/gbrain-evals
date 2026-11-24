/** The non-weekly cells test/eval/q1-merge-scope.test.ts merges, the invented corpus their shards ran on and its kept lists. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BG1_SET, BG1C_SET, RS1_CONVERSATIONS, type Bg1Manifest, type Corpus, type MemoryQuestion, type Rs1Manifest } from '../../../../eval/runner/memory-qa/corpus.ts';

/** One kept cell of each sealed set (the mint slots of its first two launch units) and one public LoCoMo cell, each with its conversation ids. */
export const MERGE_SCOPE_CELLS = [
  { set: 'rs1', id: 'rs1.ext-memory-bank.recipe', manifest: 'rs1', ids: RS1_CONVERSATIONS.slice(0, 10) },
  { set: 'bg1', id: 'bg1.ext-memory-bank.recipe', manifest: 'bg1', ids: BG1_SET.ids.slice(0, 12) },
  { set: 'bg1c', id: 'bg1c.ext-memory-bank.recipe', manifest: 'bg1c', ids: BG1C_SET.ids.slice(0, 10) },
  { set: 'locomo', id: 's3.ext-memory-bank.recipe', manifest: undefined, ids: ['conv-a', 'conv-b', 'conv-c', 'conv-d', 'conv-e', 'conv-f', 'conv-g', 'conv-h'] },
] as const;

/**
 * The LoCoMo-shaped fixture q1-cell.test.ts runs on, its three conversations (two questions each) repeated under the cell's
 * ids, as a 'fixture' corpus (every conversation in every split), so a kept cell's first two launch units hold every conversation.
 */
export function mergeScopeCorpus(ids: readonly string[]): Corpus {
  const path = 'test/eval/fixtures/q1-cell/locomo-shaped.json';
  const raw = JSON.parse(readFileSync(join(import.meta.dir, '../../../..', path), 'utf8')) as { conversations: Corpus['conversations']; questions: MemoryQuestion[] };
  const conversations = ids.map((id, k) => ({ ...raw.conversations[k % 3], id }));
  const questions = ids.flatMap((id, k) => raw.questions.filter(q => q.conversation === raw.conversations[k % 3].id).slice(0, 2).map(q => ({ ...q, id: `${id}:${q.id}`, conversation: id })));
  return { benchmark: 'fixture', conversations, questions, source: { name: 'LoCoMo-shaped fixture (invented)', files: [{ path, sha256: 'fixture' }], revision: 'repo', license: 'MIT' } } as Corpus;
}

/** A filled kept list of those conversations (wave A, no final size), as the custodian's RS1 or BG1 manifest pins it (nothing reads through it). */
export const mergeScopeKept = (ids: readonly string[]): Rs1Manifest & Bg1Manifest => ({ dataset: 'fixture', status: 'filled', layout: 'fixture', note: 'invented', filled_at: '2026-11-24', kept: [...ids],
  files: ids.flatMap(id => [`conversations/c${id.slice(4)}/beam/1/chat.json`, `conversations/c${id.slice(4)}/beam/1/probing_questions/probing_questions.json`, `worlds/${id}/world.json`, `worlds/${id}/questions.json`].map(p => ({ path: p, sha256: '0'.repeat(64) }))) });
