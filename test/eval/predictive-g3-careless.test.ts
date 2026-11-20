/** G3: a careless fake that reports every write as landed is caught; see test/support/predictive-g3.ts. */
import { describe, expect, test } from 'bun:test';
import { runWriteEpisode, scriptedWritePolicy } from '../../eval/runner/predictive/episodes.ts';
import { deadFetch, g3Tasks, stripProviderKeysForFile } from '../support/predictive-g3.ts';

stripProviderKeysForFile();

describe('G3 causes reproduce on the pinned gbrain', () => {
  test('a careless fake that reports every write as landed is caught as reported done, not landed', async () => {
    const tasks = g3Tasks();
    for (const cause of ['missing_provenance', 'source_changed', 'scope_denied'] as const) {
      const task = tasks.find(t => t.cause === cause)!;
      const e = await runWriteEpisode({ task, surface: 'cli', trial: 0, model: 'scripted-fake', fetchImpl: deadFetch, scripted: scriptedWritePolicy(task, 'cli', 'careless') });
      expect(e.success).toBe(false);
      expect(e.reported_done_not_landed).toBe(1);
      expect(e.cause).toBe('write_integrity');
      expect(e.refusals.map(r => [r.cause, r.retried])).toEqual([[cause, false]]);
    }
  }, 300_000);
});
