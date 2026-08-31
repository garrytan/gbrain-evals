/**
 * Semantic-parity guard for the de-ava'd PrecisionMemBench scorer, plus
 * hermetic regression tests for the 2026-08-31 audit findings:
 *
 *   - precisionmembench-01: seed.ts no longer consumes the fixture's
 *     ground-truth `superseded_by` to pre-hide beliefs — superseded beliefs
 *     are seeded LIVE and gbrain search can find them.
 *   - precisionmembench-02: --mode/--fidelity are whitelisted; unknown values
 *     hard-error instead of silently running plain hybrid under a bogus label.
 *   - precisionmembench-03: the resolved run config reaches both the report
 *     filename and the payload, so distinct configs can never collide.
 *   - precisionmembench-05: separatrix captures are keyed by case id, not
 *     query text — cases sharing a query cannot overwrite each other.
 *   - precisionmembench-06: partial (--limit) runs are labeled not-comparable
 *     next to the full-77 published leaderboard rows.
 *   - precisionmembench-07: the cliff gate normalizes by a positive magnitude,
 *     so negative (post-rerank) scores no longer sign-flip the gap ratios and
 *     silently disable the cliff.
 *
 * The scoring math (precision/recall/pinnedCoverage + the mustInclude/
 * mustExclude/shouldOnlyInclude/maxCount assertions) was lifted verbatim from
 * upstream's `retrieval.external.eval.test.ts`. The parity block pins that the
 * de-ava'ing did not change the math: a controlled adapter returns known sets
 * through `scoreCases` and we assert the exact precision/recall/passed values.
 *
 * See eval/precisionmembench/ATTRIBUTION.md (faithfulness invariant: semantic
 * parity, timings normalized out).
 *
 * Hermetic: no API keys, no network. Engine tests use in-memory PGLite with
 * noEmbed seeding + keyword (FTS) search only.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BaseAdapter } from '../../eval/precisionmembench/scorer/baseAdapter.ts';
import { scoreCases, pinnedInSeedSet, coerceBelief, type RetrievalCase } from '../../eval/precisionmembench/scorer/runCases.ts';
import type { Belief } from '../../eval/precisionmembench/scorer/belief.ts';
import { applyReturnPolicy } from '../../eval/precisionmembench/gate-proto.ts';
import { createBenchEngine, seedGbrainEngine } from '../../eval/precisionmembench/seed.ts';
import { parseOpts, reportFileName, leaderboardRows, main as runnerMain } from '../../eval/runner/precisionmembench.ts';
import { captureSeparatrix, computeSeparatrix, main as instrumentMain } from '../../eval/runner/precisionmembench-instrument.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';

// Minimal belief corpus (domain:code scope, none pinned so buildContext's
// pinned/relation/question paths stay empty and we isolate searchText scoring).
const RAW: Record<string, unknown>[] = [
  { _id: 'b1', user_id: 'test-user', type: 'entity', canonical_name: 'redis', aliases: ['cache'], content: 'redis cache', why_it_matters: '', scope: ['domain:code'], pinned: false, superseded_by: null },
  { _id: 'b2', user_id: 'test-user', type: 'entity', canonical_name: 'kubernetes', aliases: ['k8s'], content: 'k8s', why_it_matters: '', scope: ['domain:code'], pinned: false, superseded_by: null },
  { _id: 'b3', user_id: 'test-user', type: 'entity', canonical_name: 'postgres', aliases: ['pg'], content: 'pg', why_it_matters: '', scope: ['domain:code'], pinned: false, superseded_by: null },
];
const BELIEFS: Belief[] = RAW.map(coerceBelief);

/** Adapter whose searchText returns a fixed belief-id list per query. */
class StubAdapter extends BaseAdapter {
  constructor(private readonly returns: Record<string, string[]>) {
    super('gbrain');
  }
  override async searchText(
    _userId: string,
    query: string,
    opts?: { excludeIds?: Set<string> },
  ): Promise<Belief[]> {
    const ids = this.returns[query] ?? [];
    const out: Belief[] = [];
    for (const id of ids) {
      if (opts?.excludeIds?.has(id)) continue;
      const b = this.seedIndex.get(id);
      if (b) out.push(b);
    }
    return out;
  }
}

function run(returns: Record<string, string[]>, cases: RetrievalCase[]) {
  const adapter = new StubAdapter(returns);
  adapter.loadFixture(BELIEFS);
  return scoreCases(adapter, cases, pinnedInSeedSet(BELIEFS));
}

