/**
 * The SOTA loop's leader rows: each dev-pool question answered by the strongest system we have for its benchmark, so a
 * gbrain miss the leader solved is a miss someone has already shown how to avoid. On LongMemEval the leader is the
 * whole-history reader (every session in the prompt); on BEAM-1M it is the grep agent (the file agent: 40 turns,
 * list_dir, grep and read_file over the sessions as files). The rows are bought once in window SOTA-W2-LEADER-CACHE and
 * read by attribution from the outcome cache; their spec pins the cell, reader, judge and code they were measured with.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { qaPromptVersion } from '../nightly/judge-cache.ts';
import { frontierJudgeOf } from '../q1/cells/definitions.ts';
import { FILE_AGENT_EFFORT } from '../systems/file-agent.ts';
import { ORACLE_PASS } from './answerability.ts';
import type { Spec } from './cache.ts';
import { datasetPin, suiteMaxTokens, validatorVersion } from './oracle.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const sha16 = (...files: string[]) => { const h = createHash('sha256'); for (const f of files) h.update(readFileSync(join(ROOT, f))); return h.digest('hex').slice(0, 16); };

/** The leader system per benchmark, the code that defines it, and its reasoning effort. */
export const LEADERS: Record<string, { system: string; code: string[]; effort: string | null }> = {
  'beam-1m': { system: 'grep-agent', code: ['eval/runner/systems/file-agent.ts', 'eval/runner/cat40/loop.ts'], effort: FILE_AGENT_EFFORT },
  'lme-s': { system: 'whole-history', code: ['eval/runner/memory-qa/qa.ts'], effort: null },
};

/** The leader's judge for a reader: the q1 cells' frontier judge, the BEAM judges rule (gpt-6.1-sol grades Claude and particle-1 rows, claude-opus-5-5 grades GPT rows). */
export const leaderJudge = frontierJudgeOf;

/** The current inputs for a benchmark's leader rows with one reader, or null when the benchmark has no leader. */
export function leaderSpec(benchmark: string, reader: string): Spec | null {
  const l = LEADERS[benchmark];
  if (!l) return null;
  return {
    kind: 'leader', benchmark, system: l.system, reader, system_version: sha16(...l.code), effort: l.effort, max_tokens: suiteMaxTokens(benchmark),
    judge: leaderJudge(reader), judge_prompt: qaPromptVersion(), pass_threshold: ORACLE_PASS, dataset: datasetPin(benchmark),
    validator_version: validatorVersion(benchmark), harness_digest: sha16('eval/runner/sota/leader.ts'),
  };
}
