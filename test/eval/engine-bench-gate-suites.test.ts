import { describe, expect, test } from 'bun:test';
import { GATE_SUITE_SCHEMA, GATE_SUITES, amendmentLine, engineDir, judgeSuite, loadRun, type GateSuite } from '../../eval/runner/engine-bench/gate-suites.ts';
import { parseCat13Argv } from '../../eval/runner/cat13-conceptual.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gbrainFrames, recordRustRefusals, refusalSiteOf, rustRefusalSites, type EvalEngineKind } from '../../eval/runner/eval-engine.ts';

const ROW_IDS = ['cat13/ndcg5', 'cat13b/top1', 'cat10', 'cat12', 'cat7', 'brainbench/cats-1-2', 'brainbench/cat3', 'brainbench/cat4',
  'brainbench/type-accuracy', 'brainbench/cat24', 'memory-verb-conformance', 'cat22', 'cat19', 'cat27', 'cat23'];
const suite = (id: string): GateSuite => GATE_SUITES.find(s => s.id === id)!;
const build = (commit = 'b66e4077', addon: string | null = 'ab'.repeat(32)) => ({
  version: '0.60.762.0', overlay: { commit, ref: commit, checkout_dirty: false }, rust_addon: addon ? { sha256: addon, target: 'linux-x64-glibc' } : null,
});
function receipt(kind: EvalEngineKind, extra: Record<string, unknown>, commit?: string) {
  return { run_status: 'completed', verdict: 'pass', n_total: 24, n_scored: 24, errors: [], engine: kind, gbrain_under_test: build(commit, kind === 'rust' ? 'ab'.repeat(32) : null), ...extra };
}
const runs = (make: (k: EvalEngineKind) => Record<string, unknown> | null, refused: Partial<Record<EvalEngineKind, string>> = {}, refusalSites: unknown[] = []) =>
  Object.fromEntries((['pglite', 'postgres', 'rust'] as const).map(k => [k, { kind: k, receipt: make(k), refused: refused[k] ?? null, refusalSites: k === 'rust' ? refusalSites : [] }])) as any;

