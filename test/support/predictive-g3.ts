/**
 * The G3 causes on the pinned gbrain, shared by the predictive-g3-*.test.ts files. The recovering-fake check runs 16
 * real gbrain episodes (eight causes on the CLI and MCP surfaces), about 4.5 minutes in one file, so each file runs two
 * causes and CI's shards can place them apart. test/eval/predictive-cli-arm.test.ts checks the exposure total.
 *
 * Keyless: provider keys are deleted from the process for each file, every model is scripted, and the loop's fetch is
 * a dead upstream that throws, so no test can reach a provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runWriteEpisode, scriptedWritePolicy } from '../../eval/runner/predictive/episodes.ts';
import { multiWindowReads, type RefusalEvent } from '../../eval/runner/predictive/write-contract.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { HERMETIC_KEY_PATTERN, HERMETIC_STRIPPED_KEYS } from '../../eval/runner/hermetic-env.ts';
import { G3_CAUSES, G3_SURFACES, generateWriteTasks, type G3Cause } from '../../eval/generators/write-contract-gen.ts';

export const deadFetch = (() => { throw new Error('dead upstream: tests never call a provider'); }) as unknown as typeof fetch;

export function stripProviderKeysForFile(): void {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of Object.keys(process.env)) if ((HERMETIC_STRIPPED_KEYS as readonly string[]).includes(k) || HERMETIC_KEY_PATTERN.test(k) || /PARTICLE|UBICLOUD/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterAll(() => { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; });
}

export const g3Tasks = () => G3_CAUSES.map(c => generateWriteTasks({ n: 8 }).find(t => t.cause === c)!);

/** Surface-cause pairs where an episode meets its cause: the exposure table, except that a gbrain that reads two ranges refuses two_range_read on the CLI only. */
export function g3MetPairs(reads: boolean): string[] {
  return g3Tasks().flatMap(t => G3_SURFACES.filter(s => reads && t.cause === 'two_range_read' ? s === 'cli' : t.exposure[s][t.cause] === 1).map(s => `${s}:${t.cause}`));
}

export function describeG3Recovering(causes: readonly G3Cause[]): void {
  describe('G3 causes reproduce on the pinned gbrain', () => {
    const tasks = g3Tasks().filter(t => causes.includes(t.cause));
    test(`a recovering fake passes ${causes.join(' and ')} on both surfaces and meets the cause wherever it is exposed`, async () => {
      expect(tasks.map(t => t.cause)).toEqual([...causes]);
      const reads = multiWindowReads(resolveGbrainUnderTest(null).version);
      const seen: string[] = [];
      for (const task of tasks) for (const surface of G3_SURFACES) {
        const e = await runWriteEpisode({ task, surface, trial: 0, model: 'scripted-fake', fetchImpl: deadFetch, scripted: scriptedWritePolicy(task, surface, 'recovering') });
        expect({ id: task.id, surface, cause: e.cause }).toEqual({ id: task.id, surface, cause: 'correct' });
        expect(e.reported_done_not_landed).toBe(0);
        const met = e.refusals.some(r => r.cause === task.cause);
        if (reads && task.cause === 'two_range_read') {
          const refusals: RefusalEvent[] = surface === 'mcp' ? [] : [{ cause: 'two_range_read', code: null, family: 'get', call: 0, retried: true, recovered: true }];
          expect({ id: task.id, surface, refusals: e.refusals }).toEqual({ id: task.id, surface, refusals });
        } else {
          expect({ id: task.id, surface, met }).toEqual({ id: task.id, surface, met: task.exposure[surface][task.cause] === 1 });
        }
        if (met) seen.push(`${surface}:${task.cause}`);
      }
      expect(seen).toEqual(g3MetPairs(reads).filter(p => causes.includes(p.slice(p.indexOf(':') + 1) as G3Cause)));
    }, 300_000);
  });
}
