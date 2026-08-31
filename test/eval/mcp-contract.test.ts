/**
 * mcp-contract runner tests (audit agentic-cats-04/05/13).
 *
 * Two layers:
 *   1. Pure assertion helpers — hermetic proof that every previously
 *      unfailable check CAN now fail: an uncapped traverse result fails the
 *      depth-cap check, an unclamped remote list fails the clamp check, an
 *      equal local/remote posture fails the trust-matrix checks, and a seed
 *      smaller than the cap makes the check fail rather than pass vacuously.
 *   2. One real integration pass — PGLite engine, real gbrain operation
 *      handlers, the full behavioral check list must go green, and the
 *      trust matrix must have exercised BOTH ctx.remote=false and
 *      ctx.remote=true.
 */

import { describe, test, expect } from 'bun:test';
import {
  checkDepthCap,
  checkRemoteListClamp,
  checkListPagesTrustMatrix,
  checkModeDifferential,
  handlerSanityWalk,
  runContractChecks,
  setupEngine,
  CHAIN_LENGTH,
  TOTAL_SEEDED_PAGES,
  TRAVERSE_DEPTH_CAP,
  REMOTE_LIST_PAGES_CAP,
} from '../../eval/runner/mcp-contract.ts';

// ─── Layer 1: the checks can fail ─────────────────────────────────────

describe('checkDepthCap — can fail (agentic-cats-04)', () => {
  const cap = TRAVERSE_DEPTH_CAP;

  function chainNodes(count: number): Array<{ depth: number }> {
    return Array.from({ length: count }, (_, i) => ({ depth: i }));
  }

  test('FAILS when an uncapped traverse returns the whole chain (more than the cap)', () => {
    // What a regression deleting gbrain's TRAVERSE_DEPTH_CAP would return:
    // every node of the 16-node chain, max depth 15.
    const uncapped = chainNodes(CHAIN_LENGTH);
    expect(uncapped.length).toBeGreaterThan(cap); // the seed makes over-cap output possible
    expect(checkDepthCap(uncapped, CHAIN_LENGTH, cap).pass).toBe(false);
  });

  test('FAILS when any returned node sits deeper than the cap', () => {
    const nodes = [...chainNodes(cap), { depth: cap + 3 }];
    expect(checkDepthCap(nodes, CHAIN_LENGTH, cap).pass).toBe(false);
  });

  test('FAILS on an empty/shallow walk (a broken traversal cannot fake a pass)', () => {
    expect(checkDepthCap([], CHAIN_LENGTH, cap).pass).toBe(false);
    expect(checkDepthCap(chainNodes(2), CHAIN_LENGTH, cap).pass).toBe(false);
  });

  test('passes on a correctly capped walk (root + cap hops, none deeper than cap)', () => {
    const capped = chainNodes(cap + 1); // depths 0..cap
    expect(checkDepthCap(capped, CHAIN_LENGTH, cap).pass).toBe(true);
  });
});

describe('checkRemoteListClamp — can fail (agentic-cats-04 sibling)', () => {
  const cap = REMOTE_LIST_PAGES_CAP;

  test('FAILS when the remote list returns more rows than the cap', () => {
    expect(checkRemoteListClamp(TOTAL_SEEDED_PAGES, TOTAL_SEEDED_PAGES, cap).pass).toBe(false);
  });

  test('FAILS when the seed does not exceed the cap (vacuous check is a fail, not a pass)', () => {
    // The pre-fix version asserted <= 1000 over 10 seeded pages — unfailable.
    expect(checkRemoteListClamp(10, 10, cap).pass).toBe(false);
  });

  test('passes when more pages exist than the cap and the cap held', () => {
    expect(checkRemoteListClamp(cap, TOTAL_SEEDED_PAGES, cap).pass).toBe(true);
  });
});

describe('trust-matrix checks — can fail (agentic-cats-05)', () => {
  const cap = REMOTE_LIST_PAGES_CAP;

  test('list_pages matrix FAILS when remote is as permissive as local', () => {
    expect(checkListPagesTrustMatrix(120, 120, cap).pass).toBe(false);
  });

  test('list_pages matrix FAILS when local is clamped too (no differential observed)', () => {
    expect(checkListPagesTrustMatrix(cap, cap, cap).pass).toBe(false);
  });

  test('list_pages matrix passes when local honored above the cap and remote clamped', () => {
    expect(checkListPagesTrustMatrix(120, cap, cap).pass).toBe(true);
  });

  test('mode differential FAILS when local accepts an unknown mode', () => {
    expect(checkModeDifferential({ ok: true }, { ok: true }).pass).toBe(false);
  });

  test('mode differential FAILS when remote validates the mode like local (no trust difference)', () => {
    const reject = { ok: false, error: "Unknown search mode 'x'. Valid: conservative, balanced, tokenmax." };
    expect(checkModeDifferential(reject, reject).pass).toBe(false);
  });

  test('mode differential passes when local loudly rejects and remote ignores', () => {
    const localReject = { ok: false, error: "Unknown search mode 'x'. Valid: conservative, balanced, tokenmax." };
    expect(checkModeDifferential(localReject, { ok: true }).pass).toBe(true);
  });
});

describe('handler sanity walk is separate from behavioral results (agentic-cats-13)', () => {
  test('walk reports the registry size and missing handlers, not per-op pass rows', () => {
    const walk = handlerSanityWalk();
    expect(walk.total).toBeGreaterThan(100); // the ~135-op registry
    expect(walk.missing).toEqual([]);
  });
});

// ─── Layer 2: real engine, real handlers ──────────────────────────────

describe('mcp-contract integration (PGLite, hermetic)', () => {
  test('all behavioral checks pass against the pinned gbrain, and both trust contexts ran', async () => {
    const { engine, cleanup } = await setupEngine();
    try {
      const results = await runContractChecks(engine);

      // The behavioral list is the ~22 contract assertions, NOT the ~135
      // handler rows (agentic-cats-13).
      expect(results.length).toBeGreaterThan(15);
      expect(results.length).toBeLessThan(40);

      const failures = results.filter(r => !r.pass);
      expect(failures.map(f => `${f.name}: ${f.detail}`)).toEqual([]);

      // The trust matrix genuinely ran both remote=false and remote=true.
      const matrixList = results.find(r => r.name.includes('honored locally, clamped'));
      expect(matrixList).toBeDefined();
      expect(matrixList!.detail).toMatch(/local returned \d+ rows, remote returned \d+/);

      const matrixMode = results.find(r => r.name.includes('rejected locally, ignored remotely'));
      expect(matrixMode).toBeDefined();
      expect(matrixMode!.detail).toContain('Unknown search mode');

      // The depth-cap assertion ran over a chain longer than the cap.
      const depth = results.find(r => r.name.includes('stops at the'));
      expect(depth).toBeDefined();
      expect(depth!.detail).toContain(`${CHAIN_LENGTH}-node chain`);
    } finally {
      await cleanup();
    }
  }, 180_000);
});
