/**
 * Cat 7 (perf) and Cat 12 (mcp-contract) as gbrain RUST_ENGINE.md gate suites: both accept the gate runner's
 * --gbrain and --pg-url flags, and Cat 12's OperationContext names the engine that actually ran instead of a fixed
 * pglite config.
 */

import { describe, test, expect } from 'bun:test';
import { parsePerfArgs, DEFAULT_SEED } from '../../eval/runner/perf.ts';
import { pinnedContractSurface, setupEngine } from '../../eval/runner/mcp-contract.ts';
import { gateRunnerContext } from '../../eval/runner/eval-engine.ts';

describe('perf.ts gate flags', () => {
  test('--gbrain and --pg-url are accepted in both spellings and leave the perf args alone', () => {
    const want = { scales: [1000], seed: DEFAULT_SEED, json: false };
    expect(parsePerfArgs(['--scale', '1000', '--gbrain', '/tmp/gbrain@abc', '--pg-url', 'postgres://x'])).toEqual(want);
    expect(parsePerfArgs(['--gbrain=/tmp/gbrain', '--scale=1000', '--pg-url=postgres://x'])).toEqual(want);
  });

  test('an unknown flag still fails', () => {
    expect(() => parsePerfArgs(['--engine', 'rust'])).toThrow(/unknown arg: --engine/);
  });
});

describe('mcp-contract engine surface', () => {
  test('the pinned default surface keeps the in-memory PGLite config it always had', () => {
    const s = pinnedContractSurface();
    expect(s.config).toEqual({ engine: 'pglite', database_path: ':memory:' });
    expect(s.operations.length).toBeGreaterThan(100);
  });

  test('setupEngine names the engine GBRAIN_EVAL_ENGINE picked in the OperationContext config', async () => {
    const { surface, cleanup } = await setupEngine(gateRunnerContext([], { GBRAIN_EVAL_ENGINE: 'pglite' }));
    try {
      expect(surface.config.engine).toBe('pglite');
      expect(surface.config.database_path).toBe(':memory:');
      expect(surface.operations.length).toBeGreaterThan(100);
    } finally {
      await cleanup();
    }
  }, 180_000);
});
