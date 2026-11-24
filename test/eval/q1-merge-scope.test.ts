/**
 * cell.ts mergeCell outside the weekly line: a non-weekly cell's merge writes exactly what main's `cell.ts merge` wrote
 * before the weekly line split cells across VMs (expected/, written by fixtures/q1-merge-scope/main-merge.ts from
 * 753393ff on the committed shard inputs), needs no custody log, and ignores an invalid reason left in a stale lease's
 * receipt. Keyless: synthetic conversations under real cell definitions (no mint slot or sealed id), no corpus load, no client.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCell, mergeCell, needsCustody } from '../../eval/runner/q1/cell.ts';
import { MERGE_SCOPE_CELLS, mergeScopeCorpus } from './fixtures/q1-merge-scope/cells.ts';

const FIX = resolve(import.meta.dir, 'fixtures/q1-merge-scope');
const tmp = mkdtempSync(join(tmpdir(), 'q1-merge-scope-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const files = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).filter(f => statSync(join(dir, f)).isFile()).sort();
const shards = (set: string) => [0, 1].map(i => join(FIX, 'inputs', set, `shard${i}`));

describe('a non-weekly merge is unchanged by the weekly line', () => {
  // Value: protects=a public LoCoMo cell, which needs custody to run because LoCoMo has a sealed split, merges with no custody log, as publish.ts mergeAt runs it; fails_when=the merge's custody gate covers every cell that needs custody rather than weekly cells only, so publishing a public campaign refuses CUSTODY_REQUIRED; why_new=GBEV-3's ruling A on #626 (pass-3 specialist-batched#1); seam=cell.ts mergeCell on the committed LoCoMo shards with an empty environment; no_claim=the custody gate on a weekly cell's merge (weekly-line-execution.test.ts)
  test('a public LoCoMo cell merges with no custody log', () => {
    const c = MERGE_SCOPE_CELLS.find(x => x.set === 'locomo')!;
    const def = findCell(c.id, undefined, c.manifest);
    expect([def.week, needsCustody(def)]).toEqual([undefined, true]);
    expect(mergeCell(def, shards(c.set), join(tmp, 'public'), { env: {}, corpus: mergeScopeCorpus() }).map(r => r.status)).toEqual(['complete']);
  });

  // Value: protects=RS1, BG1, BG1-C and public LoCoMo cells merge exactly as main merged them before #626, with no custody log, so the weekly line's custody gate and unit-invalidity union reach weekly cells only; fails_when=the merge gates a non-weekly cell on custody (publish.ts mergeAt runs it without a custody log) or changes a byte of any merged file; why_new=GBEV-3's ruling A on #626 (pass-3 specialist-batched#1, a byte-identical merge test for non-weekly cells); seam=cell.ts mergeCell on committed shard inputs against main-merge.ts's output from 753393ff; no_claim=the corpus loaders the CLI runs (the merge takes the corpus the shards ran on)
  test.each(MERGE_SCOPE_CELLS.map(c => [c.set, c] as const))('%s: the merged files are main\'s, byte for byte, with no custody log', (_set, c) => {
    const def = findCell(c.id, undefined, c.manifest);
    const out = join(tmp, 'same', c.set);
    mergeCell(def, shards(c.set), out, { env: {}, corpus: mergeScopeCorpus() });
    const want = join(FIX, 'expected', c.set);
    expect(files(out)).toEqual(files(want));
    expect(files(out).filter(f => !readFileSync(join(out, f)).equals(readFileSync(join(want, f))))).toEqual([]);
  });

  // Value: protects=an invalid reason left in an earlier lease's receipt, beside the clean re-run of the same shard, does not make a non-weekly merged cell invalid, as before #626; fails_when=the merge unions every --from receipt's invalid reasons for every cell, so publish.ts, which passes every settled lease, publishes a clean RS1, BG1, BG1-C or public cell as invalid; why_new=GBEV-3's ruling A on #626 (pass-3 red-team#1); seam=cell.ts mergeCell with a stale lease copied from a committed shard; no_claim=which lease publish.ts lists
  test.each(MERGE_SCOPE_CELLS.map(c => [c.set, c] as const))('%s: a stale invalid lease beside its clean re-run publishes the clean status', (_set, c) => {
    const def = findCell(c.id, undefined, c.manifest);
    const stale = join(tmp, 'stale', c.set);
    cpSync(shards(c.set)[0], stale, { recursive: true });
    for (const a of def.arms) {
      const path = join(stale, 'cells', a.cell_id, 'receipt.json');
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), run_status: 'invalid', invalid_reasons: ['sanitizer tripwire during retrieval: an earlier attempt'] }, null, 2) + '\n');
    }
    const res = mergeCell(def, [stale, ...shards(c.set)], join(tmp, 'merged', c.set), { env: {}, corpus: mergeScopeCorpus() });
    const want = def.arms.map(a => JSON.parse(readFileSync(join(FIX, 'expected', c.set, 'cells', a.cell_id, 'receipt.json'), 'utf8')).run_status);
    expect([res.map(r => r.status), want.includes('invalid')]).toEqual([want, false]);
  });
});
