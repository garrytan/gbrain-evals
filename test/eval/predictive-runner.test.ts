/**
 * The predictive runner: plan sizes, the three modes, the paid-arm guard and the keyless schema grammar on the pinned
 * gbrain; plus one G1 and one G4 episode on the real CLI arm with scripted failing models. Keyless: provider keys are
 * deleted for the file, every model is scripted and the loop's fetch is a dead upstream.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERMETIC_KEY_PATTERN, HERMETIC_STRIPPED_KEYS } from '../../eval/runner/hermetic-env.ts';
import { main, MODELS, planUnit, runGrammar } from '../../eval/runner/predictive/run.ts';
import { runEntityEpisode, runFreshnessEpisode, scriptedEntityPolicy, scriptedFreshnessPolicy } from '../../eval/runner/predictive/episodes.ts';
import { multiWindowReads } from '../../eval/runner/predictive/write-contract.ts';
import { generateFreshnessTasks } from '../../eval/generators/freshness-world-gen.ts';
import { generateEntityTasks } from '../../eval/generators/entity-agent-gen.ts';

const saved: Record<string, string | undefined> = {};
const deadFetch = (() => { throw new Error('dead upstream: tests never call a provider'); }) as unknown as typeof fetch;
let ledgerDir = '';
beforeAll(() => {
  for (const k of Object.keys(process.env)) if ((HERMETIC_STRIPPED_KEYS as readonly string[]).includes(k) || HERMETIC_KEY_PATTERN.test(k) || /PARTICLE|UBICLOUD/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  ledgerDir = mkdtempSync(join(tmpdir(), 'predictive-ledger-'));
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  rmSync(ledgerDir, { recursive: true, force: true });
});

describe('plans', () => {
  test('the counted sizes: G1 120 tasks, G3 60 tasks on 2 surfaces, G4 60 tasks, k 4, three models', () => {
    expect(MODELS).toEqual(['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1']);
    expect(planUnit('g1')).toMatchObject({ tasks: 120, surfaces: 1, k: 4, episodes: 1440 });
    expect(planUnit('g3')).toMatchObject({ tasks: 60, surfaces: 2, k: 4, episodes: 1440 });
    expect(planUnit('g4')).toMatchObject({ tasks: 60, surfaces: 1, k: 4, episodes: 720 });
    const g3 = planUnit('g3');
    expect(g3.exposure!.cli.sources_without_brain).toBeGreaterThan(0);
    expect(g3.exposure!.mcp.sources_without_brain).toBe(0);
    for (const m of g3.per_model) expect(m.estimate_usd).toBeGreaterThan(0);
    expect(g3.per_model[0].estimate_usd).toBeGreaterThan(g3.per_model[2].estimate_usd);
  });
});

describe('modes', () => {
  const ledger = () => ['--budget-ledger', join(ledgerDir, 'ledger.sqlite')];
  test('dry-run plans and exits 0; exactly one mode is required; an unknown unit is a usage error', async () => {
    expect(await main(['g4', '--dry-run', '--tasks', '4'])).toBe(0);
    expect(await main(['g4', '--dry-run', '--fake'])).toBe(2);
    expect(await main(['g4'])).toBe(2);
    expect(await main(['g9', '--dry-run'])).toBe(2);
  });
  test('paid mode refuses without the paid-arm guard and never runs an episode', async () => {
    expect(await main(['g3', '--paid', ...ledger()])).toBe(2);
    expect(await main(['g3', '--budget-run-id', 'nope', ...ledger()])).toBe(2);
    expect(await main(['g1', '--paid', '--budget-run-id', 'not-a-run', ...ledger()])).toBe(2);
  });
});

describe('provider guard', () => {
  test('an episode with a real model and no paid-arm run id refuses before any gbrain or provider work', async () => {
    const g = generateEntityTasks({ n: 1 })[0];
    await expect(runEntityEpisode({ task: g, trial: 0, model: 'claude-opus-5-5', fetchImpl: deadFetch })).rejects.toThrow(/paid-arm guard/);
  }, 60_000);
});

describe('real gbrain, scripted models', () => {
  test('the schema grammar meets every expected refusal and acceptance at the pin', async () => {
    const g = await runGrammar();
    expect(g.surprises).toEqual([]);
    expect(g.rows.filter(r => r.id.startsWith('cause:') && r.expect === 'refuse' && r.cause !== r.id.slice(6))).toEqual([]);
    const twoRange = g.rows.filter(r => r.id === 'cause:two_range_read').map(r => ({ surface: r.surface, refused: r.refused, cause: r.cause }));
    expect(twoRange).toEqual(multiWindowReads(g.gbrain_version)
      ? [{ surface: 'mcp', refused: false, cause: null }, { surface: 'cli', refused: false, cause: null }]
      : [{ surface: 'mcp', refused: true, cause: 'two_range_read' }, { surface: 'cli', refused: true, cause: 'two_range_read' }]);
    expect(new Set(g.rows.map(r => r.surface))).toEqual(new Set(['mcp', 'cli']));
  }, 180_000);

  test('a G1 fake that opens only the stale page is gold_unopened; a G4 fake that picks the namesake is wrong_entity', async () => {
    const f = generateFreshnessTasks({ n: 1 })[0];
    const e1 = await runFreshnessEpisode({ task: f, trial: 0, pressured: false, model: 'scripted-fake', fetchImpl: deadFetch, scripted: scriptedFreshnessPolicy(f, 'stale-unopened') });
    expect(e1).toMatchObject({ cause: 'gold_unopened', reading: 'stale', opened_fresh_page: false });
    expect(e1.pages_opened).toEqual([f.pages[0].slug]);
    const n = generateFreshnessTasks({ n: 1 })[0];
    const e0 = await runFreshnessEpisode({ task: n, trial: 0, pressured: true, model: 'scripted-fake', fetchImpl: deadFetch, scripted: scriptedFreshnessPolicy(n, 'no-memory') });
    expect(e0).toMatchObject({ cause: 'memory_not_consulted', brain_calls: 0, pressured: true });
    const g = generateEntityTasks({ n: 1 })[0];
    const e4 = await runEntityEpisode({ task: g, trial: 0, model: 'scripted-fake', fetchImpl: deadFetch, scripted: scriptedEntityPolicy(g, 'namesake') });
    expect(e4).toMatchObject({ cause: 'wrong_entity', confused_with_candidate: true, usd: 0 });
  }, 180_000);
});
