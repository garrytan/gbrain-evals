import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_FAILURE_SCHEMA, type EvalFailure, type SourceEntry } from '../../eval/runner/failure-causes/index.ts';
import { sha256, type LoadedFile } from '../../eval/runner/failure-causes/manifest.ts';

export const FX = join(import.meta.dir, '..', 'fixtures', 'failure-causes');

export function loadFixture(dir: string, files: Array<[string, string]>): LoadedFile[] {
  return files.map(([path, role]) => {
    const bytes = new Uint8Array(readFileSync(join(FX, dir, path)));
    return { path, role, sha256: sha256(bytes), root: 'fx', bytes };
  });
}

export const entry = (id: string, adapter: SourceEntry['adapter'], extra: Partial<SourceEntry> = {}): SourceEntry =>
  ({ id, adapter, visibility: 'synthetic', condition: 'natural', root: 'fx', files: [], ...extra });

/** A failed row with nothing measured; tests set only the fields a rule reads. */
export function failure(over: Partial<EvalFailure> = {}): EvalFailure {
  return {
    schema: EVAL_FAILURE_SCHEMA, source: 'fx', run_id: 'run', case_id: 'case-1', system: 'gbrain', arm: 'gbrain', arm_role: 'gbrain_default',
    condition: 'natural', visibility: 'synthetic', model: 'anthropic:claude-opus-5-5', gbrain_sha: null, failed: true, score: 0, category: null,
    agent_loop: false, stop: null, finish_reason: null, harness: null, operation: null, tool_calls: null,
    gold: { gold_count: null, stored: null, hidden: null, retrieved: null, delivered: null, opened: null, summary_only: null },
    writes: null, tags: [], evidence: ['fx:case.json#00000000'], ...over,
  };
}