describe('scoreCases semantic parity', () => {
  test('shouldOnlyInclude exact match → precision 1.0, recall 1.0, pass', async () => {
    const [r] = await run(
      { 'redis?': ['b1'] },
      [{ caseId: 'c1', category: 'Alias resolution', description: '', scope: ['domain:code'], query: 'redis?', expect: { relevantBeliefs: { shouldOnlyInclude: ['b1'] } } }],
    );
    expect(r.retrievalPrecision).toBe(1);
    expect(r.retrievalRecall).toBe(1);
    expect(r.passed).toBe(true);
  });

  test('extra belief beyond shouldOnlyInclude → precision 0.5 AND fail', async () => {
    const [r] = await run(
      { q: ['b1', 'b2'] },
      [{ caseId: 'c2', category: 'Alias resolution', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { shouldOnlyInclude: ['b1'] } } }],
    );
    expect(r.retrievalPrecision).toBe(0.5); // 1 hit / 2 returned
    expect(r.retrievalRecall).toBe(1); // 1 hit / 1 expected
    expect(r.passed).toBe(false); // unexpected belief b2
    expect(r.failures.some((f) => f.includes('b2'))).toBe(true);
  });

  test('two expected, one returned → precision 1.0, recall 0.5, pass (no shouldOnly)', async () => {
    const [r] = await run(
      { q: ['b1'] },
      [{ caseId: 'c3', category: 'Alias resolution', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { mustInclude: ['b1', 'b2'] } } }],
    );
    // mustInclude b2 missing → fail; precision = 1 returned hit / 1 returned;
    // recall = 1 hit / 2 expected.
    expect(r.retrievalPrecision).toBe(1);
    expect(r.retrievalRecall).toBe(0.5);
    expect(r.passed).toBe(false);
  });

  test('empty-expected + empty-returned → precision null, recall null, pass', async () => {
    const [r] = await run(
      { q: [] },
      [{ caseId: 'c4', category: 'Type routing and open questions', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { shouldOnlyInclude: [] } } }],
    );
    expect(r.retrievalPrecision).toBeNull();
    expect(r.retrievalRecall).toBeNull();
    expect(r.passed).toBe(true);
  });

  test('empty-expected + non-empty-returned → precision 0.0, pass=false', async () => {
    const [r] = await run(
      { q: ['b1'] },
      [{ caseId: 'c5', category: 'Type routing and open questions', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { shouldOnlyInclude: [] } } }],
    );
    expect(r.retrievalPrecision).toBe(0); // 0 hits / 1 returned
    expect(r.passed).toBe(false); // b1 unexpected
  });

  test('mustExclude violation fails the case', async () => {
    const [r] = await run(
      { q: ['b1', 'b3'] },
      [{ caseId: 'c6', category: 'Scope disambiguation', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { mustInclude: ['b1'], mustExclude: ['b3'] } } }],
    );
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.includes('b3'))).toBe(true);
  });

  test('maxCount violation fails', async () => {
    const [r] = await run(
      { q: ['b1', 'b2', 'b3'] },
      [{ caseId: 'c7', category: 'Budget eviction and capacity', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { maxCount: 2 } } }],
    );
    expect(r.passed).toBe(false);
    expect(r.relevantBeliefs.length).toBe(3);
  });
});

// ─── Shared fixture builder for the engine-backed tests ───────────────

