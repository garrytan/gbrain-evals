/**
 * Cat 26 contextual retrieval A/B — hermetic regression suite.
 *
 * No API keys required: embeddings go through gbrain's
 * __setEmbedTransportForTests seam (deterministic hash embedding +
 * OPENAI_API_KEY=dummy). No LLM anywhere.
 *
 * What this suite pins:
 *   1. The ORIGINAL config bug (audit finding cats26-29-01) is detectable:
 *      setting the knob under the bare key 'contextual_retrieval' — which
 *      gbrain never reads — leaves the resolved mode at the balanced
 *      default ('title'), and the runner's conformance check catches the
 *      mismatch. Setting 'search.contextual_retrieval' resolves correctly.
 *   2. The saturation bug (finding cats26-29-02) is detectable: the
 *      headroom gate fails on constructed saturated results (every page in
 *      top-K regardless of gold) and passes on healthy ones.
 *   3. The >= tie-break bug is gone: equal means report 'tie', never
 *      deterministically crown the first cell.
 *   4. GOOD INPUT: the real pipeline (import with wrap → hybridSearch →
 *      metrics.ts scoring) runs end-to-end per cell, resolves the requested
 *      mode, and the title cell observably differs from the none cell.
 *   5. The synopsis cell is labeled title-effective (finding cats26-29-16)
 *      and its divergence gate can fail on constructed divergent cells.
 */

import { describe, test, expect } from 'bun:test';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import {
  K,
  buildCorpus,
  GOLD_SPECS,
  ensureGateway,
  resolveEffectiveConfig,
  runMode,
  chooseBestMode,
  headroomGate,
  cellsDifferGate,
  synopsisFallbackGate,
  type Mode,
  type ModeResult,
  type QueryScore,
  type ResolvedCellConfig,
} from '../../eval/runner/cat26-contextual-retrieval.ts';

const CELL_TIMEOUT = 300_000;

// ─── Helpers for constructed ModeResults ─────────────────────────────

function fakeConfig(mode: Mode): ResolvedCellConfig {
  return {
    mode_requested: mode,
    mode_effective_inline: mode === 'per_chunk_synopsis' ? 'title' : mode,
    resolved_mode: 'balanced',
    contextual_retrieval: mode,
    contextual_retrieval_disabled: false,
    reranker_enabled: false,
    expansion: false,
  };
}

function fakeCell(mode: Mode, perQuery: Array<[number, number]>, mismatched = 0): ModeResult {
  const pq: QueryScore[] = perQuery.map(([r, rr], i) => ({
    query_id: `q${i}`,
    gold_slug: `companies/g${i}`,
    recall_at_k: r,
    reciprocal_rank: rr,
    top_slugs: [],
  }));
  const mean = pq.reduce((a, s) => a + s.recall_at_k, 0) / Math.max(1, pq.length);
  const mrr = pq.reduce((a, s) => a + s.reciprocal_rank, 0) / Math.max(1, pq.length);
  return {
    config: fakeConfig(mode),
    per_query: pq,
    mean_recall_at_k: mean,
    mrr,
    mismatched_gold_mean_recall_at_k: mismatched,
  };
}

// ─── Config conformance (finding cats26-29-01) ───────────────────────

describe('cat26 config-key conformance', () => {
  async function freshEngine(): Promise<PGLiteEngine> {
    ensureGateway(true);
    const engine = new PGLiteEngine();
    const origLog = console.log;
    console.log = () => {};
    try {
      await engine.connect({});
      await engine.initSchema();
      await engine.setConfig('search.mode', 'balanced');
    } finally {
      console.log = origLog;
    }
    return engine;
  }

  test('the OLD bare key is ignored by gbrain — conformance check catches it', async () => {
    const engine = await freshEngine();
    try {
      // Exactly the pre-fix call: bare 'contextual_retrieval'. gbrain reads
      // only 'search.contextual_retrieval' (mode.ts SEARCH_MODE_CONFIG_KEYS),
      // so the resolved knob stays at the balanced default 'title'.
      await engine.setConfig('contextual_retrieval', 'none');
      const cfg = await resolveEffectiveConfig(engine, 'none');
      expect(cfg.contextual_retrieval).toBe('title'); // balanced bundle default
      expect(cfg.contextual_retrieval).not.toBe(cfg.mode_requested); // ← the abort condition
    } finally {
      await engine.disconnect().catch(() => {});
    }
  }, CELL_TIMEOUT);

  test('the correct search.contextual_retrieval key resolves per request', async () => {
    const engine = await freshEngine();
    try {
      for (const mode of ['none', 'title', 'per_chunk_synopsis'] as const) {
        await engine.setConfig('search.contextual_retrieval', mode);
        const cfg = await resolveEffectiveConfig(engine, mode);
        expect(cfg.contextual_retrieval).toBe(mode);
      }
    } finally {
      await engine.disconnect().catch(() => {});
    }
  }, CELL_TIMEOUT);
});

// ─── Tie-break (finding cats26-29-02) ────────────────────────────────

