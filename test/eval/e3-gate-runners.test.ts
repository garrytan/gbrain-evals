/**
 * Gate E3 runners (gbrain RUST_ENGINE.md, "Eval gates"): Cats 22, 19, 27 and 23 take GBRAIN_EVAL_ENGINE through
 * gateRunnerContext. With no engine requested a receipt carries no engine fields and lands where it always did; with
 * one requested it names the engine and lands in a per-engine directory. Hermetic: in-memory PGLite only, no keys.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateRunnerContext } from '../../eval/runner/eval-engine.ts';
import { runCat23, CAT23_CATEGORY } from '../../eval/runner/cat23-phantom-redirect.ts';
import { runCat22, CAT22_CATEGORY } from '../../eval/runner/cat22-source-isolation.ts';

const RUN_TIMEOUT = 300_000;

describe('E3 gate runners: engine switch', () => {
  test('Cat 23 with no engine requested keeps the default receipt path and adds no engine fields', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'e3-default-'));
    const r = await runCat23({ reportsDir, quiet: true });
    expect(r.receiptFile).toBe(join(reportsDir, CAT23_CATEGORY, 'receipt.json'));
    const receipt = JSON.parse(readFileSync(r.receiptFile, 'utf8'));
    expect(receipt.engine).toBeUndefined();
    expect(receipt.gbrain_under_test).toBeUndefined();
    expect(receipt.verdict).toBe('pass');
  }, RUN_TIMEOUT);

  test('Cat 23 with GBRAIN_EVAL_ENGINE=pglite names the engine and writes a per-engine receipt', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'e3-pglite-'));
    const ctx = gateRunnerContext([], { GBRAIN_EVAL_ENGINE: 'pglite' });
    const r = await runCat23({ ctx, reportsDir, quiet: true });
    expect(r.receiptFile).toBe(join(reportsDir, CAT23_CATEGORY, 'engine-pglite', 'receipt.json'));
    const receipt = JSON.parse(readFileSync(r.receiptFile, 'utf8'));
    expect(receipt.engine).toBe('pglite');
    expect(receipt.not_applicable).toEqual([]);
    expect(receipt.data.per_phantom.filter((c: { pass: boolean }) => c.pass)).toHaveLength(9);
  }, RUN_TIMEOUT);

  test('Cat 22 seeds sources and cross-source links through typed members: zero leaks, every control detects', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'e3-cat22-'));
    const ctx = gateRunnerContext([], { GBRAIN_EVAL_ENGINE: 'pglite' });
    const r = await runCat22({ ctx, reportsDir, quiet: true });
    expect(r.receiptFile).toBe(join(reportsDir, CAT22_CATEGORY, 'engine-pglite', 'receipt.json'));
    expect(r.probes.reduce((n, p) => n + p.leaked_results + p.missing_source_id, 0)).toBe(0);
    expect(r.controls.every(c => c.detected_leak)).toBe(true);
    expect(r.receipt.verdict).toBe('pass');
  }, RUN_TIMEOUT);
});
