/**
 * Writes the shard inputs of test/eval/q1-merge-scope.test.ts: two keyless shards of one non-weekly cell from each of
 * RS1, BG1, BG1-C and the public LoCoMo set, run on the synthetic corpus with the fake memory system and a scripted
 * reader and judge. A kept cell's shards run without its kept list (conversation i of shard i mod 2), so no mint slot
 * appears; the merge reads only what the shards staged. Usage: bun test/eval/fixtures/q1-merge-scope/generate-inputs.ts <out dir>
 */
import { join, resolve } from 'node:path';
import { findCell, runCell } from '../../../../eval/runner/q1/cell.ts';
import type { ChatLike, ChatResult } from '../../../../eval/runner/memory-qa/qa-v2.ts';
import { FakeMemorySystem } from '../../../../eval/runner/systems/fake.ts';
import { MERGE_SCOPE_CELLS, mergeScopeCorpus } from './cells.ts';

const META = { finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
const reader: ChatLike = { async chat(_m, prompt): Promise<ChatResult> { return { text: /Question: (.*)\n/.exec(prompt)?.[1] ?? 'none', input_tokens: 10, output_tokens: 5, cached: false, ...META }; } };
const judge: ChatLike = { async chat(): Promise<ChatResult> { return { text: JSON.stringify({ correct: 1 }), input_tokens: 100, output_tokens: 4, cached: false, ...META }; } };
const out = resolve(process.argv[2] ?? '');
for (const c of MERGE_SCOPE_CELLS) {
  const def = { ...findCell(c.id, undefined, c.manifest), kept_units: undefined };
  for (const index of [0, 1]) {
    const r = await runCell(def, { out: join(out, c.set, `shard${index}`), shard: { index, count: 2 }, probeIntervalMs: 5, probeTimeoutMs: 2000 }, { corpus: mergeScopeCorpus(), system: new FakeMemorySystem(), reader, judge });
    console.log(c.id, index, r.status, r.share?.complete);
  }
}