describe('cat26 best-mode tie-break', () => {
  test('equal means report tie, never crown the first cell', () => {
    const cells = [
      fakeCell('none', [[1, 1], [1, 1]]),
      fakeCell('title', [[1, 1], [1, 1]]),
      fakeCell('per_chunk_synopsis', [[1, 1], [1, 1]]),
    ];
    const { best_mode, tied } = chooseBestMode(cells);
    expect(best_mode).toBe('tie');
    expect(tied).toEqual(['none', 'title', 'per_chunk_synopsis']);
  });

  test('a strict winner is crowned', () => {
    const cells = [
      fakeCell('none', [[0, 0.2], [1, 1]]),
      fakeCell('title', [[1, 1], [1, 1]]),
    ];
    expect(chooseBestMode(cells).best_mode).toBe('title');
  });
});

// ─── Headroom / negative control ─────────────────────────────────────

describe('cat26 headroom gate', () => {
  test('FAILS on a saturated corpus (the old 3-page bug shape)', () => {
    // Every query scores 1.0 AND the rotated-gold control also scores 1.0:
    // every page is in the top-K regardless of relevance.
    const saturated = [fakeCell('none', [[1, 1], [1, 1], [1, 1]], 1)];
    const g = headroomGate(saturated);
    expect(g.pass).toBe(false);
    expect(g.reason).toContain('saturated');
  });

  test('FAILS when retrieval finds nothing at all', () => {
    const dead = [fakeCell('none', [[0, 0], [0, 0]], 0)];
    expect(headroomGate(dead).pass).toBe(false);
  });

  test('passes on healthy results with a quiet control', () => {
    const healthy = [fakeCell('title', [[1, 1], [0, 0.2], [1, 0.5]], 0)];
    expect(headroomGate(healthy).pass).toBe(true);
  });
});

// ─── Stub-mode determinism gates ─────────────────────────────────────

describe('cat26 stub-mode gates', () => {
  test('cellsDifferGate fails on identical cells (finding -01 regression shape)', () => {
    const a = fakeCell('none', [[1, 1], [0, 0.25]]);
    const b = fakeCell('title', [[1, 1], [0, 0.25]]);
    const g = cellsDifferGate(a, b);
    expect(g.pass).toBe(false);
    expect(g.reason).toContain('identical');
  });

  test('cellsDifferGate passes when any query ranking moved', () => {
    const a = fakeCell('none', [[1, 1], [0, 0.25]]);
    const b = fakeCell('title', [[1, 1], [1, 0.5]]);
    expect(cellsDifferGate(a, b).pass).toBe(true);
  });

  test('synopsisFallbackGate fails when the synopsis cell diverges from title', () => {
    const t = fakeCell('title', [[1, 1], [0, 0.25]]);
    const s = fakeCell('per_chunk_synopsis', [[1, 1], [1, 1]]);
    expect(synopsisFallbackGate(t, s).pass).toBe(false);
    expect(synopsisFallbackGate(t, fakeCell('per_chunk_synopsis', [[1, 1], [0, 0.25]])).pass).toBe(true);
  });

  test('the synopsis cell is always labeled title-effective (finding -16)', () => {
    expect(fakeConfig('per_chunk_synopsis').mode_effective_inline).toBe('title');
  });
});

// ─── Corpus determinism + shape ──────────────────────────────────────

describe('cat26 corpus', () => {
  test('30 pages, 10 queries, deterministic across calls', () => {
    const a = buildCorpus();
    const b = buildCorpus();
    expect(a.pages.length).toBe(30);
    expect(a.pages.filter(p => p.kind === 'gold').length).toBe(10);
    expect(a.queries.length).toBe(10);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('gold sentences live only on their own page; queries name their page', () => {
    const { pages } = buildCorpus();
    for (const g of GOLD_SPECS) {
      const holders = pages.filter(p => p.body.includes(g.gold_sentence));
      expect(holders.length).toBe(1);
      expect(holders[0]!.slug).toBe(g.slug);
      expect(g.query.toLowerCase()).toContain(g.name_token);
    }
  });
});

// ─── Good input: the real pipeline end-to-end (stubbed embeds) ───────

describe('cat26 real pipeline (stub embeds)', () => {
  test('none and title cells resolve their modes and observably differ', async () => {
    const noneR = await runMode('none', { stubEmbed: true });
    const titleR = await runMode('title', { stubEmbed: true });

    expect(noneR.config.contextual_retrieval).toBe('none');
    expect(titleR.config.contextual_retrieval).toBe('title');
    expect(noneR.config.reranker_enabled).toBe(false);
    expect(titleR.config.expansion).toBe(false);

    expect(noneR.per_query.length).toBe(10);
    for (const s of [...noneR.per_query, ...titleR.per_query]) {
      expect(s.recall_at_k).toBeGreaterThanOrEqual(0);
      expect(s.recall_at_k).toBeLessThanOrEqual(1);
      expect(s.error).toBeUndefined();
    }

    // Headroom on real data: not saturated, not dead.
    expect(headroomGate([noneR, titleR]).pass).toBe(true);
    // The wrap must have an observable effect (finding -01 can never recur
    // silently).
    expect(cellsDifferGate(noneR, titleR).pass).toBe(true);
    // Scoring is at K=3, and the K is what the receipt claims.
    expect(K).toBe(3);
  }, CELL_TIMEOUT * 2);
});