describe('gate suites', () => {
  test('one suite per row id GBEV-98 reads, each with an amendment line', () => {
    expect(GATE_SUITES.map(s => s.id)).toEqual(ROW_IDS);
    for (const s of GATE_SUITES) expect(amendmentLine(s)).toContain(s.id);
  });

  test('a count gate passes only when Rust passes every case', () => {
    const conf = (passed: number) => ({ data: { summary: { cases_passed: passed, cases_total: 24 } } });
    const pass = judgeSuite(suite('memory-verb-conformance'), runs(k => receipt(k, conf(24))), { counted: false });
    expect(pass).toMatchObject({ schema: GATE_SUITE_SCHEMA, verdict: 'PASS', losses: [] });
    const fail = judgeSuite(suite('memory-verb-conformance'), runs(k => k === 'rust'
      ? receipt(k, { ...conf(18), verdict: 'fail', errors: [{ probe_id: 'entity miss', message: 'engine_capability_missing' }] })
      : receipt(k, conf(24))), { counted: false });
    expect(fail.verdict).toBe('FAIL');
    expect(fail.losses[0].reason).toContain('18/24');
    expect(fail.losses[0].reason).toContain('entity miss');
  });

  test('a ranked gate needs Rust at least both TypeScript values', () => {
    const top1 = (v: number) => ({ data: { scorecard: [{ name: 'gbrain', top1_hit_rate: v }] } });
    const ok = judgeSuite(suite('cat13b/top1'), runs(k => receipt(k, top1(k === 'postgres' ? 0.9 : 0.93))), { counted: true });
    expect(ok.verdict).toBe('PASS');
    expect(ok.counted).toBe(true);
    const lose = judgeSuite(suite('cat13b/top1'), runs(k => receipt(k, top1(k === 'rust' ? 0.9 : 0.93))), { counted: false });
    expect(lose.verdict).toBe('FAIL');
    expect(lose.losses.map(l => l.id)).toEqual(['cat13b/top1:top1:vs-pglite', 'cat13b/top1:top1:vs-postgres']);
  });

  test('E3 counts must be equal and points within 0.5', () => {
    const c19 = (score: number, errors: unknown[] = [], g3 = 1) => ({ n_total: 5, n_scored: 5, errors, data: { achieved: { brain_score: score }, gates: { g1: 1, g2: 1, g3, g4: 1, g5: 1 } } });
    expect(judgeSuite(suite('cat19'), runs(k => receipt(k, c19(k === 'rust' ? 85.4 : 85))), { counted: false }).verdict).toBe('PASS');
    expect(judgeSuite(suite('cat19'), runs(k => receipt(k, k === 'rust' ? c19(50, [{ probe_id: 'embed' }], 0) : c19(85))), { counted: false }).verdict).toBe('FAIL');
  });

  test('Cat 19 counts a gate scored 0 without an error as failed, and a receipt without gate scores is NOT_RUN', () => {
    const c19 = (g3: number) => ({ n_total: 5, n_scored: 5, data: { achieved: { brain_score: 85 }, gates: { g1: 1, g2: 1, g3, g4: 1, g5: 1 } } });
    const r = judgeSuite(suite('cat19'), runs(k => receipt(k, c19(k === 'rust' ? 0 : 1))), { counted: false });
    expect(r.verdict).toBe('FAIL');
    expect(r.losses[0]).toMatchObject({ id: 'cat19:gates_passed:vs-pglite', reason: 'Rust 4 vs pglite 5: counts differ' });
    const old = judgeSuite(suite('cat19'), runs(k => receipt(k, { n_total: 5, n_scored: 5, data: { achieved: { brain_score: 85 } } })), { counted: false });
    expect(old).toMatchObject({ verdict: 'NOT_RUN', reason: 'the pglite receipt has no gates_passed' });
  });

  test('Cat 27 fails when Rust errors on a probe the TypeScript engines scored', () => {
    const agg = { mean_ndcg10_with_signals: 0.5, top1_hit_rate_with_signals: 0.25, n_probes: 4 };
    const ok = judgeSuite(suite('cat27'), runs(k => receipt(k, { n_total: 4, data: { aggregate: agg } })), { counted: false });
    expect(ok.verdict).toBe('PASS');
    const r = judgeSuite(suite('cat27'), runs(k => receipt(k, k === 'rust'
      ? { n_total: 4, errors: [{ probe_id: 'p4', origin: 'sut', message: 'engine_capability_missing' }], data: { aggregate: { ...agg, n_probes: 3, top1_hit_rate_with_signals: 1 / 3 } } }
      : { n_total: 4, data: { aggregate: agg } })), { counted: false });
    expect(r.verdict).toBe('FAIL');
    expect(r.losses.map(l => l.id)).toEqual(['cat27:probes_scored:vs-pglite', 'cat27:errors:vs-pglite', 'cat27:probes_scored:vs-postgres', 'cat27:errors:vs-postgres']);
  });

  test('Cat 7 is reported: it passes when it ran, and lists every metric Rust loses', () => {
    const perf = (p50: number) => ({ data: { latency: [{ op: 'get_stats', scale: 10000, p50_ms: p50 }], throughput: [] } });
    const r = judgeSuite(suite('cat7'), runs(k => receipt(k, perf(k === 'rust' ? 125 : 4))), { counted: false });
    expect(r.verdict).toBe('PASS');
    expect(r.losses).toHaveLength(2);
  });

  test('NOT_RUN on a refusal, a missing TypeScript receipt or engines on different builds; FAIL when only Rust errors', () => {
    const conf = { data: { summary: { cases_passed: 24, cases_total: 24 } } };
    const s = suite('memory-verb-conformance');
    expect(judgeSuite(s, runs(k => receipt(k, conf), { rust: 'REFUSED: addon mismatch' }), { counted: false })).toMatchObject({ verdict: 'NOT_RUN', reason: 'rust refused: REFUSED: addon mismatch' });
    expect(judgeSuite(s, runs(k => (k === 'postgres' ? null : receipt(k, conf))), { counted: false }).verdict).toBe('NOT_RUN');
    expect(judgeSuite(s, runs(k => receipt(k, conf, k === 'rust' ? 'other' : 'b66e4077')), { counted: false }).verdict).toBe('NOT_RUN');
    const missed = judgeSuite(s, runs(k => receipt(k, { ...conf, resolved_config: { embed_cache: { stats: { misses: k === 'rust' ? 3 : 0 } } } })), { counted: true });
    expect(missed.reason).toContain('rust missed the shared embedding cache 3 times');
    const rustError = judgeSuite(s, runs(k => (k === 'rust' ? { ...receipt(k, conf), run_status: 'error', errors: [{ message: 'boom' }] } : receipt(k, conf))), { counted: false });
    expect(rustError.verdict).toBe('FAIL');
  });

  test('Cat 13 reads the per-query paired lower bound with identical top-5 sets as ties, is reported not gating, and lists tie-order flips in a strict row', () => {
    const q = (id: string, ndcg5: number, pages: string[]) => ({ id, ndcg5, ranked_pages: pages.map((page_id, i) => ({ page_id, rank: i + 1 })) });
    const ts = Array.from({ length: 40 }, (_, i) => q(`c${i}`, 0.6, ['a', 'b', 'c', 'd', 'e']));
    const flipped = ts.map((x, i) => (i < 5 ? q(x.id, 0.55, ['b', 'a', 'c', 'd', 'e']) : x));
    const c13 = (per: any[]) => ({ n_total: per.length, data: { scorecard: [{ name: 'gbrain', ndcg5: per.reduce((s, x) => s + x.ndcg5, 0) / per.length }], per_query: { gbrain: per } } });
    const tied = judgeSuite(suite('cat13/ndcg5'), runs(k => receipt(k, c13(k === 'rust' ? flipped : ts))), { counted: false });
    expect(tied.verdict).toBe('PASS');
    expect(tied.reason).toBe('Reported, not gating, for Dec 1 (plan D24).');
    expect(tied.rows.map(r => r.id)).toEqual(['cat13/ndcg5', 'cat13/ndcg5:strict']);
    expect((tied.rows[0].secondary as any).paired_lower_bound.rust_minus_pglite).toMatchObject({ delta: 0, ties: 40, n: 40 });
    expect(tied.rows[1].verdict).toBe('FAIL');
    expect((tied.rows[1].secondary as any).tie_order_flips.pglite).toHaveLength(5);
    expect(tied.losses.map(l => l.id)).toEqual(['cat13/ndcg5:strict:ndcg5:vs-pglite', 'cat13/ndcg5:strict:ndcg5:vs-postgres']);
    const worse = ts.map(x => q(x.id, 0.4, ['x', 'b', 'c', 'd', 'e']));
    const lost = judgeSuite(suite('cat13/ndcg5'), runs(k => receipt(k, c13(k === 'rust' ? worse : ts))), { counted: false });
    expect(lost.verdict).toBe('FAIL');
    expect(lost.reason?.startsWith('Reported, not gating, for Dec 1 (plan D24). Rust minus pglite')).toBe(true);
    const notRun = judgeSuite(suite('cat13/ndcg5'), runs(k => (k === 'postgres' ? null : receipt(k, c13(ts)))), { counted: false });
    expect(notRun.rows.map(r => r.id)).toEqual(['cat13/ndcg5', 'cat13/ndcg5:strict']);
    expect(notRun.reason?.startsWith('Reported, not gating, for Dec 1 (plan D24).')).toBe(true);
  });

  test('Cat 3 gates R@5 and P@5 from the ranks and lists a higher Rust value as a divergence, never a win', () => {
    const rows = (rank: number) => [
      { alias: 'Sarah Chen', category: 'documented', found: true, rankPosition: 1 },
      { alias: 'S. Chen', category: 'undocumented', found: rank > 0, rankPosition: rank },
    ];
    const id = (rank: number) => ({ data: { results: rows(rank) } });
    const r = judgeSuite(suite('brainbench/cat3'), runs(k => receipt(k, id(k === 'rust' ? 3 : 0))), { counted: false });
    expect(r.verdict).toBe('PASS');
    expect(r.rows[0].measured.rust).toMatchObject({ r5_undocumented: 1, p5_undocumented: 0.2, top1_undocumented: 0 });
    expect(r.rows[0].divergences).toHaveLength(2);
    expect(r.rows[0].divergences![0]).toContain('S. Chen (undocumented): Rust 3 vs not found');
    const lose = judgeSuite(suite('brainbench/cat3'), runs(k => receipt(k, id(k === 'rust' ? 0 : 3))), { counted: false });
    expect(lose.losses.map(l => l.id)).toContain('brainbench/cat3:p5_undocumented:vs-postgres');
  });

  test('type-accuracy gates strict F1, type accuracy and per-type F1, and lists the differing edges', () => {
    const ta = (f1: number, edges: string[]) => ({ data: { engine_links: { overallStrictF1: f1, overallTypeAccuracy: 0.77, perType: [{ linkType: 'founded', f1_strict: f1 }], storedEdges: edges.map(to => ({ from: 'companies/acme-0', to, type: 'founded' })) } } });
    const r = judgeSuite(suite('brainbench/type-accuracy'), runs(k => receipt(k, k === 'rust' ? ta(0.2, ['people/a']) : ta(0.26, ['people/a', 'people/b']))), { counted: false });
    expect(r.verdict).toBe('FAIL');
    expect(r.losses.map(l => l.id)).toContain('brainbench/type-accuracy:f1.founded:vs-pglite');
    expect(r.rows[0].divergences![0]).toContain('edges Rust does not store (1): companies/acme-0 -[founded]-> people/b');
  });

  test('Cat 1 gates the graph-first before-after row; the multi-adapter row beside it never gates', () => {
    const ba = { n_total: 145, data: { after: { precision_at_k: 0.3366, recall_at_k: 0.9349 } } };
    const ma = (p: number) => ({ data: { scorecards: [{ family: 'relational', adapter: 'graph-oracle-parse', mean_precision_at_k: 0.4, mean_recall_at_k: 0.9 }, { family: 'relational', adapter: 'gbrain', mean_precision_at_k: p, mean_recall_at_k: 0.64 }] } });
    const s = suite('brainbench/cats-1-2');
    const r = judgeSuite(s, runs(k => receipt(k, ba)), { counted: false }, runs(k => receipt(k, ma(k === 'rust' ? 0.18 : 0.181))));
    expect(r.verdict).toBe('PASS');
    expect(r.rows.map(x => [x.id, x.verdict])).toEqual([['brainbench/cats-1-2', 'PASS'], ['brainbench/cats-1-2:beside', 'PASS']]);
    expect(r.rows[0].measured.rust).toEqual({ p5: 0.3366, r5: 0.9349, questions: 145 });
    expect(r.losses.map(l => l.id)).toEqual(['brainbench/cats-1-2:beside:product_p5_hash:vs-pglite', 'brainbench/cats-1-2:beside:product_p5_hash:vs-postgres']);
    expect(judgeSuite(s, runs(k => receipt(k, ba)), { counted: false }).rows[1].verdict).toBe('NOT_RUN');
  });

  test('Cat 12 needs the same MCP operation count on every engine', () => {
    const mcp = (ops: number) => ({ data: { behavioral: { passed: 24, total: 24 }, handler_walk: { total: ops, missing: [] } } });
    expect(judgeSuite(suite('cat12'), runs(k => receipt(k, mcp(205))), { counted: false }).verdict).toBe('PASS');
    const r = judgeSuite(suite('cat12'), runs(k => receipt(k, mcp(k === 'rust' ? 204 : 205))), { counted: false });
    expect(r.verdict).toBe('FAIL');
    expect(r.losses[0].id).toBe('cat12:operations:vs-pglite');
  });

  test('a FAIL names the gbrain call sites of the calls Rust refused', () => {
    const conf = (passed: number) => ({ data: { summary: { cases_passed: passed, cases_total: 24 } } });
    const refusal_sites = [{ member: 'executeRaw', capability: 'raw_sql', site: 'core/eligibility/stamp.ts:195', caller: 'core/ops/facts.ts:555', count: 2 }];
    const r = judgeSuite(suite('memory-verb-conformance'), runs(k => (k === 'rust' ? receipt(k, { ...conf(18), verdict: 'fail' }) : receipt(k, conf(24))), {}, refusal_sites), { counted: false });
    expect(r.losses.at(-1)).toEqual({ id: 'memory-verb-conformance:refusal-sites', reason: 'The Rust run refused 2 engine calls at: core/eligibility/stamp.ts:195 (executeRaw, raw_sql, from core/ops/facts.ts:555) x2' });
    expect(r.reason).toContain('core/eligibility/stamp.ts:195');
  });
});

