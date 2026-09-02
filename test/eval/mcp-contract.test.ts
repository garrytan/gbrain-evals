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
  checkRemoteDirectionDefault,
  checkRemoteListClamp,
  checkListPagesTrustMatrix,
  checkModeDifferential,
  handlerSanityWalk,
  runContractChecks,
  setupEngine,
  chainSlug,
  CHAIN_LENGTH,
  CHAIN_SLUGS,
  CHAIN_INBOUND_SLUG,
  TOTAL_SEEDED_PAGES,
  TRAVERSE_DEPTH_CAP,
  REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH,
  REMOTE_LIST_PAGES_CAP,
  type GraphEdgeRow,
} from '../../eval/runner/mcp-contract.ts';

// ─── Layer 1: the checks can fail ─────────────────────────────────────

// GraphPath rows as gbrain v0.48.1.0 (#4704) returns them to remote callers.
type EdgeRow = GraphEdgeRow & { link_type: string; context: string };

function edge(from_slug: string, to_slug: string, depth: number): EdgeRow {
  return { from_slug, to_slug, link_type: 'mentions', context: '', depth };
}

/** Outbound chain edges c0→c1 … c(hops-1)→c(hops) at depths 1..hops — what an `out` walk emits. */
function chainEdges(hops: number): EdgeRow[] {
  return Array.from({ length: hops }, (_, i) => edge(chainSlug(i), chainSlug(i + 1), i + 1));
}

/**
 * What gbrain's `both` walk actually emits over the seeded chain: every walk
 * node at depth d < hops emits ALL its adjacent edges at depth d+1 (so each
 * walked edge appears twice, once from each end), plus the inbound edge into
 * the root — from the root at depth 1 and from the inbound page at depth 2.
 */
function bidirectionalEdges(hops: number): EdgeRow[] {
  const rows: EdgeRow[] = [];
  for (let i = 0; i < hops; i++) {
    if (i > 0) rows.push(edge(chainSlug(i - 1), chainSlug(i), i + 1));
    rows.push(edge(chainSlug(i), chainSlug(i + 1), i + 1));
  }
  rows.push(edge(CHAIN_INBOUND_SLUG, chainSlug(0), 1));
  if (hops > 1) rows.push(edge(CHAIN_INBOUND_SLUG, chainSlug(0), 2));
  return rows;
}

describe('checkDepthCap — can fail (agentic-cats-04)', () => {
  const cap = TRAVERSE_DEPTH_CAP;

  test('FAILS when an uncapped traverse reaches the whole chain (deeper than the cap)', () => {
    // What a regression deleting gbrain's TRAVERSE_DEPTH_CAP would return:
    // edges out to c15, max depth 15, every node of the 16-node chain touched.
    const uncapped = bidirectionalEdges(CHAIN_LENGTH - 1);
    expect(CHAIN_LENGTH - 1).toBeGreaterThan(cap); // the seed makes over-cap output possible
    expect(checkDepthCap(uncapped, CHAIN_SLUGS, cap).pass).toBe(false);
  });

  test('FAILS when any returned edge sits deeper than the cap', () => {
    // Chain reach is exactly right; only the depth is out of bounds.
    const rows = [...chainEdges(cap), edge(chainSlug(cap), 'notes/extra-000', cap + 3)];
    expect(checkDepthCap(rows, CHAIN_SLUGS, cap).pass).toBe(false);
  });

  test('FAILS on an empty/shallow walk (a broken traversal cannot fake a pass)', () => {
    expect(checkDepthCap([], CHAIN_SLUGS, cap).pass).toBe(false);
    expect(checkDepthCap(chainEdges(2), CHAIN_SLUGS, cap).pass).toBe(false);
  });

  test('FAILS if an explicit over-cap depth were dropped for the remote depth-2 default instead of clamped', () => {
    expect(REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH).toBeLessThan(cap);
    expect(checkDepthCap(bidirectionalEdges(REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH), CHAIN_SLUGS, cap).pass).toBe(false);
  });

  test('FAILS on the legacy GraphNode shape (remote callers must get GraphPath edges)', () => {
    const nodes = Array.from({ length: cap + 1 }, (_, i) => ({ slug: chainSlug(i), depth: i, links: [] }));
    expect(checkDepthCap(nodes, CHAIN_SLUGS, cap).pass).toBe(false);
  });

  test('FAILS when the chain is not longer than the cap (vacuous check is a fail, not a pass)', () => {
    expect(checkDepthCap(chainEdges(cap), CHAIN_SLUGS.slice(0, cap + 1), cap).pass).toBe(false);
  });

  test('passes on a correctly capped walk (frontier exactly at the cap), out-only or bidirectional', () => {
    expect(checkDepthCap(chainEdges(cap), CHAIN_SLUGS, cap).pass).toBe(true);
    expect(checkDepthCap(bidirectionalEdges(cap), CHAIN_SLUGS, cap).pass).toBe(true);
  });

  test('the same frontier check pins the documented remote depth-2 default', () => {
    const d = REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH;
    expect(checkDepthCap(bidirectionalEdges(d), CHAIN_SLUGS, d).pass).toBe(true);
    expect(checkDepthCap(bidirectionalEdges(d + 3), CHAIN_SLUGS, d).pass).toBe(false); // walked deeper than the default
    expect(checkDepthCap(bidirectionalEdges(d - 1), CHAIN_SLUGS, d).pass).toBe(false); // walked shallower
  });
});