function makeBelief(over: Partial<Record<keyof Belief, unknown>> & { _id: string }): Belief {
  return coerceBelief({
    user_id: 'test-user',
    agent_id: null,
    type: 'entity',
    canonical_name: over._id,
    aliases: [],
    content: '',
    why_it_matters: '',
    scope: ['domain:code'],
    pinned: false,
    user_edited: false,
    superseded_by: null,
    resolved_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as Record<string, unknown>);
}

// ─── precisionmembench-07: cliff gate sign-flip guard ─────────────────

describe('gate-proto cliff gate (finding precisionmembench-07)', () => {
  test('negative ordering scores: cliff is still detected and cut correctly', () => {
    // Post-rerank rerank_score can be negative (cross-encoders are unbounded
    // below). Pre-fix, top=-0.5 sign-flipped every gap ratio: cliffFound was
    // always false (kept all 3) and cut-point selection inverted.
    const sorted = [
      { id: 'a', score: -0.5 },
      { id: 'b', score: -0.6 },
      { id: 'c', score: -5 },
    ];
    const { kept, decision } = applyReturnPolicy(sorted, { kind: 'cliff', minKeep: 1, minGapRatio: 0.2 });
    expect(decision.cliffFound).toBe(true);
    expect(kept.map((k) => k.id)).toEqual(['a', 'b']);
  });

  test('positive scores: behavior unchanged (cliff at the big gap)', () => {
    const sorted = [
      { id: 'a', score: 10 },
      { id: 'b', score: 9.8 },
      { id: 'c', score: 2 },
    ];
    const { kept, decision } = applyReturnPolicy(sorted, { kind: 'cliff', minKeep: 1, minGapRatio: 0.2 });
    expect(decision.cliffFound).toBe(true);
    expect(kept.map((k) => k.id)).toEqual(['a', 'b']);
  });

  test('flat distribution (positive or negative): no cliff, keep all', () => {
    for (const sign of [1, -1]) {
      const sorted = [
        { id: 'a', score: sign * 10 },
        { id: 'b', score: sign * 9.9 },
        { id: 'c', score: sign * 9.8 },
      ];
      const { kept, decision } = applyReturnPolicy(sorted, { kind: 'cliff', minKeep: 1, minGapRatio: 0.2 });
      expect(decision.cliffFound).toBe(false);
      expect(kept.length).toBe(3);
    }
  });
});

// ─── precisionmembench-02: strict CLI whitelisting ─────────────────────

describe('runner parseOpts (finding precisionmembench-02)', () => {
  test('the exact bogus mode from the audit hard-errors instead of running plain hybrid', () => {
    expect(() => parseOpts(['--mode', 'gbrain-adaptive-tight'])).toThrow(/--mode must be one of/);
  });

  test('unknown fidelity hard-errors instead of silently running body-text', () => {
    expect(() => parseOpts(['--fidelity', 'markdown'])).toThrow(/--fidelity must be one of/);
  });

  test('unknown flags and bad numeric values hard-error', () => {
    expect(() => parseOpts(['--bogus'])).toThrow(/unknown arg/);
    expect(() => parseOpts(['--limit', '0'])).toThrow(/--limit/);
    expect(() => parseOpts(['--limit', 'abc'])).toThrow(/--limit/);
    expect(() => parseOpts(['--entity-max'])).toThrow(/requires a value/);
  });

  test('valid opts parse; gbrain-keyword forces noEmbed', () => {
    const o = parseOpts(['--mode', 'gbrain-adaptive', '--entity-max', '1', '--other-max', '2', '--limit', '10']);
    expect(o.mode).toBe('gbrain-adaptive');
    expect(o.entityMax).toBe(1);
    expect(o.otherMax).toBe(2);
    expect(o.limit).toBe(10);
    expect(parseOpts(['--mode', 'gbrain-keyword']).noEmbed).toBe(true);
    expect(parseOpts([]).mode).toBe('gbrain-hybrid');
  });
});

// ─── precisionmembench-03: config-stamped filenames ────────────────────

describe('report filename provenance (finding precisionmembench-03)', () => {
  const base = { mode: 'gbrain-adaptive' as const, fidelity: 'body-text' as const, limit: null, noEmbed: false, entityMax: null, otherMax: null };

  test('adaptive runs with different caps get different filenames (no same-day clobber)', () => {
    const dflt = reportFileName('2026-05-30', base);
    const tight = reportFileName('2026-05-30', { ...base, entityMax: 1, otherMax: 1 });
    const loose = reportFileName('2026-05-30', { ...base, entityMax: 1, otherMax: 2 });
    expect(dflt).toBe('2026-05-30-gbrain-adaptive-body-text.json');
    expect(tight).toBe('2026-05-30-gbrain-adaptive-body-text-e1-o1.json');
    expect(loose).toBe('2026-05-30-gbrain-adaptive-body-text-e1-o2.json');
    expect(new Set([dflt, tight, loose]).size).toBe(3);
  });

  test('--limit and --no-embed reach the filename', () => {
    expect(reportFileName('2026-05-30', { ...base, limit: 10 })).toContain('limit10');
    expect(reportFileName('2026-05-30', { ...base, mode: 'gbrain-hybrid', noEmbed: true })).toContain('noembed');
    // keyword mode is inherently no-embed; no redundant suffix
    expect(reportFileName('2026-05-30', { ...base, mode: 'gbrain-keyword', noEmbed: true })).toBe('2026-05-30-gbrain-keyword-body-text.json');
  });
});

// ─── precisionmembench-06: partial-run labeling ────────────────────────

describe('leaderboard partial labeling (finding precisionmembench-06)', () => {
  test('a --limit run is labeled PARTIAL / not comparable next to full-77 rows', () => {
    const rows = leaderboardRows('gbrain-keyword-body-text', { meanPrecision: 0.19, activeRetrievalPasses: 1, totalPassed: 4, totalCases: 10 }, 77);
    const gbrain = rows.find((r) => r.name.includes('gbrain'))!;
    expect(gbrain.name).toContain('PARTIAL n=10/77');
    expect(gbrain.name).toContain('not comparable');
  });

  test('a full run carries no partial label', () => {
    const rows = leaderboardRows('gbrain-hybrid-body-text', { meanPrecision: 0.075, activeRetrievalPasses: 0, totalPassed: 7, totalCases: 77 }, 77);
    const gbrain = rows.find((r) => r.name.includes('gbrain'))!;
    expect(gbrain.name).not.toContain('PARTIAL');
  });
});

// ─── precisionmembench-01: the seed-time supersession leak is gone ─────

describe('seedGbrainEngine seeds superseded beliefs LIVE (finding precisionmembench-01)', () => {
  test('gbrain search can find a superseded belief after seeding', async () => {
    const engine = await createBenchEngine();
    try {
      const beliefs = [
        makeBelief({ _id: 'b-old-linter', canonical_name: 'TSLint linting', aliases: ['TSLint'], content: 'We lint with TSLint. Replaced by ESLint.', superseded_by: 'b-new-linter' }),
        makeBelief({ _id: 'b-new-linter', canonical_name: 'ESLint linting', aliases: ['ESLint'], content: 'We lint with ESLint now.' }),
      ];
      const stats = await seedGbrainEngine(engine, beliefs, { noEmbed: true });
      expect(stats.imported).toBe(2);
      expect(stats.supersededLive).toBe(1);
      // Pre-fix, seed.ts read the fixture's ground-truth superseded_by and
      // engine.softDeletePage'd b-old-linter — a signal the upstream provider
      // contract never delivers — so this search came back empty.
      const superseded = await engine.searchKeyword('TSLint', { limit: 10, sourceIds: ['domain-code'] });
      expect(superseded.map((r) => r.slug)).toContain('b-old-linter');
      // Good input: live beliefs are searchable too.
      const live = await engine.searchKeyword('ESLint', { limit: 10, sourceIds: ['domain-code'] });
      expect(live.map((r) => r.slug)).toContain('b-new-linter');
    } finally {
      await engine.disconnect();
    }
  }, 120_000);
});

// ─── precisionmembench-05: separatrix capture keyed by case id ─────────

describe('separatrix capture keying (finding precisionmembench-05)', () => {
  test('two cases sharing a query string get separate captures (engine-backed)', async () => {
    const engine = await createBenchEngine();
    try {
      const beliefs = [
        makeBelief({ _id: 'b-redis-code', canonical_name: 'Redis session cache', content: 'We are using Redis to cache API sessions.', scope: ['domain:code'] }),
        makeBelief({ _id: 'b-redis-hobby', canonical_name: 'Redis the fish', content: 'We are using Redis as the name of the aquarium fish.', scope: ['domain:hobby'] }),
      ];
      await seedGbrainEngine(engine, beliefs, { noEmbed: true });
      const sharedQuery = 'What are we using Redis for?';
      const cases: RetrievalCase[] = [
        { caseId: 'case-code', category: 'Scope disambiguation', description: '', scope: ['domain:code'], query: sharedQuery, expect: {} },
        { caseId: 'case-hobby', category: 'Scope disambiguation', description: '', scope: ['domain:hobby'], query: sharedQuery, expect: {} },
      ];
      const perCase = await captureSeparatrix(engine, beliefs, cases, new Set(), 'keyword');
      // Pre-fix the map was keyed by raw query text: these two cases
      // collapsed to ONE entry and the last write won.
      expect(perCase.size).toBe(2);
      expect(perCase.get('case-code')!.rankedIds).toEqual(['b-redis-code']);
      expect(perCase.get('case-hobby')!.rankedIds).toEqual(['b-redis-hobby']);
    } finally {
      await engine.disconnect();
    }
  }, 120_000);

  test('computeSeparatrix attributes each distribution to its own case', () => {
    const mk = (caseId: string, expectedId: string): RetrievalCase => ({
      caseId,
      category: 'Alias resolution',
      description: '',
      scope: ['domain:code'],
      query: 'shared query',
      expect: { relevantBeliefs: { shouldOnlyInclude: [expectedId] } },
    });
    const cases = [mk('c1', 'x'), mk('c2', 'y')];
    const perCase = new Map([
      // c1: expected 'x' IS rank 1; negative scores — gap must still be a
      // POSITIVE ratio (same magnitude guard as gate-proto).
      ['c1', { query: 'shared query', scores: [-0.5, -0.6], rankedIds: ['x', 'z'] }],
      // c2: expected 'y' is NOT rank 1.
      ['c2', { query: 'shared query', scores: [0.9, 0.8], rankedIds: ['z', 'y'] }],
    ]);
    const s = computeSeparatrix(cases, perCase, new Set());
    // Query-keyed capture (the pre-fix bug) reads ONE distribution for both
    // cases, so rank1 could only be 0 or 2 — never the correct 1/2 split.
    expect(s.single).toBe(2);
    expect(s.rank1).toBe(1);
    expect(s.medGapCorrect).toBeCloseTo(0.2, 5);
    expect(s.medGapWrong).toBeCloseTo((0.9 - 0.8) / 0.9, 5);
  });
});

// ─── Receipts + config provenance: hermetic end-to-end runner runs ─────

describe('runner receipts + payload provenance (findings -02/-03/-06 + WS0 receipt contract)', () => {
  test('hermetic keyword --limit run: config-stamped filename + payload, completed receipt, partial not publishable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pmb-run-'));
    const receiptFile = join(dir, 'receipt.json');
    const code = await runnerMain(['--mode', 'gbrain-keyword', '--limit', '5', '--report-dir', dir, '--receipt-path', receiptFile]);
    expect(code).toBe(0);

    const rec = loadReceipt(receiptFile);
    expect(rec.category).toBe('precisionmembench');
    expect(rec.run_status).toBe('completed');
    expect(rec.verdict).toBe('partial'); // --limit run is a partial measurement
    expect(rec.publishable).toBe(false); // prefix-slice partials never publish
    expect(rec.n_total).toBe(5);
    expect(rec.n_scored).toBe(5);
    expect(rec.gbrain_version).not.toBe('unknown');
    expect(rec.gbrain_pin).not.toBe('unknown');

    const reportFiles = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'receipt.json');
    expect(reportFiles.length).toBe(1);
    expect(reportFiles[0]).toContain('gbrain-keyword-body-text-limit5');

    const payload = JSON.parse(readFileSync(join(dir, reportFiles[0]), 'utf8')) as {
      config: Record<string, unknown>;
      retrieval: { totalCases: number };
    };
    expect(payload.config.mode).toBe('gbrain-keyword');
    expect(payload.config.limit).toBe(5);
    expect(payload.config.partial).toBe(true);
    expect(payload.config.full_case_count).toBe(77);
    // The 4 superseded fixture beliefs are in the live index, not soft-deleted.
    expect(payload.config.superseded_seeded_live).toBe(4);
    expect(payload.retrieval.totalCases).toBe(5);
  }, 240_000);

  test('embedding mode without OPENAI_API_KEY: skipped receipt + exit 2; --allow-skip exits 0', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'pmb-skip-'));
      const receiptFile = join(dir, 'receipt.json');
      const code = await runnerMain(['--mode', 'gbrain-hybrid', '--report-dir', dir, '--receipt-path', receiptFile]);
      expect(code).toBe(2);
      const rec = loadReceipt(receiptFile);
      expect(rec.run_status).toBe('skipped');
      expect(rec.publishable).toBe(false);
      expect(rec.skip_reason).toContain('OPENAI_API_KEY');

      const code2 = await runnerMain(['--mode', 'gbrain-hybrid', '--report-dir', dir, '--receipt-path', receiptFile, '--allow-skip']);
      expect(code2).toBe(0);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  test('instrument hybrid without OPENAI_API_KEY: skipped receipt + exit 2', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'pmb-inst-skip-'));
      const receiptFile = join(dir, 'receipt.json');
      const code = await instrumentMain(['--report-dir', dir, '--receipt-path', receiptFile]);
      expect(code).toBe(2);
      const rec = loadReceipt(receiptFile);
      expect(rec.category).toBe('precisionmembench-instrument');
      expect(rec.run_status).toBe('skipped');
      expect(rec.publishable).toBe(false);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});