describe('gate-suite runs', () => {
  test('paid Cat 13 arguments parse, and only the engine that fills the cache may call the provider', () => {
    const budget = ['--budget-run-id', 'r1', '--budget-usd', '5'];
    const fill = parseCat13Argv(suite('cat13/ndcg5').args({ paid: true, cacheFile: '/tmp/c13.sqlite', fillsCache: true, budget }), {});
    expect(fill).toMatchObject({ embedCache: '/tmp/c13.sqlite' });
    expect(fill.embedCacheOnly).toBeUndefined();
    expect(fill.budget?.runId).toBe('r1');
    expect(parseCat13Argv(suite('cat13/ndcg5').args({ paid: true, cacheFile: '/tmp/c13.sqlite', fillsCache: false, budget }), {}).embedCacheOnly).toBe(true);
    expect(() => parseCat13Argv(['--embed-cache-only'], {})).toThrow('--embed-cache-only needs --embed-cache');
  });

  test('a receipt naming another engine than its directory is NOT_RUN', () => {
    const conf = { data: { summary: { cases_passed: 24, cases_total: 24 } } };
    const r = judgeSuite(suite('memory-verb-conformance'), runs(k => receipt(k === 'postgres' ? 'pglite' : k, conf)), { counted: false });
    expect(r).toMatchObject({ verdict: 'NOT_RUN', reason: "the receipt in postgres's directory names engine pglite" });
  });

  test('a Rust runner that exits without a receipt where both TypeScript engines completed is FAIL with its refused call sites', () => {
    const conf = { data: { summary: { cases_passed: 24, cases_total: 24 } } };
    const sites = [{ member: 'executeRaw', capability: 'raw_sql', site: 'core/x.ts:1', caller: null, count: 1 }];
    const failed = runs(k => (k === 'rust' ? null : receipt(k, conf)), {}, sites);
    Object.assign(failed.rust, { hasLog: true, exit: { code: 1, signal: null, gbrain: '/w/gbrain@b66e4077' } });
    const r = judgeSuite(suite('cat13/ndcg5'), failed, { counted: false });
    expect(r.verdict).toBe('FAIL');
    expect(r.losses[0].reason).toContain('its runner failed (exit 1)');
    expect(r.rows.map(x => [x.id, x.verdict])).toEqual([['cat13/ndcg5', 'FAIL'], ['cat13/ndcg5:strict', 'NOT_RUN']]);
    expect(r.losses.map(l => l.id)).toEqual(['cat13/ndcg5', 'cat13/ndcg5:refusal-sites']);
    expect(r.reason?.startsWith('Reported, not gating, for Dec 1 (plan D24). Rust wrote no receipt')).toBe(true);
  });

  test('a Rust cell with no receipt is NOT_RUN unless it failed with a numeric exit code, a run.log and the TypeScript engines\' build', () => {
    const conf = { data: { summary: { cases_passed: 24, cases_total: 24 } } };
    const s = suite('memory-verb-conformance');
    const judge = (rust: Record<string, unknown>, commit = (k: EvalEngineKind) => 'b66e4077') => {
      const r = runs(k => (k === 'rust' ? null : receipt(k, conf, commit(k))));
      Object.assign(r.rust, rust);
      return judgeSuite(s, r, { counted: false });
    };
    const exit = (code: number | null, signal: string | null = null, gbrain = '/w/gbrain@b66e4077') => ({ code, signal, gbrain });
    expect(judge({ hasLog: true, exit: exit(1) }).verdict).toBe('FAIL');
    expect(judge({ hasLog: false, exit: null })).toMatchObject({ verdict: 'NOT_RUN', reason: 'Rust wrote no receipt and has no failed run on record (no exit record, no run.log)' });
    expect(judge({ hasLog: true, exit: exit(null, 'SIGKILL') })).toMatchObject({ verdict: 'NOT_RUN', reason: 'Rust wrote no receipt and has no failed run on record (exit none by SIGKILL)' });
    expect(judge({ hasLog: true, exit: exit(0) }).verdict).toBe('NOT_RUN');
    expect(judge({ hasLog: false, exit: exit(1) }).verdict).toBe('NOT_RUN');
    expect(judge({ hasLog: true, exit: exit(1, null, '/w/gbrain@c0ffee12') }).reason).toBe("Rust's run named gbrain /w/gbrain@c0ffee12, not the TypeScript engines' build b66e4077");
    expect(judge({ hasLog: true, exit: exit(1) }, k => (k === 'postgres' ? 'other' : 'b66e4077')).reason).toBe('the TypeScript engines ran different or unnamed gbrain builds (b66e4077, other)');
  });

  test('a Rust cell killed by an engine crash signal is FAIL; a harness kill stays NOT_RUN', () => {
    const conf = { data: { summary: { cases_passed: 24, cases_total: 24 } } };
    const judge = (signal: string) => {
      const r = runs(k => (k === 'rust' ? null : receipt(k, conf)));
      Object.assign(r.rust, { hasLog: true, exit: { code: null, signal, gbrain: '/w/gbrain@b66e4077' } });
      return judgeSuite(suite('memory-verb-conformance'), r, { counted: false });
    };
    for (const sig of ['SIGSEGV', 'SIGABRT', 'SIGBUS']) expect(judge(sig).losses[0].reason).toContain(`its runner failed (exit none by ${sig})`);
    for (const sig of ['SIGKILL', 'SIGTERM']) expect(judge(sig).verdict).toBe('NOT_RUN');
  });

  test('an unreadable or old-format exit.json reads as no exit record instead of stopping emit', () => {
    const reports = mkdtempSync(join(tmpdir(), 'gate-exit-'));
    try {
      const dir = engineDir('cat10', 'rust', reports);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'exit.json'), '{"code": 1, "sig');
      expect(loadRun('cat10', 'rust', reports).exit).toBeNull();
      writeFileSync(join(dir, 'exit.json'), '{"code": 1, "signal": null}');
      expect(loadRun('cat10', 'rust', reports).exit).toBeNull();
      writeFileSync(join(dir, 'exit.json'), '{"code": 1, "signal": null, "gbrain": "/w/gbrain@b66e4077"}');
      expect(loadRun('cat10', 'rust', reports).exit).toEqual({ code: 1, signal: null, gbrain: '/w/gbrain@b66e4077' });
    } finally { rmSync(reports, { recursive: true, force: true }); }
  });

  test('Cat 27 is NOT_RUN when the TypeScript engines scored no probe, and counts only system-under-test errors', () => {
    const empty = { mean_ndcg10_with_signals: 0, top1_hit_rate_with_signals: 0, n_probes: 0 };
    const allErr = { n_total: 4, verdict: 'fail', errors: [1, 2, 3, 4].map(i => ({ probe_id: `p${i}`, origin: 'sut', message: 'boom' })), data: { aggregate: empty } };
    expect(judgeSuite(suite('cat27'), runs(k => receipt(k, allErr)), { counted: false })).toMatchObject({ verdict: 'NOT_RUN', reason: 'the pglite receipt has no probes_scored' });
    const agg = { mean_ndcg10_with_signals: 0.5, top1_hit_rate_with_signals: 0.25, n_probes: 4 };
    const harness = judgeSuite(suite('cat27'), runs(k => receipt(k, { n_total: 4, errors: k === 'pglite' ? [{ probe_id: 'teardown', origin: 'harness', message: 'scratch close' }] : [], data: { aggregate: agg } })), { counted: false });
    expect(harness.verdict).toBe('PASS');
    const rustNone = judgeSuite(suite('cat27'), runs(k => receipt(k, k === 'rust' ? allErr : { n_total: 4, data: { aggregate: agg } })), { counted: false });
    expect(rustNone.verdict).toBe('FAIL');
    expect(rustNone.losses[0]).toMatchObject({ id: 'cat27:probes_scored' });
  });

  test('a Rust receipt missing a measured value is FAIL, not NOT_RUN', () => {
    const c19 = (achieved: unknown) => ({ n_total: 5, n_scored: 5, data: { achieved, gates: { g1: 1, g2: 1, g3: 1, g4: 1, g5: 1 } } });
    const r = judgeSuite(suite('cat19'), runs(k => receipt(k, k === 'rust' ? { ...c19(null), verdict: 'fail' } : c19({ brain_score: 85 }))), { counted: false });
    expect(r.verdict).toBe('FAIL');
    expect(r.losses[0]).toEqual({ id: 'cat19:brain_score', reason: 'the Rust receipt has no brain_score (verdict fail)' });
  });

  test('Cat 13 runs on the same ids with other query text or another gold store are NOT_RUN', () => {
    const q = (id: string, text: string) => ({ id, text, ndcg5: 0.6, ranked_pages: ['a', 'b', 'c', 'd', 'e'].map((page_id, i) => ({ page_id, rank: i + 1 })) });
    const all = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const c13 = (text: (id: string) => string, gold = 'g1') => ({ n_total: 40, resolved_config: { probes_generated: 40, evaluator: { gold_store: { fingerprint: gold } } }, data: { scorecard: [{ name: 'gbrain', ndcg5: 0.6 }], per_query: { gbrain: all.map(id => q(id, text(id))) } } });
    expect(judgeSuite(suite('cat13/ndcg5'), runs(k => receipt(k, c13(id => `query ${id}`))), { counted: false }).verdict).toBe('PASS');
    expect(judgeSuite(suite('cat13/ndcg5'), runs(k => receipt(k, c13(id => (k === 'rust' ? `other ${id}` : `query ${id}`)))), { counted: false }).verdict).toBe('NOT_RUN');
    expect(judgeSuite(suite('cat13/ndcg5'), runs(k => receipt(k, c13(id => `query ${id}`, k === 'rust' ? 'g2' : 'g1'))), { counted: false }).verdict).toBe('NOT_RUN');
  });

  test('receipts that embedded differently, or Cat 13 runs on different or partial query sets, are NOT_RUN', () => {
    const top1 = (transport: string) => ({ resolved_config: { embedding_transport: transport }, data: { scorecard: [{ name: 'gbrain', top1_hit_rate: 0.93 }] } });
    const mixed = judgeSuite(suite('cat13b/top1'), runs(k => receipt(k, top1(k === 'rust' ? 'live openai:text-embedding-3-large' : 'stubbed deterministic hash-embed'))), { counted: true });
    expect(mixed.verdict).toBe('NOT_RUN');
    expect(mixed.reason).toStartWith('the engines embedded differently (pglite ');
    const q = (id: string) => ({ id, ndcg5: 0.6, ranked_pages: ['a', 'b', 'c', 'd', 'e'].map((page_id, i) => ({ page_id, rank: i + 1 })) });
    const c13 = (ids: string[], n = ids.length) => ({ n_total: n, resolved_config: { probes_generated: 40 }, data: { scorecard: [{ name: 'gbrain', ndcg5: 0.6 }], per_query: { gbrain: ids.map(q) } } });
    const all = Array.from({ length: 40 }, (_, i) => `c${i}`);
    expect(judgeSuite(suite('cat13/ndcg5'), runs(k => receipt(k, c13(all))), { counted: false }).verdict).toBe('PASS');
    const other = judgeSuite(suite('cat13/ndcg5'), runs(k => receipt(k, c13(k === 'rust' ? [...all.slice(1), 'c99'] : all))), { counted: false });
    expect(other).toMatchObject({ verdict: 'NOT_RUN', reason: 'Reported, not gating, for Dec 1 (plan D24). the engines scored different or partial ndcg5 query sets (pglite 40 of 40, postgres 40 of 40, rust 40 of 40)' });
    const partial = judgeSuite(suite('cat13/ndcg5'), runs(k => receipt(k, c13(all.slice(0, 30)))), { counted: false });
    expect(partial.verdict).toBe('NOT_RUN');
  });

  test('run refuses a gbrain build named by a tag, a branch or no ref, so a failed Rust cell can be matched to its build', () => {
    for (const spec of ['/nowhere', '/nowhere@v0.61.0', '/nowhere@master']) {
      const p = Bun.spawnSync([process.execPath, 'eval/runner/engine-bench/gate-suites.ts', 'run', '--gbrain', spec, '--engines', 'pglite', '--suites', 'cat10'], { env: { PATH: process.env.PATH ?? '' } });
      expect(p.exitCode).toBe(1);
      expect(p.stderr.toString()).toContain('run needs --gbrain <checkout>@<sha> with a 7 to 40 character commit sha');
    }
  });

  test('a paid run refuses an engine order where PGLite does not fill the embedding cache first', () => {
    const p = Bun.spawnSync([process.execPath, 'eval/runner/engine-bench/gate-suites.ts', 'run', '--gbrain', '/nowhere@b66e4077', '--paid', '--budget-run-id', 'r1', '--budget-usd', '1',
      '--embed-cache-dir', join(tmpdir(), 'gate-suites-order'), '--engines', 'postgres,pglite', '--suites', 'cat13b/top1'], { env: { PATH: process.env.PATH ?? '' } });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain('--paid needs pglite first in --engines');
  });
});