describe('checkRemoteDirectionDefault — can fail (gbrain #4704 direction=both default)', () => {
  const inbound = { from_slug: CHAIN_INBOUND_SLUG, to_slug: chainSlug(0) };
  const outbound = { from_slug: chainSlug(0), to_slug: chainSlug(1) };

  test('FAILS on an outbound-only walk (the legacy default never returns the inbound edge)', () => {
    expect(checkRemoteDirectionDefault(chainEdges(TRAVERSE_DEPTH_CAP), inbound, outbound).pass).toBe(false);
  });

  test('FAILS on an inbound-only walk', () => {
    expect(checkRemoteDirectionDefault([edge(inbound.from_slug, inbound.to_slug, 1)], inbound, outbound).pass).toBe(false);
  });

  test('FAILS on legacy GraphNode rows and on an empty result', () => {
    const legacy = [{ slug: chainSlug(0), depth: 0, links: [{ to_slug: chainSlug(1), link_type: 'mentions' }] }];
    expect(checkRemoteDirectionDefault(legacy, inbound, outbound).pass).toBe(false);
    expect(checkRemoteDirectionDefault([], inbound, outbound).pass).toBe(false);
  });

  test('passes when both the inbound edge into the root and the outbound chain edge are returned', () => {
    expect(checkRemoteDirectionDefault(bidirectionalEdges(REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH), inbound, outbound).pass).toBe(true);
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

      // The depth-cap assertion ran over a chain longer than the cap and saw
      // GraphPath edges with the frontier exactly at the cap.
      const depth = results.find(r => r.name.includes('stops at the'));
      expect(depth).toBeDefined();
      expect(depth!.detail).toContain(`${CHAIN_LENGTH}-node chain`);
      expect(depth!.detail).toContain(`max depth ${TRAVERSE_DEPTH_CAP}, expected frontier ${TRAVERSE_DEPTH_CAP}`);

      // The direction=both default was observed on the real inbound edge, and
      // the fully-defaulted walk stopped at the documented depth.
      const direction = results.find(r => r.name.includes('defaults to direction=both'));
      expect(direction).toBeDefined();
      expect(direction!.detail).toContain(`inbound ${CHAIN_INBOUND_SLUG}→${chainSlug(0)}: returned`);
      const defaulted = results.find(r => r.name.includes('depth AND direction defaulted'));
      expect(defaulted).toBeDefined();
      expect(defaulted!.detail).toContain(
        `max depth ${REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH}, expected frontier ${REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH}`,
      );
    } finally {
      await cleanup();
    }
  }, 180_000);
});
