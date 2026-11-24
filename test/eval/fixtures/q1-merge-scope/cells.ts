/** The non-weekly cells test/eval/q1-merge-scope.test.ts merges and the synthetic corpus their shards ran on. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Corpus, MemoryQuestion } from '../../../../eval/runner/memory-qa/corpus.ts';

/** One kept cell of each sealed set and one public LoCoMo cell, by their real definitions; every conversation is synthetic. */
export const MERGE_SCOPE_CELLS = [
  { set: 'rs1', id: 'rs1.ext-memory-bank.recipe', manifest: 'rs1' },
  { set: 'bg1', id: 'bg1.ext-memory-bank.recipe', manifest: 'bg1' },
  { set: 'bg1c', id: 'bg1c.ext-memory-bank.recipe', manifest: 'bg1c' },
  { set: 'locomo', id: 's3.ext-memory-bank.recipe', manifest: undefined },
] as const;

export const MERGE_SCOPE_IDS = ['conv-a', 'conv-b', 'conv-c', 'conv-d', 'conv-e', 'conv-f', 'conv-g', 'conv-h'];

/**
 * The invented LoCoMo-shaped fixture q1-cell.test.ts runs on, its three conversations (two questions each) repeated
 * under eight synthetic ids, as a 'fixture' corpus (every conversation in every split). No id is a mint slot or a
 * sealed id of any split (eval/decisions/splits), so nothing here is a custody fact.
 */
export function mergeScopeCorpus(): Corpus {
  const path = 'test/eval/fixtures/q1-cell/locomo-shaped.json';
  const raw = JSON.parse(readFileSync(join(import.meta.dir, '../../../..', path), 'utf8')) as { conversations: Corpus['conversations']; questions: MemoryQuestion[] };
  const conversations = MERGE_SCOPE_IDS.map((id, k) => ({ ...raw.conversations[k % 3], id }));
  const questions = MERGE_SCOPE_IDS.flatMap((id, k) => raw.questions.filter(q => q.conversation === raw.conversations[k % 3].id).slice(0, 2).map(q => ({ ...q, id: `${id}:${q.id}`, conversation: id })));
  return { benchmark: 'fixture', conversations, questions, source: { name: 'LoCoMo-shaped fixture (invented)', files: [{ path, sha256: 'fixture' }], revision: 'repo', license: 'MIT' } } as Corpus;
}