describe('Rust refusal sites', () => {
  test('gbrainFrames keeps gbrain src frames outside the Rust engine, innermost first', () => {
    const stack = ['Error', '    at x (/repo/eval/runner/eval-engine.ts:10:3)', '    at y (/g/src/core/rust-engine/engine.ts:5:1)', '    at stamp (/g/src/core/eligibility/stamp.ts:195:9)', '    at /g/src/core/ops/facts.ts:555:20'].join('\n');
    expect(gbrainFrames(stack, '/g')).toEqual(['core/eligibility/stamp.ts:195', 'core/ops/facts.ts:555']);
  });

  test('refusalSiteOf names where gbrain threw a capability refusal, and nothing for other errors', () => {
    const stack = 'Error\n    at opError (/g/src/core/ops/contract.ts:204:17)\n    at sqlEngineKind (/g/src/core/sql-engine-kind.ts:24:9)\n    at preflight (/g/src/commands/embed.ts:445:3)';
    expect(refusalSiteOf(Object.assign(new Error('x'), { code: 'engine_capability_missing', stack }), '/g')).toBe(' (at core/sql-engine-kind.ts:24, from commands/embed.ts:445)');
    expect(refusalSiteOf(Object.assign(new Error('x'), { stack }), '/g')).toBe('');
  });

  test('a refused unimplemented member records its call site; the error and implemented members pass through unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rust-refusals-'));
    try {
      mkdirSync(join(root, 'src/core/rust-engine'), { recursive: true });
      writeFileSync(join(root, 'src/core/rust-engine/members.ts'), "export const RUST_ENGINE_MEMBERS = { getPage: 'implemented', executeRaw: 'raw_sql' };\n");
      writeFileSync(join(root, 'src/core/caller.ts'), 'export async function call(e: any) {\n  return await e.executeRaw("select 1");\n}\n');
      const refusal = Object.assign(new Error('refused'), { code: 'engine_capability_missing' });
      const getPage = async () => 'page';
      const engine: any = { getPage, executeRaw: async () => { throw refusal; } };
      await recordRustRefusals({ root, version: 'test', overlay: null } as any, engine);
      expect(engine.getPage).toBe(getPage);
      const { call } = await import(join(root, 'src/core/caller.ts'));
      await expect(call(engine)).rejects.toBe(refusal);
      expect(rustRefusalSites()).toContainEqual({ member: 'executeRaw', capability: 'raw_sql', site: 'core/caller.ts:2', caller: null, count: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
