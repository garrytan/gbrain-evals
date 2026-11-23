import { describe, expect, test } from 'bun:test';
import { GATE_SUITE_SCHEMA, GATE_SUITES, amendmentLine, judgeSuite, type GateSuite } from '../../eval/runner/engine-bench/gate-suites.ts';
import type { EvalEngineKind } from '../../eval/runner/eval-engine.ts';

const ROW_IDS = ['cat13/ndcg5', 'cat13b/top1', 'cat10', 'cat12', 'cat7', 'brainbench/cats-1-2', 'brainbench/cat3', 'brainbench/cat4',
  'brainbench/type-accuracy', 'brainbench/cat24', 'memory-verb-conformance', 'cat22', 'cat19', 'cat27', 'cat23'];
const suite = (id: string): GateSuite => GATE_SUITES.find(s => s.id === id)!;
const build = (commit = 'b66e4077', addon: string | null = 'ab'.repeat(32)) => ({
  version: '0.60.762.0', overlay: { commit, ref: commit, checkout_dirty: false }, rust_addon: addon ? { sha256: addon, target: 'linux-x64-glibc' } : null,
});
function receipt(kind: EvalEngineKind, extra: Record<string, unknown>, commit?: string) {
  return { run_status: 'completed', verdict: 'pass', n_total: 24, n_scored: 24, errors: [], engine: kind, gbrain_under_test: build(commit, kind === 'rust' ? 'ab'.repeat(32) : null), ...extra };
}
const runs = (make: (k: EvalEngineKind) => Record<string, unknown> | null, refused: Partial<Record<EvalEngineKind, string>> = {}) =>
  Object.fromEntries((['pglite', 'postgres', 'rust'] as const).map(k => [k, { kind: k, receipt: make(k), refused: refused[k] ?? null }])) as any;

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
    const c19 = (score: number, errors: unknown[] = []) => ({ n_total: 5, n_scored: 5, errors, data: { achieved: { brain_score: score } } });
    expect(judgeSuite(suite('cat19'), runs(k => receipt(k, c19(k === 'rust' ? 85.4 : 85))), { counted: false }).verdict).toBe('PASS');
    expect(judgeSuite(suite('cat19'), runs(k => receipt(k, k === 'rust' ? c19(50, [{ probe_id: 'embed' }]) : c19(85))), { counted: false }).verdict).toBe('FAIL');
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
});
